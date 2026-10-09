import { getTranslator } from "@abotica/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitUntrusted } from "../agents/untrusted";
import type { PullRequestFeedback, PullRequestStatus } from "../projects/pull-request-status";
import type { PullRequestRecord } from "./pull-requests";

/** pull-requests.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./pull-requests");
}

afterEach(() => vi.unstubAllEnvs());

const record = (over: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
  state: "open",
  nudgeSignature: {},
  fixRounds: 0,
  ...over,
});

const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  state: "open",
  draft: false,
  headSha: "aaa111",
  mergedAt: null,
  checks: "success",
  failedChecks: [],
  checksDenied: false,
  review: "none",
  feedback: [],
  ...over,
});

const failing = (sha: string) =>
  status({
    headSha: sha,
    checks: "failure",
    failedChecks: [
      { name: "test", status: "failure", url: "https://github.com/acme/site/actions/runs/1/job/11", job: 11 },
      { name: "lint", status: "failure", url: null, job: 12 },
    ],
  });

/** A review requesting changes and its two inline comments, as githubFeedback reads them. */
const feedbackItem = (
  over: Partial<PullRequestFeedback> & Pick<PullRequestFeedback, "id" | "body">,
): PullRequestFeedback => ({
  author: "ana",
  url: null,
  path: null,
  line: null,
  changesRequested: false,
  createdAt: new Date("2026-10-01T11:00:00Z"),
  ...over,
});
const reviewFeedback = [
  feedbackItem({ id: "review:2", body: "Two things to fix.", changesRequested: true }),
  feedbackItem({
    id: "comment:21",
    body: "Handle the empty list.",
    path: "src/list.ts",
    line: 14,
    url: "https://github.com/acme/site/pull/7#discussion_r21",
  }),
  feedbackItem({ id: "comment:22", body: "Rename this.", path: "src/util.ts", line: 3 }),
];

describe("prReactions", () => {
  it("nudges once per head SHA and failed checks", async () => {
    const { prReactions } = await load();
    const first = prReactions(record(), failing("aaa111"), 2);
    expect(first.action).toBe("wake");
    expect(first.nudges).toEqual([expect.objectContaining({ kind: "checks", signature: "aaa111:lint,test" })]);
    // Saved after the wake: the next poll on the same commit sends nothing, nor does a restart.
    const again = prReactions(record({ nudgeSignature: { checks: "aaa111:lint,test" } }), failing("aaa111"), 2);
    expect(again.nudges).toEqual([]);
  });

  it("sends nothing when a new commit fixes the checks", async () => {
    const { prReactions } = await load();
    const sent = record({ nudgeSignature: { checks: "aaa111:lint,test" }, fixRounds: 1 });
    expect(prReactions(sent, status({ headSha: "bbb222", checks: "success" }), 2).nudges).toEqual([]);
    expect(prReactions(sent, status({ headSha: "bbb222", checks: "pending" }), 2).nudges).toEqual([]);
    // Failing again on the new commit is a new nudge.
    expect(prReactions(sent, failing("bbb222"), 2).nudges).toHaveLength(1);
  });

  it("lists a review requesting changes and its two inline comments in one nudge, once", async () => {
    const { prReactions, feedbackBlock } = await load();
    const after = status({ review: "changes_requested", feedback: reviewFeedback });
    const reactions = prReactions(record(), after, 2);
    expect(reactions.nudges).toHaveLength(1);
    const nudge = reactions.nudges[0]!;
    expect(nudge).toMatchObject({ kind: "review", signature: "comment:21,comment:22,review:2" });

    const block = feedbackBlock(nudge.kind === "review" ? nudge.feedback : [], getTranslator("en"));
    const [segment] = splitUntrusted(block);
    expect(segment).toMatchObject({ type: "untrusted", source: "pull-request" });
    expect(segment!.text).toContain("(ana) [changes requested]: Two things to fix.");
    expect(segment!.text).toContain(
      "- src/list.ts:14 (ana): Handle the empty list.\n  https://github.com/acme/site/pull/7#discussion_r21",
    );
    expect(segment!.text).toContain("- src/util.ts:3 (ana): Rename this.");

    expect(prReactions(record({ nudgeSignature: { review: nudge.signature } }), after, 2).nudges).toEqual([]);
  });

  it("finishes the task on a merge, once", async () => {
    const { prReactions } = await load();
    const merged = status({
      state: "merged",
      mergedAt: new Date(),
      checks: "failure",
      failedChecks: failing("x").failedChecks,
    });
    expect(prReactions(record(), merged, 2)).toMatchObject({ merged: true, closed: false, nudges: [] });
    expect(prReactions(record({ state: "merged" }), merged, 2).merged).toBe(false);
  });

  it("reports a close without merge once", async () => {
    const { prReactions } = await load();
    expect(prReactions(record(), status({ state: "closed" }), 2)).toMatchObject({
      closed: true,
      merged: false,
      nudges: [],
    });
    expect(prReactions(record({ nudgeSignature: { closed: true } }), status({ state: "closed" }), 2).closed).toBe(false);
  });

  it("blocks instead of waking once the fix rounds are used up", async () => {
    const { prReactions } = await load();
    expect(prReactions(record({ fixRounds: 1 }), failing("aaa111"), 2).action).toBe("wake");
    const capped = prReactions(record({ fixRounds: 2 }), failing("aaa111"), 2);
    expect(capped.action).toBe("block");
    expect(capped.nudges).toHaveLength(1);
  });

  it("counts the rounds against the setting it is given", async () => {
    const { prReactions } = await load();
    expect(prReactions(record({ fixRounds: 2 }), failing("aaa111"), 5).action).toBe("wake");
    expect(prReactions(record({ fixRounds: 0 }), failing("aaa111"), 0).action).toBe("block");
  });

  it("gives the same nudge again while nothing was saved (a busy task is retried at the next poll)", async () => {
    const { prReactions } = await load();
    const before = record();
    const first = prReactions(before, failing("aaa111"), 2);
    // The task had a run going: no comment, no signature, no round.
    expect(prReactions(before, failing("aaa111"), 2)).toEqual(first);
  });

  it("tracks state and reviews when the token may not read the checks, and flags it once", async () => {
    const { prReactions } = await load();
    const denied = status({ checks: "none", checksDenied: true, review: "approved" });
    expect(prReactions(record(), denied, 2)).toMatchObject({ checksDenied: true, nudges: [] });
    expect(prReactions(record({ nudgeSignature: { checksDenied: true } }), denied, 2).checksDenied).toBe(false);
    expect(prReactions(record(), status({ ...denied, state: "merged" }), 2).merged).toBe(true);
  });
});

describe("checksBlock", () => {
  it("puts names, URLs and log tails in an untrusted block", async () => {
    const { checksBlock } = await load();
    const [segment] = splitUntrusted(
      checksBlock([{ name: "test", status: "failure", url: "https://ci/1", job: 1, log: "Error: boom\nexit 1" }]),
    );
    expect(segment).toEqual({
      type: "untrusted",
      source: "pull-request",
      text: "- test (failure): https://ci/1\n    Error: boom\n    exit 1",
    });
  });
});
