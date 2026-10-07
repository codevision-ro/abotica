import { describe, expect, it } from "vitest";
import {
  checkSkillFiles,
  compareSkillPaths,
  normalizeSkillPath,
  packageSkillFiles,
  parseSkillMd,
  referencedSkillPaths,
  serializeSkillMd,
  skillPackageFiles,
} from "./skill-md";

describe("parseSkillMd", () => {
  it("splits frontmatter fields from the body", () => {
    const md = "---\nname: pdf\ndescription: >\n  Work with PDF\n  files.\nlicense: MIT\n---\n\n# PDF\n\nSteps";
    expect(parseSkillMd(md)).toEqual({
      name: "pdf",
      description: "Work with PDF files.",
      metadata: { license: "MIT" },
      body: "# PDF\n\nSteps",
    });
  });

  it("keeps the whole text as body without frontmatter", () => {
    expect(parseSkillMd("﻿# Title\r\nText")).toEqual({ metadata: {}, body: "# Title\nText" });
  });

  it("ignores frontmatter that is not a YAML map", () => {
    expect(parseSkillMd("---\n- a\n---\nBody")).toEqual({ metadata: {}, body: "Body" });
  });

  it("round-trips through serializeSkillMd", () => {
    const skill = {
      name: "seo: articles",
      description: 'Use it for "SEO"',
      metadata: { "allowed-tools": ["Read"] },
      body: "Body",
    };
    const parsed = parseSkillMd(serializeSkillMd(skill));
    expect(parsed).toEqual(skill);
  });
});

describe("normalizeSkillPath", () => {
  it.each([
    ["./references//api.md", "references/api.md"],
    ["scripts\\run.py", "scripts/run.py"],
    ["SKILL.md", "SKILL.md"],
  ])("normalizes %j", (input, expected) => expect(normalizeSkillPath(input)).toBe(expected));

  it.each(["", "../secret", "a/../../b", "a/\u0001b", "/"])("rejects %j", (input) =>
    expect(normalizeSkillPath(input)).toBeNull(),
  );
});

describe("compareSkillPaths", () => {
  it("puts SKILL.md first, then folders before files", () => {
    const paths = ["z.md", "references/b.md", "SKILL.md", "a.md", "references/a/x.md", "scripts/run.py"];
    expect(paths.sort(compareSkillPaths)).toEqual([
      "SKILL.md",
      "references/a/x.md",
      "references/b.md",
      "scripts/run.py",
      "a.md",
      "z.md",
    ]);
  });
});

describe("packageSkillFiles", () => {
  it("unwraps the folder around SKILL.md and reports what it leaves out", () => {
    const result = packageSkillFiles([
      { path: "my-skill/SKILL.md", content: "---\nname: My skill\ndescription: Does things\n---\nBody" },
      { path: "my-skill/references/api.md", content: "API" },
      { path: "my-skill/logo.png", content: "\u0000PNG" },
      { path: "README.md", content: "outside" },
    ]);
    expect(result).toEqual({
      pkg: {
        name: "My skill",
        description: "Does things",
        metadata: {},
        files: [
          { path: "SKILL.md", content: "Body" },
          { path: "references/api.md", content: "API" },
        ],
      },
      skipped: ["my-skill/logo.png", "README.md"],
    });
  });

  it("falls back to the folder name without a name in the frontmatter", () => {
    expect(packageSkillFiles([{ path: "pdf-tools/SKILL.md", content: "Body" }])?.pkg.name).toBe("pdf-tools");
  });

  it("returns null without SKILL.md", () => {
    expect(packageSkillFiles([{ path: "notes.md", content: "x" }])).toBeNull();
  });

  it("puts the frontmatter back for export", () => {
    const { pkg } = packageSkillFiles([{ path: "SKILL.md", content: "---\nname: a\ndescription: b\n---\nBody" }])!;
    expect(skillPackageFiles(pkg)).toEqual([{ path: "SKILL.md", content: "---\nname: a\ndescription: b\n---\n\nBody\n" }]);
  });
});

describe("checkSkillFiles", () => {
  it("accepts a valid folder", () => {
    expect(
      checkSkillFiles([
        { path: "SKILL.md", content: "x" },
        { path: "a/b.md", content: "y" },
      ]),
    ).toBeNull();
  });

  it("names the first problem", () => {
    expect(checkSkillFiles([{ path: "a.md", content: "" }])).toEqual({ code: "missingSkillMd" });
    expect(
      checkSkillFiles([
        { path: "SKILL.md", content: "" },
        { path: "../a", content: "" },
      ]),
    ).toEqual({
      code: "invalidPath",
      path: "../a",
    });
    expect(
      checkSkillFiles([
        { path: "SKILL.md", content: "" },
        { path: "SKILL.md", content: "" },
      ]),
    ).toEqual({
      code: "duplicatePath",
      path: "SKILL.md",
    });
  });
});

describe("referencedSkillPaths", () => {
  it("finds relative links and code paths, relative to the file", () => {
    const md = "See [API](references/api.md#auth), run `scripts/fill.py`, [site](https://x.dev/a.md) and [up](../b.md).";
    expect(referencedSkillPaths(md)).toEqual(["references/api.md", "scripts/fill.py"]);
    expect(referencedSkillPaths("[x](./forms.md)", "references/api.md")).toEqual(["references/forms.md"]);
  });
});
