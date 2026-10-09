import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://test@localhost/test";
});

vi.mock("@abotica/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@abotica/db")>()),
  db: {
    select: () => {
      throw new Error("no lookup expected");
    },
  },
}));

const { findReadableSkill, readsSkills, skillReadDescription } = await import("./skill-access");

const reader = (kind: "orchestrator" | "manager" | "specialist", opts: { skills?: string[]; leads?: string[] } = {}) => ({
  agent: { kind } as never,
  skills: (opts.skills ?? []).map((slug) => ({ id: `id-${slug}`, slug, name: slug, description: "" })),
  managedProjectIds: opts.leads ?? [],
});

describe("readsSkills", () => {
  it("offers skill_read to an agent with skills, the super agent, and a manager that leads a project", () => {
    expect(readsSkills(reader("specialist", { skills: ["seo-audit"] }))).toBe(true);
    expect(readsSkills(reader("orchestrator"))).toBe(true);
    expect(readsSkills(reader("manager", { leads: ["p1"] }))).toBe(true);
  });

  it("does not offer it to a specialist without skills, or a manager that leads nothing", () => {
    expect(readsSkills(reader("specialist"))).toBe(false);
    expect(readsSkills(reader("manager"))).toBe(false);
  });
});

describe("findReadableSkill", () => {
  it("finds the agent's own skills without a lookup", async () => {
    expect(await findReadableSkill(reader("specialist", { skills: ["seo-audit"] }), "seo-audit")).toMatchObject({
      id: "id-seo-audit",
    });
  });

  it("gives a specialist nothing beyond its own skills", async () => {
    expect(await findReadableSkill(reader("specialist", { skills: ["seo-audit"] }), "copywriting")).toBeNull();
    expect(await findReadableSkill(reader("manager"), "copywriting")).toBeNull();
  });
});

describe("skillReadDescription", () => {
  it("tells the super agent it reads every skill, and why", () => {
    expect(skillReadDescription(reader("orchestrator"))).toMatch(/any skill of the platform/);
  });

  it("tells a manager it reads its team's skills", () => {
    expect(skillReadDescription(reader("manager", { leads: ["p1"] }))).toMatch(/your specialists'/);
  });

  it("keeps a specialist to its own list", () => {
    expect(skillReadDescription(reader("specialist", { skills: ["seo-audit"] }))).toMatch(
      /^Load a skill from your skill list/,
    );
  });
});
