/**
 * Per-feed configuration.
 *
 * Feeds are not interchangeable, which is why they get a row each rather than
 * one shared textarea of URLs. A weekly journal table of contents and a daily
 * preprint firehose want different windows and different caps, and a single
 * global "what counts as new" is wrong for at least one of them.
 *
 * Every per-feed field is optional and inherits the global setting when blank,
 * so a user who doesn't care never has to fill anything in.
 */

import type { Work } from "./types";

export interface FeedConfig {
  url: string;
  /** Off keeps the row and its settings without fetching it. */
  enabled: boolean;
  /** Days back that count as new for this feed. Blank inherits the global. */
  windowDays?: number;
  /** Ceiling on arrivals from this feed per run. Blank inherits the global. */
  maxPerRun?: number;
}

export function emptyFeed(url = ""): FeedConfig {
  return { url, enabled: true };
}

/**
 * Carry a pre-rows settings file forward.
 *
 * Feeds used to be one newline/comma separated string. Anyone upgrading has
 * that string and no rows, and silently losing their feeds would be a poor
 * welcome — so the string is converted once, on load.
 */
export function migrateFeedList(
  legacyFeeds: string | undefined,
  existing: readonly FeedConfig[] | undefined,
): FeedConfig[] {
  if (existing && existing.length > 0) return existing.map((feed) => ({ ...feed }));
  if (!legacyFeeds?.trim()) return [];
  return legacyFeeds
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => emptyFeed(url));
}

/**
 * Drop items older than *since*.
 *
 * Undated items are **kept**. Plenty of feeds omit a date, and dropping those
 * would silently turn a working feed into a dead one — a false positive costs
 * one skip on the dedup pass, a false negative loses the paper for good.
 */
export function withinWindow(works: readonly Work[], since: string): Work[] {
  return works.filter((work) => !work.date || work.date >= since);
}

/** The effective value of a per-feed override, falling back to the global. */
export function effective(override: number | undefined, fallback: number): number {
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? override
    : fallback;
}

/**
 * The RSS feed for an arXiv category.
 *
 * Categories are the thing researchers actually know (`quant-ph`, `cs.CL`);
 * feed URLs are not. So the setting takes a category and this builds the URL,
 * rather than asking people to know arXiv's hosting arrangement.
 *
 * RSS rather than arXiv's Atom query API on purpose: both return the same
 * metadata with no reference lists, but the feed path already has per-source
 * windows, caps and a DOI-resolution pass, and arXiv asks for a 3s gap between
 * API queries that the feed does not.
 */
export function arxivCategoryFeedUrl(category: string): string {
  return `https://rss.arxiv.org/rss/${encodeURIComponent(category.trim())}`;
}

/** Loose shape check, so an obvious typo is caught before a silent empty feed.
 * arXiv categories are `quant-ph`, `cs.CL`, `math.AG`, `astro-ph.HE`. */
export function looksLikeArxivCategory(category: string): boolean {
  return /^[a-z-]+(\.[A-Za-z]{2,})?$/.test(category.trim());
}
