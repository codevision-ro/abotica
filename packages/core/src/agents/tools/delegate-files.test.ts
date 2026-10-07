import { describe, expect, it } from "vitest";
import { planHandover } from "./delegate-files";

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (path: string, text: string) => ({ path, name: path.split("/").pop()!, data: bytes(text) });

describe("planHandover", () => {
  it("saves new files", () => {
    const a = file("out/a.md", "one");
    expect(planHandover([a], [])).toEqual({ save: [a], replace: [], keep: [] });
  });

  it("keeps a file handed over again unchanged", () => {
    const plan = planHandover([file("a.md", "one")], [{ id: "old", name: "a.md", data: bytes("one") }]);
    expect(plan).toEqual({ save: [], replace: [], keep: ["old"] });
  });

  it("replaces an earlier file of the same name with other bytes", () => {
    const a = file("drafts/a.md", "two");
    const plan = planHandover([a], [{ id: "old", name: "a.md", data: bytes("one") }]);
    expect(plan).toEqual({ save: [a], replace: ["old"], keep: [] });
  });

  it("replaces an earlier file whose bytes are gone", () => {
    const a = file("a.md", "one");
    expect(planHandover([a], [{ id: "old", name: "a.md", data: null }])).toEqual({ save: [a], replace: ["old"], keep: [] });
  });

  it("leaves earlier files with other names alone", () => {
    const a = file("a.md", "one");
    expect(planHandover([a], [{ id: "b", name: "b.md", data: bytes("x") }])).toEqual({ save: [a], replace: [], keep: [] });
  });

  it("refuses two files with the same name", () => {
    const plan = planHandover([file("x/a.md", "1"), file("y/a.md", "2")], []);
    expect(plan).toEqual({ error: expect.stringContaining("both named a.md") });
  });
});
