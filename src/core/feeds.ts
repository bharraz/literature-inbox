/**
 * arXiv category helpers, and the pre-rows feed shape.
 *
 * Feeds are no longer a thing of their own — every stream is a row in
 * `core/sources.ts`. What survives here is the arXiv category→URL translation
 * (categories are what researchers know; feed URLs are not) and the
 * `FeedConfig` type, which exists purely so a settings file written before
 * that unification can still be read and migrated.
 */


/** Pre-rows feed shape, read once by `migrateSources` and then discarded. */
export interface FeedConfig {
  url: string;
  enabled: boolean;
  windowDays?: number;
  maxPerRun?: number;
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

/**
 * Loose shape check, so an obvious typo is caught before a silent empty feed.
 * arXiv categories are `quant-ph`, `cs.CL`, `math.AG`, `astro-ph.HE` — but a
 * real fraction of the taxonomy hyphenates the part *after* the dot too
 * (`physics.atom-ph`, `cond-mat.mes-hall`, `physics.acc-ph`). A first version
 * of this check only allowed a hyphen before the dot, so "Test" reported
 * "not found" for a large, entirely valid slice of the real categories.
 */
export function looksLikeArxivCategory(category: string): boolean {
  return /^[a-z-]+(\.[A-Za-z-]{2,})?$/.test(category.trim());
}
