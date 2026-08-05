import { describe, expect, it } from "vitest";
import { DEFAULT_RECENCY_WINDOW_DAYS, isoDate, isoDaysAgo } from "../src/core/dates";

const NOON = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("isoDaysAgo", () => {
  it("counts back the requested number of days", () => {
    expect(isoDaysAgo(30, NOON("2026-08-05"))).toBe("2026-07-06");
  });

  it("crosses a month boundary", () => {
    expect(isoDaysAgo(7, NOON("2026-03-03"))).toBe("2026-02-24");
  });

  it("handles a leap day", () => {
    expect(isoDaysAgo(1, NOON("2024-03-01"))).toBe("2024-02-29");
  });

  it("returns today for a zero-day window", () => {
    expect(isoDaysAgo(0, NOON("2026-08-05"))).toBe("2026-08-05");
  });

  it("clamps a negative window rather than querying the future", () => {
    expect(isoDaysAgo(-10, NOON("2026-08-05"))).toBe("2026-08-05");
  });

  it("falls back to the default window when given a non-number", () => {
    expect(isoDaysAgo(Number.NaN, NOON("2026-08-05"))).toBe(
      isoDaysAgo(DEFAULT_RECENCY_WINDOW_DAYS, NOON("2026-08-05")),
    );
  });
});

describe("isoDate", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(isoDate(new Date("2026-01-09T23:59:59Z"))).toBe("2026-01-09");
  });
});
