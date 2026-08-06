import { describe, expect, it } from "vitest";
import {
  ASSUMED_DAILY_CREDITS,
  emptyBudget,
  gauge,
  recordReported,
  recordRequests,
  utcDay,
} from "../src/core/budget";

const NOON = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("counting requests", () => {
  it("accumulates within a day", () => {
    let state = recordRequests(undefined, 1, NOON("2026-08-06"));
    state = recordRequests(state, 2, NOON("2026-08-06"));
    expect(state.requests).toBe(3);
  });

  it("rolls over at midnight UTC, not local midnight", () => {
    // OpenAlex resets at midnight UTC; a local-date counter would reset at the
    // wrong moment for most of the world.
    const state = recordRequests(emptyBudget("2026-08-05"), 1, NOON("2026-08-06"));
    expect(state.day).toBe("2026-08-06");
    expect(state.requests).toBe(1);
  });

  it("uses the UTC date", () => {
    expect(utcDay(new Date("2026-08-06T23:59:59Z"))).toBe("2026-08-06");
  });
});

describe("the gauge", () => {
  it("prefers OpenAlex's own figures and says they are measured", () => {
    const state = recordReported(emptyBudget(utcDay()), { limit: 1000, remaining: 940 });
    const result = gauge(state, utcDay());
    expect(result.measured).toBe(true);
    expect(result.used).toBe(60);
    expect(result.total).toBe(1000);
    expect(result.label).toContain("60 of 1000 credits");
    expect(result.label).not.toContain("estimated");
  });

  it("falls back to the local tally, labelled as an estimate", () => {
    // An estimate presented as fact is worse than no gauge at all.
    const state = recordRequests(emptyBudget(utcDay()), 12);
    const result = gauge(state, utcDay());
    expect(result.measured).toBe(false);
    expect(result.total).toBe(ASSUMED_DAILY_CREDITS);
    expect(result.label).toContain("estimated");
  });

  it("reads as empty on a fresh day rather than carrying yesterday over", () => {
    const stale = recordReported(
      emptyBudget("2026-08-05"),
      { limit: 1000, remaining: 0 },
      NOON("2026-08-05"),
    );
    const result = gauge(stale, "2026-08-06");
    expect(result.used).toBe(0);
    expect(result.measured).toBe(false);
  });

  it("never reports more than a full bar", () => {
    const state = recordRequests(emptyBudget(utcDay()), ASSUMED_DAILY_CREDITS * 5);
    expect(gauge(state, utcDay()).fraction).toBe(1);
  });

  it("survives a nonsensical reported total", () => {
    const state = recordReported(emptyBudget(utcDay()), { limit: 0, remaining: 0 });
    expect(gauge(state, utcDay()).fraction).toBe(0);
  });
});
