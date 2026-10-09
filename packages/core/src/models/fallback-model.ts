import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type { ModelRef } from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { type CatalogModel, getCatalog } from "./catalog";
import {
  acceptedFilesOnly,
  fileModality,
  isImageRejection,
  toolImageKeys,
  withoutRejectedImages,
} from "./input-modalities";
import {
  classifyProviderError,
  ContextOverflowError,
  MAX_RETRIES,
  type ProviderErrorKind,
  retryDelay,
} from "./provider-errors";
import { languageModel, ProviderNotConfiguredError } from "./providers";
import { type ReasoningEffort, resolveEffort } from "./reasoning";
import { mergeProviderOptions, ORIGIN_KEY, ownReasoningOnly, reasoningRequest } from "./reasoning-request";

type FallbackEvent = {
  from: ModelRef;
  to: ModelRef | null;
  error: string;
  kind: ProviderErrorKind;
  /** Calls of `from` after its first one, and the time waited before them. */
  retries: number;
  waitedMs: number;
};

/** A wait before calling the same model again. */
type RetryEvent = {
  model: ModelRef;
  kind: ProviderErrorKind;
  error: string;
  /** 1 for the first retry. */
  attempt: number;
  maxRetries: number;
  delayMs: number;
};

type FallbackOptions = {
  /** The effort asked for; each model in the chain gets its nearest supported level. */
  effort?: ReasoningEffort;
  onFallback?: (event: FallbackEvent) => void;
  onRetry?: (event: RetryEvent) => void;
};

type Failure = { model: ModelRef; kind: ProviderErrorKind; error: string };

/** Errors after which the next model gets the call. Any other error ends it, as it would on every model. */
const FALLBACK_KINDS = new Set<ProviderErrorKind>(["rate_limited", "usage_limit", "auth", "not_found", "transient"]);

/**
 * A language model that walks a chain of provider/model pairs. Each call (each agent step)
 * starts at the first model and moves down the chain on rate limits, outages or missing keys,
 * so the conversation continues on another provider with the same context. A short rate limit or
 * a transient error is first retried on the same model (see `withBackoff`).
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
  private readonly onRetry?: (event: RetryEvent) => void;
  /** Catalog entries of the chain's models, keyed "provider/model"; loaded once, on first use. */
  private catalog?: Promise<Map<string, CatalogModel>>;
  /**
   * Tool images a provider refused to decode (`toolImageKey`). The AI SDK sends every tool result
   * again on each step, so they stay out of every later call of this run, on every model.
   */
  private readonly rejectedImages = new Set<string>();

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
    this.onRetry = options.onRetry;
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

  /**
   * Runs the call without the tool images refused so far. A corrupt or cut-short image an agent read
   * (a broken screenshot, a half-written file) would otherwise fail every step from then on: when
   * the provider refuses an image, the call is made again once without the newest tool image, which
   * is most likely the one, then once without all of them. Other errors pass through untouched.
   */
  private async leavingOutRejectedImages<T>(
    options: LanguageModelV4CallOptions,
    run: (options: LanguageModelV4CallOptions) => PromiseLike<T>,
  ): Promise<T> {
    const without = () => ({ ...options, prompt: withoutRejectedImages(options.prompt, this.rejectedImages) });
    try {
      return await run(without());
    } catch (error) {
      if (!isImageRejection(rejectionText(error))) throw error;
      const keys = toolImageKeys(options.prompt).filter((key) => !this.rejectedImages.has(key));
      if (!keys.length) throw error;
      this.rejectedImages.add(keys.at(-1)!);
      try {
        return await run(without());
      } catch (again) {
        if (keys.length === 1 || !isImageRejection(rejectionText(again))) throw again;
        for (const key of keys) this.rejectedImages.add(key);
        return await run(without());
      }
    }
  }

  private async attempt<T>(
    options: LanguageModelV4CallOptions,
    call: (model: LanguageModelV4, options: LanguageModelV4CallOptions, ref: ModelRef) => PromiseLike<T>,
  ): Promise<T> {
    const signal = options.abortSignal;
    const failures: Failure[] = [];
    for (let i = 0; i < this.chain.length; i++) {
      const ref = this.chain[i]!;
      let retries = 0;
      let waitedMs = 0;
      try {
        const model = await languageModel(ref.provider, ref.model);
        const { options: opts, effort } = await this.optionsFor(ref, options);
        const result = await withBackoff(
          () => this.leavingOutRejectedImages(opts, (next) => call(model, next, ref)),
          signal,
          ({ kind, error, delayMs }) => {
            retries += 1;
            waitedMs += delayMs;
            this.onRetry?.({
              model: ref,
              kind,
              error: errorMessage(error),
              attempt: retries,
              maxRetries: MAX_RETRIES,
              delayMs,
            });
          },
        );
        this.lastServed = ref;
        this.lastEffort = effort;
        return result;
      } catch (error) {
        // A cancelled or timed-out run is not the model's failure: no other model gets the call.
        if (signal?.aborted) throw error;
        const kind = error instanceof ProviderNotConfiguredError ? "auth" : classifyProviderError(error);
        if (kind === "context_overflow") throw new ContextOverflowError({ cause: error });
        if (!FALLBACK_KINDS.has(kind) && !(error instanceof EarlyStreamError)) throw error;
        const message = errorMessage(error);
        failures.push({ model: ref, kind, error: message });
        this.onFallback?.({ from: ref, to: this.chain[i + 1] ?? null, error: message, kind, retries, waitedMs });
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
  if (error instanceof Error) return error.message;
  // Stream errors are often plain objects ({ message, type, code }).
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

/** An error's message with the provider's response body, where some put the reason a request was refused. */
function rejectionText(error: unknown): string {
  const body = (error as { responseBody?: unknown } | null)?.responseBody;
  return typeof body === "string" ? `${errorMessage(error)}\n${body}` : errorMessage(error);
}

/**
 * Calls a model, and calls it again after a wait while it is rate limited or fails transiently, up
 * to MAX_RETRIES times (see `retryDelay`). Any other error, or a Retry-After over the cap, goes to
 * the chain at once. The wait ends with the run's abort signal, rejecting with its reason.
 */
async function withBackoff<T>(
  fn: () => PromiseLike<T>,
  signal: AbortSignal | undefined,
  onWait: (wait: { kind: ProviderErrorKind; error: unknown; delayMs: number }) => void,
): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted) throw error;
      const kind = classifyProviderError(error);
      const delayMs = retryDelay(error, kind, retries);
      if (delayMs === undefined) throw error;
      onWait({ kind, error, delayMs });
      await sleep(delayMs, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** An error the provider sent inside the stream; the original stays as `cause`, so it can be classified. */
class EarlyStreamError extends Error {}

/** Every model of the chain failed; `failures` says how each one did. */
export class AllProvidersFailedError extends UserError {
  constructor(readonly failures: Failure[]) {
    const lines = failures.map((f) => `- ${f.model.provider}/${f.model.model}: ${f.error}`).join("\n");
    // Rate limits on every model, retries included: the run says so rather than only "failed".
    const rateLimited = failures.every((f) => f.kind === "rate_limited");
    super(rateLimited ? "errors.allProvidersRateLimited" : "errors.allProvidersFailed", { failures: lines });
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
      throw new EarlyStreamError(errorMessage(value.error), { cause: value.error });
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
