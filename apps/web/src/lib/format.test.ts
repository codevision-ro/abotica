import { afterEach, describe, expect, it, vi } from "vitest";
import { createFormat } from "./format";

const en = createFormat("en");
const ro = createFormat("ro");

describe("usd", () => {
  it("uses 4 decimals below one dollar and 2 otherwise", () => {
    expect(en.usd(0.01234)).toBe("$0.0123");
    expect(en.usd(-0.5)).toBe("$-0.5000");
    expect(en.usd(12.345)).toBe("$12.35");
    expect(en.usd(0)).toBe("$0.00");
    expect(en.usd(null)).toBe("$0.00");
    expect(en.usd(undefined)).toBe("$0.00");
  });
});

describe("tokens", () => {
  it("formats compactly in the locale", () => {
    expect(en.tokens(1234)).toBe("1.2K");
    expect(en.tokens(999)).toBe("999");
    expect(en.tokens(null)).toBe("0");
    expect(ro.tokens(1500)).toBe(
      new Intl.NumberFormat("ro", { notation: "compact", maximumFractionDigits: 1 }).format(1500),
    );
  });
});

describe("dates", () => {
  // Local time on both sides, so the test does not depend on the machine's time zone.
  const date = new Date(2026, 0, 5, 14, 3);

  it("formats date and time", () => {
    expect(en.dateTime(date)).toBe("5 Jan 2026, 14:03");
    expect(ro.dateTime(date)).toBe("5 ian 2026, 14:03");
    expect(en.dateTime(date.toISOString())).toBe("5 Jan 2026, 14:03");
  });

  it("formats any pattern in the locale", () => {
    expect(en.date(date, "EEEE, d MMMM yyyy")).toBe("Monday, 5 January 2026");
    expect(ro.date(date, "EEEE, d MMMM yyyy")).toBe("luni, 5 ianuarie 2026");
  });

  it("returns an empty string for missing dates", () => {
    expect(en.dateTime(null)).toBe("");
    expect(en.date(undefined, "yyyy")).toBe("");
    expect(en.relative(null)).toBe("");
  });

  describe("relative", () => {
    afterEach(() => vi.useRealTimers());

    it("describes the distance from now with a suffix", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 5, 14, 8));
      expect(en.relative(date)).toBe("5 minutes ago");
      expect(ro.relative(date)).toBe("5 minute în urmă");
    });
  });
});

describe("duration", () => {
  const start = new Date(2026, 0, 5, 12, 0, 0);
  const after = (ms: number) => new Date(start.getTime() + ms);

  it("picks ms, seconds or minutes", () => {
    expect(en.duration(start, after(250))).toBe("250ms");
    expect(en.duration(start, after(12_340))).toBe("12.3s");
    expect(en.duration(start, after(125_600))).toBe("2m 6s");
  });

  it("returns an empty string when either end is missing", () => {
    expect(en.duration(start, null)).toBe("");
    expect(en.duration(undefined, start)).toBe("");
  });
});
