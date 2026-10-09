import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateSettings, settingsTranslator } from "./settings";

const state = vi.hoisted(() => ({ rows: [] as { key: string; value: unknown }[] }));

vi.mock("@abotica/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => state.rows }) }) },
  settings: { key: "key", value: "value" },
}));
vi.mock("@abotica/db/orm", () => ({ eq: vi.fn(), inArray: vi.fn() }));
vi.mock("../infra/events", () => ({ publish: vi.fn() }));
vi.mock("../platform/audit", () => ({ audit: vi.fn() }));

describe("settingsTranslator", () => {
  beforeEach(() => invalidateSettings());

  it("translates in the language set in Settings", async () => {
    state.rows = [{ key: "general", value: { locale: "ro" } }];
    expect((await settingsTranslator())("common.actions.save")).toBe("Salvează");
  });

  it("falls back to English when no language is set", async () => {
    state.rows = [];
    expect((await settingsTranslator())("common.actions.save")).toBe("Save");
  });
});
