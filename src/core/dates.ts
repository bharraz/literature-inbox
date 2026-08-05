/**
 * Dates for the recency window.
 *
 * Pure, with `today` as a parameter rather than a call to `Date.now()`, for the
 * same reason `runUpdate` takes a `today` string: a clock-dependent test is a
 * test that fails at midnight or in another timezone.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back an update looks when the user hasn't said otherwise.
 *
 * Wide enough that the very first run returns something — the alternative,
 * anchoring on "since you last ran", returns an empty inbox on day one and
 * looks broken.
 */
export const DEFAULT_RECENCY_WINDOW_DAYS = 30;

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD`, *days* before *today*, in UTC. Negative windows clamp to 0
 * rather than querying the future. */
export function isoDaysAgo(days: number, today: Date = new Date()): string {
  const back = Number.isFinite(days) ? Math.max(0, days) : DEFAULT_RECENCY_WINDOW_DAYS;
  return isoDate(new Date(today.getTime() - back * DAY_MS));
}
