/**
 * OpenAlex client. Keyless, with an optional polite-pool `mailto`.
 *
 * The `mailto` is a *user setting*, never a hardcoded developer address:
 * shipping one would put every user's traffic under one identity and is
 * exactly the sort of thing plugin review flags.
 *
 * Junk filtering happens here rather than in callers because OpenAlex has
 * real data-quality problems — records with no title, and publication dates
 * decades in the future (seen live, not hypothetical). Filtering at the
 * source means nothing downstream ever has to think about it.
 */

import {
  bareOpenAlexId,
  makeId,
  normalizeDoi,
  ARXIV,
  DOI,
  OPENALEX,
} from "./ids";
import { RateLimiter, buildUrl, getWithRetry, NotFoundError, type Transport } from "./http";
import { emptyWork, type Author, type Work } from "./types";

export const OPENALEX_BASE_URL = "https://api.openalex.org/works";

/** Article-like types only — OpenAlex also indexes datasets, grants, etc. */
const ALLOWED_TYPES = [
  "article", "preprint", "book", "book-chapter", "dissertation", "review",
];

const TYPE_TO_ITEM_TYPE: Record<string, string> = {
  article: "journalArticle",
  preprint: "preprint",
  book: "book",
  "book-chapter": "bookSection",
  dissertation: "thesis",
  review: "journalArticle",
};

/** Reassemble the abstract OpenAlex stores as {word: [positions]} to dodge
 * publisher copyright on the contiguous text. */
export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | undefined | null,
): string | undefined {
  if (!invertedIndex) return undefined;
  const positioned: { position: number; word: string }[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) positioned.push({ position, word });
  }
  if (positioned.length === 0) return undefined;
  positioned.sort((a, b) => a.position - b.position);
  return positioned.map((entry) => entry.word).join(" ");
}

function authorFromDisplayName(displayName: string): Author {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { lastName: parts[0] as string };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] as string };
}

function venueName(data: any): string | undefined {
  return (
    data?.primary_location?.source?.display_name ??
    data?.host_venue?.display_name ??
    undefined
  );
}

/**
 * Reject records that are obviously broken regardless of what the API says.
 * `maxFutureDays` allows for legitimately forthcoming work while rejecting
 * the "published in 2050" records OpenAlex actually returns.
 */
export function passesSanityFilters(data: any, maxFutureDays = 60, today = new Date()): boolean {
  if (!(data?.title || data?.display_name)) return false;
  const dateString: string | undefined = data?.publication_date;
  if (dateString) {
    const published = new Date(`${dateString}T00:00:00Z`);
    if (Number.isNaN(published.getTime())) return false;
    const limit = new Date(today.getTime() + maxFutureDays * 24 * 60 * 60 * 1000);
    if (published.getTime() > limit.getTime()) return false;
  }
  return true;
}

export function workFromOpenAlex(data: any): Work {
  const openAlexId = bareOpenAlexId(String(data.id));
  const doi = normalizeDoi(data.doi);
  const work = emptyWork(openAlexId);
  work.itemType = TYPE_TO_ITEM_TYPE[data.type] ?? data.type ?? "journalArticle";
  work.ids = [makeId(OPENALEX, openAlexId)];
  if (doi) work.ids.push(makeId(DOI, doi));
  const arxivId = extractArxivId(data);
  if (arxivId) work.ids.push(makeId(ARXIV, arxivId));
  work.title = data.title ?? data.display_name ?? undefined;
  work.abstract = reconstructAbstract(data.abstract_inverted_index);
  work.date = data.publication_date ?? undefined;
  work.doi = doi;
  work.url = data.id ?? undefined;
  work.publication = venueName(data);
  work.authors = (data.authorships ?? [])
    .map((authorship: any) => authorship?.author?.display_name)
    .filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
    .map(authorFromDisplayName);
  work.references = (data.referenced_works ?? []).map((reference: string) =>
    makeId(OPENALEX, bareOpenAlexId(reference)),
  );
  work.source = "openalex";
  return work;
}

/** OpenAlex often knows a preprint's arXiv landing page; capturing it lets an
 * arXiv-sourced arrival dedup against an OpenAlex-sourced one. */
function extractArxivId(data: any): string | undefined {
  const locations: any[] = [
    data?.primary_location,
    ...(Array.isArray(data?.locations) ? data.locations : []),
  ].filter(Boolean);
  for (const location of locations) {
    const url: string | undefined = location?.landing_page_url ?? location?.pdf_url;
    const match = url?.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i);
    if (match?.[1]) return match[1].replace(/v\d+$/, "").replace(/\.pdf$/, "");
  }
  return undefined;
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export interface OpenAlexOptions {
  mailto?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so "future date" filtering is deterministic. */
  today?: () => Date;
}

export class OpenAlexClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly transport: Transport,
    private readonly options: OpenAlexOptions = {},
  ) {
    this.limiter = new RateLimiter(options.minIntervalMs ?? 100, options.sleep);
  }

  /** A free-text query, or an OpenAlex concept id like `C41008148`. */
  private static topicFilter(topic: string): string {
    const trimmed = topic.trim();
    return /^C\d+$/.test(trimmed) ? `concepts.id:${trimmed}` : `default.search:${trimmed}`;
  }

  private typeFilter(): string {
    return `type:${ALLOWED_TYPES.join("|")}`;
  }

  private async getJson(url: string): Promise<any> {
    await this.limiter.wait();
    const body = await getWithRetry(this.transport, url, {
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
    });
    return JSON.parse(body);
  }

  private buildUrl(base: string, params: Record<string, string | undefined>): string {
    return buildUrl(base, { ...params, mailto: this.options.mailto });
  }

  /** Cursor-paginated fetch, junk-filtered, stopping at `limit`. */
  private async paginated(filter: string, sort: string, limit: number): Promise<Work[]> {
    const results: Work[] = [];
    let cursor: string | undefined = "*";
    const today = this.options.today?.() ?? new Date();

    while (cursor && results.length < limit) {
      const perPage = Math.min(200, limit - results.length);
      const url: string = this.buildUrl(OPENALEX_BASE_URL, {
        filter,
        sort,
        "per-page": String(perPage),
        cursor,
      });
      const data = await this.getJson(url);
      const page: any[] = data.results ?? [];
      for (const item of page) {
        if (results.length >= limit) break;
        if (!passesSanityFilters(item, 60, today)) continue;
        results.push(workFromOpenAlex(item));
      }
      cursor = data.meta?.next_cursor ?? undefined;
      if (page.length === 0) break;
    }
    return results;
  }

  /** The N most-cited works matching *topic*. */
  async topWorks(topic: string, n: number): Promise<Work[]> {
    const filter = `${OpenAlexClient.topicFilter(topic)},${this.typeFilter()}`;
    return this.paginated(filter, "cited_by_count:desc", n);
  }

  /** Works matching *topic* published on/after `since` (YYYY-MM-DD), newest first. */
  async worksSince(topic: string, since: string, limit = 500): Promise<Work[]> {
    const filter = [
      OpenAlexClient.topicFilter(topic),
      this.typeFilter(),
      `from_publication_date:${since}`,
    ].join(",");
    return this.paginated(filter, "publication_date:desc", limit);
  }

  /** Resolve one work by DOI, or undefined when OpenAlex doesn't have it. */
  async workByDoi(doi: string): Promise<Work | undefined> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return undefined;
    const url = this.buildUrl(`${OPENALEX_BASE_URL}/https://doi.org/${normalized}`, {});
    try {
      return workFromOpenAlex(await this.getJson(url));
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  /** Best-effort title lookup — used to attach a DOI to an RSS item that
   * arrived without one. Returns undefined rather than guessing when the
   * top hit's title doesn't actually match. */
  async workByTitle(title: string): Promise<Work | undefined> {
    const url = this.buildUrl(OPENALEX_BASE_URL, {
      filter: `title.search:${title}`,
      "per-page": "1",
    });
    const data = await this.getJson(url);
    const first = (data.results ?? [])[0];
    return first ? workFromOpenAlex(first) : undefined;
  }

  /**
   * Batched lookup by bare OpenAlex id, 50 per request. Not every requested
   * id necessarily comes back (records get merged or withdrawn) — treat the
   * result as a best-effort subset, never a positional match to the input.
   */
  async worksByIds(ids: string[]): Promise<Work[]> {
    const results: Work[] = [];
    for (const chunk of chunked(ids, 50)) {
      const url = this.buildUrl(OPENALEX_BASE_URL, {
        filter: `openalex_id:${chunk.join("|")}`,
        "per-page": String(chunk.length),
      });
      const data = await this.getJson(url);
      for (const item of data.results ?? []) results.push(workFromOpenAlex(item));
    }
    return results;
  }
}
