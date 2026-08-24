/**
 * Dates for the recency window.
 *
 * Pure, with `today` as a parameter rather than a call to `Date.now()`, for the
 * same reason `runUpdate` takes a `today` string: a clock-dependent test is a
 * test that fails at midnight or in another timezone.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back an update looks, in days — one global setting for every
 * source, not something worth tuning per row: recency is the entire reason a
 * result is in the inbox at all, so the number worth exposing is how far back
 * "recent" reaches, not a per-source override nobody needs. Two weeks is
 * wide enough that the very first run returns something — the alternative,
 * anchoring on "since you last ran", returns an empty inbox on day one and
 * looks broken.
 */
export const DEFAULT_RECENCY_WINDOW_DAYS = 14;

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD`, *days* before *today*, in UTC. Negative windows clamp to 0
 * rather than querying the future. */
export function isoDaysAgo(days: number, today: Date = new Date()): string {
  const back = Number.isFinite(days) ? Math.max(0, days) : DEFAULT_RECENCY_WINDOW_DAYS;
  return isoDate(new Date(today.getTime() - back * DAY_MS));
}
