import { describe, expect, it, vi } from "vitest";
import { hashSkillFiles, parseSkillUrl } from "./skill-sources";

// The vault needs a database; these tests never reach GitHub.
vi.mock("../platform/vault", () => ({ getSecret: async () => undefined }));

describe("parseSkillUrl", () => {
  it.each([
    ["anthropics/skills", { kind: "github", repo: "anthropics/skills" }],
    ["https://github.com/anthropics/skills", { kind: "github", repo: "anthropics/skills" }],
    ["github.com/anthropics/skills.git", { kind: "github", repo: "anthropics/skills" }],
    [
      "https://github.com/anthropics/skills/tree/main/skills/pdf",
      { kind: "github", repo: "anthropics/skills", ref: "main", path: "skills/pdf" },
    ],
    [
      "https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md",
      { kind: "github", repo: "anthropics/skills", ref: "main", path: "skills/pdf/SKILL.md" },
    ],
    ["https://skills.sh/anthropics/skills/pdf", { kind: "skills.sh", id: "anthropics/skills/pdf" }],
    ["https://www.skills.sh/anthropics/skills/pdf", { kind: "skills.sh", id: "anthropics/skills/pdf" }],
  ])("parses %j", (input, expected) => expect(parseSkillUrl(input)).toEqual(expected));

  it.each(["", "https://gitlab.com/a/b", "https://github.com/anthropics", "https://skills.sh/docs", "not a url"])(
    "rejects %j",
    (input) => expect(parseSkillUrl(input)).toBeNull(),
  );
});

describe("hashSkillFiles", () => {
  it("does not depend on file order", () => {
    const a = { path: "a.md", content: "A" };
    const b = { path: "b.md", content: "B" };
    expect(hashSkillFiles([a, b])).toBe(hashSkillFiles([b, a]));
    expect(hashSkillFiles([a, b])).not.toBe(hashSkillFiles([a, { ...b, content: "B2" }]));
  });
});
