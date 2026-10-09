/**
 * Measures the embedding models on labeled Romanian and English facts (embeddings-eval.json) through the
 * code the app embeds with, and prints the values of their profiles (packages/core/src/models/
 * embedding-profiles.ts) next to the ones in use. Run it after changing a model or its prompts:
 *
 *   pnpm --filter @abotica/worker eval:embeddings [local] [ollama]
 *
 * Without arguments: the built-in model, and Ollama when it has the model. Measured the same way when they
 * were offered: OpenAI's text-embedding-3-small (top 1 0.85, Romanian questions to English facts 0.38) and
 * text-embedding-3-large (0.91 and 0.50), nomic-embed-text (0.48 and 0.13).
 */
import { readFileSync } from "node:fs";
import {
  EMBEDDING_PROFILES,
  EMBEDDING_PROVIDERS,
  type EmbeddingProfile,
  type EmbeddingProvider,
  embeddingReadiness,
  embedWith,
  registerLocalEmbedder,
} from "@abotica/core";
import { embedInProcess, loadEmbeddingModel } from "../src/jobs/embeddings";

type Dataset = {
  docs: Record<string, string>;
  queries: [direction: string, query: string, answer: string][];
  pairs: [label: "paraphrase" | "crosslingual" | "update" | "sametopic" | "unrelated", doc: string, text: string][];
};

const data = JSON.parse(readFileSync(new URL("./embeddings-eval.json", import.meta.url), "utf8")) as Dataset;

const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round(p * (sorted.length - 1))]!;
};
const share = (values: boolean[]) => values.filter(Boolean).length / values.length;
const fixed = (n: number) => n.toFixed(2);

async function evaluate(provider: EmbeddingProvider, profile: EmbeddingProfile) {
  const ids = Object.keys(data.docs);
  const started = Date.now();
  const docs = await embedWith(
    provider,
    ids.map((id) => data.docs[id]!),
    "document",
  );
  const msPerText = (Date.now() - started) / ids.length;
  const byId = new Map(ids.map((id, i) => [id, docs[i]!]));
  const queries = await embedWith(
    provider,
    data.queries.map(([, query]) => query),
    "query",
  );

  // Retrieval: where the answer ranks among all the docs, by direction (query language - doc language).
  const ranks = new Map<string, number[]>();
  const relevant: number[] = [];
  const irrelevant: number[] = [];
  data.queries.forEach(([direction, , answer], i) => {
    const order = ids
      .map((id) => ({ id, similarity: dot(queries[i]!, byId.get(id)!) }))
      .sort((a, b) => b.similarity - a.similarity);
    for (const { id, similarity } of order) (id === answer ? relevant : irrelevant).push(similarity);
    const rank = order.findIndex((o) => o.id === answer) + 1;
    for (const key of [direction, "all"]) ranks.set(key, [...(ranks.get(key) ?? []), rank]);
  });

  // The write gate: how far each new fact is from its doc, and the distances between distinct facts.
  const pairs = await embedWith(
    provider,
    data.pairs.map(([, , text]) => text),
    "document",
  );
  const measured = data.pairs.map(([label, id], i) => ({ label, distance: 1 - dot(pairs[i]!, byId.get(id)!) }));
  const distinct: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) distinct.push(1 - dot(docs[i]!, docs[j]!));
  }
  const distances = (label: string) => measured.filter((m) => m.label === label).map((m) => m.distance);
  const listed = (label: string, t: number) => share(distances(label).map((d) => d < t));

  const all = ranks.get("all")!;
  console.log(`\n${provider}: ${profile.model} (${msPerText.toFixed(1)} ms per text)`);
  console.log(
    `  retrieval: top 1 ${fixed(share(all.map((r) => r === 1)))}, top 3 ${fixed(share(all.map((r) => r <= 3)))}, MRR ${fixed(all.reduce((s, r) => s + 1 / r, 0) / all.length)}`,
  );
  console.log(
    `  top 1 by direction: ${[...ranks]
      .filter(([k]) => k !== "all")
      .map(([k, r]) => `${k} ${fixed(share(r.map((x) => x === 1)))}`)
      .join(", ")}`,
  );
  // Related must reach every update and stay under almost every distance between distinct facts.
  const relatedFrom = Math.max(...distances("update"));
  const relatedTo = percentile(distinct, 0.02);
  console.log(
    `  relatedDistance      in use ${fixed(profile.relatedDistance)}  measured ${fixed(relatedFrom)} to ${fixed(relatedTo)}`,
  );
  console.log(
    `  unrelatedSimilarity  in use ${fixed(profile.unrelatedSimilarity)}  measured ${fixed(percentile(irrelevant, 0.5))} (median, query to a doc that does not answer it)`,
  );
  console.log(
    `  recallSimilarity     in use ${fixed(profile.recallSimilarity)}  measured ${fixed(percentile(relevant, 0.05))} (95% of answers above it)`,
  );
  console.log(
    `  with the values in use: updates listed ${fixed(listed("update", profile.relatedDistance))}, other facts on the subject ${fixed(listed("sametopic", profile.relatedDistance))}, unrelated ${fixed(listed("unrelated", profile.relatedDistance))}; answers recalled ${fixed(share(relevant.map((s) => s >= profile.recallSimilarity)))}, non-answers ${fixed(share(irrelevant.map((s) => s >= profile.recallSimilarity)))}`,
  );
  // Why no distance marks a duplicate: some updates sit closer to their entry than paraphrases do.
  const closestUpdate = Math.min(...distances("update"));
  console.log(
    `  closest update ${fixed(closestUpdate)}, paraphrases farther than it ${fixed(share(distances("paraphrase").map((d) => d > closestUpdate)))}`,
  );
}

registerLocalEmbedder(embedInProcess);
const asked = process.argv.slice(2) as EmbeddingProvider[];
const providers = asked.length ? asked : EMBEDDING_PROVIDERS;
for (const provider of providers) {
  const profile = EMBEDDING_PROFILES[provider];
  if (!profile) throw new Error(`Unknown provider ${provider}`);
  // The built-in model is downloaded on its first load; the others must be reachable.
  if (provider === "local") await loadEmbeddingModel();
  else if ((await embeddingReadiness(provider)) !== "ready") {
    console.log(`\n${provider}: ${profile.model} not available, skipped`);
    continue;
  }
  await evaluate(provider, profile);
}
process.exit(0);
