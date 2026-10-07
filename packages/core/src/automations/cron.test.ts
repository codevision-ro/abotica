import { describe, expect, it } from "vitest";
import { isValidCron, normalizeCron } from "./cron";

describe("isValidCron", () => {
  it.each(["* * * * *", "0 9 * * 1-5", "*/15 * * * *", "0 8,12,18 * * *", "0-30/10 1 1 1 0", "  5 4  * * *  "])(
    "accepts %j",
    (value) => expect(isValidCron(value)).toBe(true),
  );

  it.each(["", "* * * *", "* * * * * *", "@daily", "a * * * *", "100 * * * *", "1- * * * *", "*/ * * * *", "1,,2 * * * *"])(
    "rejects %j",
    (value) => expect(isValidCron(value)).toBe(false),
  );
});

describe("normalizeCron", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeCron("  0   9\t* *  1-5 ")).toBe("0 9 * * 1-5");
  });
});
