/**
 * How much of OpenAlex's daily allowance a run has used.
 *
 * OpenAlex's free tier is a metered daily spend allowance — roughly $0.001 per
 * request, reset at midnight UTC — not the unlimited keyless API this plugin
 * was originally designed against. Exhausting it answers `429` with hours on
 * the clock, so a user needs to see the gauge *before* they start something
 * expensive, not after.
 *
 * Shown as requests and a percentage, never as currency: the user pays
 * nothing, and a dollar figure implies a bill that does not exist.
 */

/**
 * Fallback daily allowance in credits, used only before the first response of
 * the day has told us the real figure.
 *
 * 1000 credits keyless, measured from `X-RateLimit-Limit`. A key raises it —
 * we do not assume by how much, we read it.
 */
export const ASSUMED_DAILY_CREDITS = 1000;

export interface BudgetState {
  /** `YYYY-MM-DD` (UTC) the count belongs to. */
  day: string;
  /** Requests we made today — the fallback tally, and a sanity check. */
  requests: number;
  /** Credits left, straight from `X-RateLimit-Remaining`. */
  reportedRemaining?: number;
  /** Daily total, straight from `X-RateLimit-Limit`. */
  reportedTotal?: number;
}

export function emptyBudget(day: string): BudgetState {
  return { day, requests: 0 };
}

/** UTC day, because that is when OpenAlex's allowance resets — a local-date
 * counter would reset at the wrong moment for most of the world. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Add *count* requests, rolling the counter over at midnight UTC. */
export function recordRequests(
  state: BudgetState | undefined,
  count: number,
  now: Date = new Date(),
): BudgetState {
  const day = utcDay(now);
  if (!state || state.day !== day) return { day, requests: count };
  return { ...state, requests: state.requests + count };
}

/**
 * Fold in what OpenAlex just told us.
 *
 * Its own figures always win over our tally: the allowance is shared with any
 * other tool using the same key or address, so a local count can only ever be
 * a lower bound.
 */
export function recordReported(
  state: BudgetState | undefined,
  reported: { limit?: number; remaining?: number },
  now: Date = new Date(),
): BudgetState {
  const base = state && state.day === utcDay(now) ? state : emptyBudget(utcDay(now));
  return {
    ...base,
    reportedTotal: reported.limit ?? base.reportedTotal,
    reportedRemaining: reported.remaining ?? base.reportedRemaining,
  };
}

export interface BudgetGauge {
  used: number;
  total: number;
  fraction: number;
  /** True when the numbers come from OpenAlex rather than our own tally. */
  measured: boolean;
  label: string;
}

/**
 * What to draw. Prefers OpenAlex's own figures and falls back to the local
 * count, saying which it is — an estimate presented as fact is worse than no
 * gauge at all.
 */
export function gauge(state: BudgetState | undefined, day: string): BudgetGauge {
  const current = state && state.day === day ? state : undefined;

  if (current?.reportedTotal && current.reportedRemaining !== undefined) {
    const used = Math.max(0, current.reportedTotal - current.reportedRemaining);
    return {
      used,
      total: current.reportedTotal,
      fraction: clamp(used / current.reportedTotal),
      measured: true,
      label: `${used} of ${current.reportedTotal} credits used today`,
    };
  }

  const used = current?.requests ?? 0;
  return {
    used,
    total: ASSUMED_DAILY_CREDITS,
    fraction: clamp(used / ASSUMED_DAILY_CREDITS),
    measured: false,
    label: `about ${used} of ~${ASSUMED_DAILY_CREDITS} credits used today (estimated)`,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
