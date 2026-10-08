/**
 * Pure ranking rules of memory and journal search (memory-search.ts runs the queries): fusion of the
 * vector and keyword scores, recency decay and MMR diversity. No server imports, so they are testable
 * on their own.
 */

/** Share of the vector and the keyword score in the fused score (OpenClaw's defaults). */
export const VECTOR_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;

/** Each branch fetches this many times the results asked for, so fusion and MMR have room to reorder. */
export const CANDIDATE_MULTIPLIER = 4;

/** Age in days at which recency halves a score. */
export const DECAY_HALF_LIFE_DAYS = 30;

/** MMR trade-off between relevance (1) and diversity (0). */
export const MMR_LAMBDA = 0.7;

/** Words a query is matched by, at most; a long message stays a cheap query. */
export const MAX_QUERY_WORDS = 32;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * English and Romanian function words, written without diacritics (words are compared folded, so "și",
 * "şi" and "si" are all "si"). The `simple` text config keeps every word, so without this list an OR query
 * built from a whole message ("what is the status of the deploy") matches nearly every entry on "the" or
 * "is". Short on purpose: articles, pronouns, prepositions, conjunctions, auxiliaries and a few
 * conversational fillers, nothing that could carry a topic. Left out on purpose: "ai", a Romanian function
 * word that here is far more often AI, and "cat" ("cât" folded), an English noun.
 */
const STOPWORDS = new Set(
  [
    // English
    "a about above after again against all also am an and any are as at be because been before being below",
    "between both but by can could did do does doing down during each few for from further get got had has have",
    "having he her here hers herself him himself his how i if in into is it its itself just let may me might more",
    "most must my myself no nor not now of off on once only or other our ours ourselves out over own same shall",
    "she should so some such than that the their theirs them themselves then there these they this those through",
    "to too under until up us very was we were what when where which while who whom why will with would you your",
    "yours yourself yourselves",
    "i'm i've i'll i'd you're you've you'll you'd he's she's it's we're we've we'll they're they've they'll",
    "that's there's what's let's don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't couldn't",
    "shouldn't haven't hasn't hadn't",
    "ok okay yes yeah please thanks thank hi hello hey",
    // Romanian
    "al ale alt alta alte altul am ar are as asa asta acest aceasta acesta aceste acestea acei acel acela acea",
    "asupra atat atata atunci au avea avem aveti ba ca care cata cate catre ce cea cei cel cele celor ceva",
    "chiar ci cand cine cineva cu cum da daca dar de deci deja despre din dintr dintre doar dupa ea ei el ele era eram",
    "este esti eu fara fi fie fiecare fost foarte iar ii il imi in inca intr intre isi iti la le li lor lui ma mai",
    "mea mei mele meu mi mie mult multe ne nici noi nostru noastra nu ori pe pentru peste pana poate prin sa",
    "sau se si sint sunt suntem sunteti spre sub ta tau te ti tine toate tot toti tu un una unde unei unele unii",
    "unor unui va voi vom vor vreau vrei vrea",
    "mersi multumesc salut buna rog",
  ].flatMap((line) => line.split(" ")),
);

/** Lowercase, without diacritics and with straight apostrophes: how a word is looked up in STOPWORDS. */
const folded = (word: string) =>
  word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replaceAll("\u2019", "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** A part of a word too small to carry meaning: a single letter ("s" in "s-a", "o" in "într-o"). */
const isLetter = (part: string) => /^\p{L}$/u.test(part);

/**
 * Whether a (lowercase) query word carries no topic: a stopword, a single letter, or a hyphenated word
 * made only of those (Romanian "s-a", "într-o"; "e-mail" stays).
 */
export function isStopword(word: string): boolean {
  const bare = folded(word);
  if (!bare || STOPWORDS.has(bare) || isLetter(bare)) return true;
  const parts = bare.split("-");
  return parts.length > 1 && parts.every((part) => !part || STOPWORDS.has(part) || isLetter(part));
}

/**
 * A Postgres tsquery that matches any of the query's topic words, for `to_tsquery('simple', ...)`. Each
 * word is quoted, so `&|!():*` are plain text, and Postgres splits it as it splits the indexed text: `ERR_42`
 * becomes the phrase `err <-> 42`. Stopwords are dropped (see STOPWORDS), and so are words without a letter
 * or digit, which give no lexeme (Postgres would log a notice for each). Null when nothing is left to match.
 */
export function orTsQuery(text: string): string | null {
  const words = [...new Set(text.normalize("NFC").toLowerCase().split(/\s+/u))]
    .filter((word) => /[\p{L}\p{N}]/u.test(word) && !isStopword(word))
    .slice(0, MAX_QUERY_WORDS);
  if (!words.length) return null;
  return words.map((word) => `'${word.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`).join(" | ");
}

/** `ts_rank_cd` (0 to unbounded) mapped to 0..1: one matched word gives 0.5, more approach 1. */
export function keywordScore(rank: number): number {
  return rank > 0 ? rank / (1 + rank) : 0;
}

/** `vector` is null when the query has no embedding: the keyword score is then the whole score. */
export function fuseScores(scores: { vector: number | null; keyword: number }): number {
  if (scores.vector === null) return scores.keyword;
  return VECTOR_WEIGHT * scores.vector + KEYWORD_WEIGHT * scores.keyword;
}

/** Exponential recency decay: the score halves every `halfLifeDays`. */
export function decay(score: number, ageDays: number, halfLifeDays = DECAY_HALF_LIFE_DAYS): number {
  return score * Math.exp(-(Math.LN2 / halfLifeDays) * Math.max(0, ageDays));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

/** Share of words two texts have in common (Jaccard), for entries without an embedding. */
export function textSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/**
 * Maximal marginal relevance (Carbonell and Goldstein, 1998): picks, one at a time, the item with the best
 * `lambda * relevance - (1 - lambda) * similarity to the items already picked`, so near duplicates of a
 * picked item drop below distinct ones. Relevance is the score scaled to 0..1 over the items. Returns the
 * first `limit` picks.
 */
export function mmr<T extends { score: number }>(
  items: readonly T[],
  opts: { similarity: (a: T, b: T) => number; limit?: number; lambda?: number },
): T[] {
  const lambda = opts.lambda ?? MMR_LAMBDA;
  const limit = Math.min(opts.limit ?? items.length, items.length);
  const scores = items.map((item) => item.score);
  const min = Math.min(...scores);
  const range = Math.max(...scores) - min;
  const remaining = items.map((item) => ({ item, relevance: range ? (item.score - min) / range : 1, overlap: 0 }));
  const picked: T[] = [];
  while (picked.length < limit) {
    let best = 0;
    let bestValue = -Infinity;
    remaining.forEach((candidate, i) => {
      const value = lambda * candidate.relevance - (1 - lambda) * candidate.overlap;
      if (value > bestValue || (value === bestValue && candidate.item.score > remaining[best]!.item.score)) {
        best = i;
        bestValue = value;
      }
    });
    const [next] = remaining.splice(best, 1);
    picked.push(next!.item);
    // Each candidate keeps its highest similarity to any picked item.
    for (const candidate of remaining) {
      candidate.overlap = Math.max(candidate.overlap, opts.similarity(candidate.item, next!.item));
    }
  }
  return picked;
}

/** One search candidate, as both branches found it. */
export type Candidate = {
  /** The text compared when one of two entries has no embedding. */
  text: string;
  /** Cosine similarity to the query; null when the query or the entry has no embedding. */
  similarity: number | null;
  /** `ts_rank_cd` of the keyword match, 0 when none of the query's words occur. */
  textRank: number;
  embedding: number[] | null;
  /** Last change (memories) or day (journals): recency decays the score from there. */
  at: Date;
  /** Exempt from decay: pinned and permanent entries. */
  evergreen: boolean;
};

const candidateSimilarity = (a: Candidate, b: Candidate) =>
  a.embedding && b.embedding ? cosineSimilarity(a.embedding, b.embedding) : textSimilarity(a.text, b.text);

/**
 * Fuses each candidate's scores (keyword only when the query has no embedding), decays them by age unless
 * the entry is evergreen, and returns the best `limit` after MMR, best first.
 */
export function rankCandidates<T extends Candidate>(
  candidates: readonly T[],
  opts: { hybrid: boolean; limit: number; now: Date },
): (T & { score: number })[] {
  const scored = candidates.map((candidate) => {
    const fused = fuseScores({
      vector: opts.hybrid ? Math.max(0, candidate.similarity ?? 0) : null,
      keyword: keywordScore(candidate.textRank),
    });
    const ageDays = (opts.now.getTime() - candidate.at.getTime()) / DAY_MS;
    return { ...candidate, score: candidate.evergreen ? fused : decay(fused, ageDays) };
  });
  scored.sort((a, b) => b.score - a.score);
  return mmr(scored, { similarity: candidateSimilarity, limit: opts.limit });
}
