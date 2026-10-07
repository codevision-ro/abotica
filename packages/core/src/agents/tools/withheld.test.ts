import { describe, expect, it } from "vitest";
import { WITHHELD_NOTE, withhold, withholdClosed } from "./withheld";

const task = { id: "t1", title: "Draft the settlement", status: "review", output: "Full text", comments: ["ok"] };

describe("withholdClosed", () => {
  it("replaces the content of a closed project's item and keeps its metadata", () => {
    expect(withholdClosed(task, "p1", new Set(["p1"]), ["output", "comments"])).toEqual({
      id: "t1",
      title: "Draft the settlement",
      status: "review",
      output: WITHHELD_NOTE,
      comments: WITHHELD_NOTE,
    });
  });

  it("returns the item as it is for an open project or no project", () => {
    expect(withholdClosed(task, "p2", new Set(["p1"]), ["output"])).toEqual(task);
    expect(withholdClosed(task, null, new Set(["p1"]), ["output"])).toEqual(task);
  });

  it("does not change the item it was given", () => {
    const item = { ...task };
    withholdClosed(item, "p1", new Set(["p1"]), ["output"]);
    expect(item).toEqual(task);
  });
});

describe("withhold", () => {
  it("replaces the fields only when the content is closed", () => {
    expect(withhold(task, true, ["output"])).toEqual({ ...task, output: WITHHELD_NOTE });
    expect(withhold(task, false, ["output"])).toEqual(task);
  });
});
