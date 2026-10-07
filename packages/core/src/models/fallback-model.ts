import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { APICallError } from "ai";
import type { ModelRef } from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { type CatalogModel, getCatalog } from "./catalog";
import { acceptedFilesOnly, fileModality } from "./input-modalities";
import { languageModel, ProviderNotConfiguredError } from "./providers";
import { type ReasoningEffort, resolveEffort } from "./reasoning";
import { mergeProviderOptions, ORIGIN_KEY, ownReasoningOnly, reasoningRequest } from "./reasoning-request";

type FallbackEvent = { from: ModelRef; to: ModelRef | null; error: string };

type FallbackOptions = {
  /** The effort asked for; each model in the chain gets its nearest supported level. */
  effort?: ReasoningEffort;
  onFallback?: (event: FallbackEvent) => void;
};

/**
 * A language model that walks a chain of provider/model pairs. Each call (each agent step)
 * starts at the first model and moves down the chain on rate limits, outages or missing keys,
 * so the conversation continues on another provider with the same context.
 */
export class FallbackModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  /** The model that served the most recent call; used for cost accounting. */
  lastServed: ModelRef;
  /** The effort sent to the model that served the most recent call. */
  lastEffort: ReasoningEffort;
  private readonly effort: ReasoningEffort;
  private readonly onFallback?: (event: FallbackEvent) => void;
  /** Catalog entries of the chain's models, keyed "provider/model"; loaded once, on first use. */
  private catalog?: Promise<Map<string, CatalogModel>>;

  /**
   * The effort is set here rather than through the call's `reasoning` option, which cannot carry
   * every level ("max") and would reach every model in the chain unchanged.
   */
  constructor(
    private readonly chain: ModelRef[],
    options: FallbackOptions = {},
  ) {
    if (!chain.length) throw new Error("FallbackModel needs at least one model");
    this.lastServed = chain[0]!;
    this.effort = options.effort ?? "default";
    this.lastEffort = this.effort;
    this.onFallback = options.onFallback;
  }

  get provider() {
    return this.lastServed.provider;
  }

  get modelId() {
    return this.lastServed.model;
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    return this.attempt(options, async (model, opts, ref) => {
      const result = await model.doGenerate(opts);
      return { ...result, content: result.content.map((part) => stampContent(part, ref.provider)) };
    });
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return this.attempt(options, async (model, opts, ref) => {
      const result = await peekForEarlyError(await model.doStream(opts));
      return { ...result, stream: result.stream.pipeThrough(stampReasoningStream(ref.provider)) };
    });
  }

  /** `undefined` for a model the catalog does not know. */
  private async entryOf(ref: ModelRef): Promise<CatalogModel | undefined> {
    this.catalog ??= getCatalog()
      .then((catalog) => new Map(catalog.map((m) => [`${m.provider}/${m.id}`, m])))
      .catch(() => new Map());
    return (await this.catalog).get(`${ref.provider}/${ref.model}`);
  }

  /**
   * Whether some model of the chain reads files of this media type directly, so the runner loads the
   * bytes only for files a model can take; each call still keeps them from the models that cannot.
   */
  async acceptsSomewhere(mediaType: string): Promise<boolean> {
    const modality = fileModality(mediaType);
    if (!modality) return false;
    const entries = await Promise.all(this.chain.map((ref) => this.entryOf(ref)));
    return entries.some((entry) => entry?.input?.includes(modality));
  }

  /**
   * The call as this model takes it: its effort, its provider options, only its own reasoning and only
   * the files it reads. A model the catalog does not know keeps its effort unchanged and gets no files.
   */
  private async optionsFor(
    ref: ModelRef,
    options: LanguageModelV4CallOptions,
  ): Promise<{ options: LanguageModelV4CallOptions; effort: ReasoningEffort }> {
    const entry = await this.entryOf(ref);
    const effort = resolveEffort(this.effort, entry?.reasoning);
    const request = reasoningRequest(ref.provider, ref.model, effort);
    const next: LanguageModelV4CallOptions = {
      ...options,
      prompt: acceptedFilesOnly(ownReasoningOnly(options.prompt, ref.provider), entry?.input),
      providerOptions: mergeProviderOptions(options.providerOptions, request.providerOptions),
    };
    delete next.reasoning;
    if (request.reasoning) next.reasoning = request.reasoning;
    return { options: next, effort };
  }

  private async attempt<T>(
    options: LanguageModelV4CallOptions,
    call: (model: LanguageModelV4, options: LanguageModelV4CallOptions, ref: ModelRef) => PromiseLike<T>,
  ): Promise<T> {
    const failures: string[] = [];
    for (let i = 0; i < this.chain.length; i++) {
      const ref = this.chain[i]!;
      try {
        const model = await languageModel(ref.provider, ref.model);
        const { options: opts, effort } = await this.optionsFor(ref, options);
        const result = await withRetry(() => call(model, opts, ref));
        this.lastServed = ref;
        this.lastEffort = effort;
        return result;
      } catch (error) {
        if (!shouldFallback(error)) throw error;
        failures.push(`${ref.provider}/${ref.model}: ${errorMessage(error)}`);
        this.onFallback?.({ from: ref, to: this.chain[i + 1] ?? null, error: errorMessage(error) });
      }
    }
    throw new AllProvidersFailedError(failures);
  }
}

const stampMetadata = (metadata: SharedV4ProviderMetadata | undefined, provider: string) => ({
  ...metadata,
  [ORIGIN_KEY]: { provider },
});

function stampContent(part: LanguageModelV4Content, provider: string): LanguageModelV4Content {
  return part.type === "reasoning" ? { ...part, providerMetadata: stampMetadata(part.providerMetadata, provider) } : part;
}

/**
 * Records the provider on the reasoning parts saved with the answer, so a later call replays them
 * only to that provider. A chunk's metadata replaces the part's, so the stamp goes on the start
 * and on every chunk that carries metadata; adding it to the others would wipe e.g. a signature.
 */
function stampReasoningStream(provider: string) {
  return new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
    transform(part, controller) {
      const stamp =
        part.type === "reasoning-start" ||
        ((part.type === "reasoning-delta" || part.type === "reasoning-end") && part.providerMetadata);
      controller.enqueue(stamp ? { ...part, providerMetadata: stampMetadata(part.providerMetadata, provider) } : part);
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldFallback(error: unknown): boolean {
  if (error instanceof ProviderNotConfiguredError) return true;
  if (error instanceof EarlyStreamError) return true;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;
    return error.isRetryable || status === 401 || status === 403 || status === 404 || status === 429 || status >= 500;
  }
  // Network failures (ECONNREFUSED, fetch failed) for e.g. a stopped Ollama.
  return error instanceof TypeError || (error as { code?: string })?.code === "ECONNREFUSED";
}

/** One quick retry for transient errors before giving up on a model. */
async function withRetry<T>(fn: () => PromiseLike<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const retryable = APICallError.isInstance(error) && error.isRetryable && error.statusCode !== 429;
    if (!retryable) throw error;
    await new Promise((r) => setTimeout(r, 1_500));
    return fn();
  }
}

class EarlyStreamError extends Error {}

class AllProvidersFailedError extends UserError {
  constructor(readonly failures: string[]) {
    super("errors.allProvidersFailed", { failures: failures.map((f) => `- ${f}`).join("\n") });
  }
}

/**
 * Some providers accept the request and then fail inside the stream. Read until the first
 * meaningful part: if it is an error, throw so the chain can move on; otherwise replay it.
 */
async function peekForEarlyError(result: LanguageModelV4StreamResult): Promise<LanguageModelV4StreamResult> {
  const reader = result.stream.getReader();
  const buffered: LanguageModelV4StreamPart[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "error") {
      reader.releaseLock();
      throw new EarlyStreamError(errorMessage(value.error));
    }
    buffered.push(value);
    if (value.type !== "stream-start" && value.type !== "response-metadata") break;
  }
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { ...result, stream };
}
