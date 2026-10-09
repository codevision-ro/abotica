import { EMBEDDING_DIMENSIONS } from "@abotica/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedLocal, registerLocalEmbedder } from "./local-embeddings";
import { embeddingAllowed } from "./provider-policy";

const vector = (x: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => x);

const job = { waitUntilFinished: vi.fn(), remove: vi.fn(async () => {}) };
const add = vi.fn(async () => job);
// The schema without the client, which needs a database.
vi.mock("@abotica/db", async () => ({ ...(await import("@abotica/db/schema")), db: {} }));
vi.mock("../infra/queues", () => ({
  embeddingsQueue: () => ({ add }),
  embeddingsQueueEvents: async () => ({}),
}));
vi.mock("../infra/redis", () => ({ redis: () => ({}) }));

beforeEach(() => vi.clearAllMocks());

// In order: outside the worker first, then with the worker's embedder registered.
describe("embedLocal", () => {
  it("outside the worker, sends the texts on the embeddings queue and drops the job when no vectors come", async () => {
    job.waitUntilFinished.mockResolvedValueOnce([vector(0.1)]);
    expect(await embedLocal(["o propoziție"])).toEqual([vector(0.1)]);
    expect(add).toHaveBeenCalledWith("embed", { texts: ["o propoziție"] }, expect.anything());

    job.waitUntilFinished.mockRejectedValueOnce(new Error("timed out"));
    await expect(embedLocal(["alta"])).rejects.toThrow("timed out");
    expect(job.remove).toHaveBeenCalled();
  });

  it("in the worker, embeds in-process and refuses vectors of another size", async () => {
    const embedder = vi.fn(async (texts: string[]) => texts.map(() => vector(0.2)));
    registerLocalEmbedder(embedder);
    expect(await embedLocal(["a", "b"])).toEqual([vector(0.2), vector(0.2)]);
    expect(add).not.toHaveBeenCalled();

    embedder.mockResolvedValueOnce([[0.1, 0.2]]);
    await expect(embedLocal(["a"])).rejects.toThrow(String(EMBEDDING_DIMENSIONS));
  });
});

it("lets the built-in model embed data of a project restricted to other providers", () => {
  const policy = { allowed: ["anthropic"] };
  expect(embeddingAllowed(policy, "local")).toBe(true);
  expect(embeddingAllowed(policy, "ollama")).toBe(false);
});
