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

/** Reported by OpenAlex on a refusal, and the basis of the estimate. */
export const COST_PER_REQUEST_USD = 0.001;

/**
 * Assumed free daily allowance, in requests.
 *
 * An estimate, and labelled as one wherever it is shown. OpenAlex reports what
 * remains but not the total, so this is derived from the per-request cost and
 * the observed allowance — replace it the moment a real figure is available
 * from a response.
 */
export const ESTIMATED_DAILY_REQUESTS = 100;

export interface BudgetState {
  /** `YYYY-MM-DD` (UTC) the count belongs to. */
  day: string;
  requests: number;
  /** Remaining allowance as OpenAlex last reported it, when it has. */
  reportedRemaining?: number;
  /** Total allowance, if a response ever tells us. */
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
      label: `${used} of ${current.reportedTotal} requests used today`,
    };
  }

  const used = current?.requests ?? 0;
  return {
    used,
    total: ESTIMATED_DAILY_REQUESTS,
    fraction: clamp(used / ESTIMATED_DAILY_REQUESTS),
    measured: false,
    label: `about ${used} of ~${ESTIMATED_DAILY_REQUESTS} requests used today (estimated)`,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
