/**
 * OpenAlex client. Works keyless, with an optional free API key.
 *
 * The key is a *user setting*, never a hardcoded one: shipping a key would put
 * every user's traffic under one identity and burn one shared allowance, which
 * is exactly the sort of thing plugin review flags. Keyless still works — see
 * docs/openalex-dependency.md for what that costs.
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
import {
  RateLimiter,
  RateLimitError,
  buildUrl,
  getWithRetry,
  NotFoundError,
  type Transport,
} from "./http";
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

/**
 * Display names from one of OpenAlex's subject-term lists.
 *
 * Capped, because `concepts` in particular runs long and tails off into terms
 * so broad they say nothing ("Physics", "Computer science"). OpenAlex returns
 * these ranked, so taking the head keeps the useful ones.
 */
const MAX_SUBJECT_TERMS = 8;

/**
 * How many ids go into one `cites:` filter. Fewer requests is the point: at 25
 * a hundred anchors cost four round trips, which is four chances to be rate
 * limited before a single paper arrives.
 */
const ADJACENCY_BATCH = 50;

function subjectTerms(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    const name = (entry as any)?.display_name;
    if (typeof name !== "string" || !name.trim()) continue;
    if (names.includes(name)) continue;
    names.push(name);
    if (names.length >= MAX_SUBJECT_TERMS) break;
  }
  return names;
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
  work.topics = subjectTerms(data.topics);
  work.keywords = subjectTerms(data.keywords);
  work.concepts = subjectTerms(data.concepts);
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

/**
 * Which date a recency window is measured against — see `worksSince`.
 *
 * `created` (when OpenAlex indexed the record) is a **paid-plan filter**. It is
 * kept here because it is the better signal for anyone who has a plan, but it
 * must never be the default: on the free tier it fails every request.
 */
export type RecencyBasis = "created" | "publication";

export interface OpenAlexOptions {
  /**
   * A free OpenAlex API key. Optional: without one you get a smaller daily
   * allowance (1000 credits, measured) rather than no service. Sent as the
   * `api_key` query parameter, which is how OpenAlex accepts it.
   *
   * The `mailto` "polite pool" this replaced no longer exists — it was retired
   * when keys were introduced in February 2026.
   */
  apiKey?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so "future date" filtering is deterministic. */
  today?: () => Date;
  /**
   * Called when a multi-page or multi-batch fetch fails partway.
   *
   * When set, such a fetch returns what it already has instead of throwing.
   * A 400-paper kernel build that dies on page three is otherwise a total
   * loss, and 380 papers is a perfectly good starting graph. Supplying this
   * is how a caller says "partial is better than nothing, and I will tell the
   * user what happened" — without it the old throwing behaviour stands, so a
   * single-shot lookup still fails loudly.
   */
  onPartialFetch?: (error: unknown, fetched: number) => void;
}

export class OpenAlexClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly transport: Transport,
    private readonly options: OpenAlexOptions = {},
  ) {
    // Just under OpenAlex's 10/s ceiling — see RateLimiter.
    this.limiter = new RateLimiter(options.minIntervalMs ?? 150, options.sleep);
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
    if (this.rateLimited) throw this.rateLimited;
    await this.limiter.wait();
    const body = await getWithRetry(this.transport, url, {
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
    });
    return JSON.parse(body);
  }

  private buildUrl(base: string, params: Record<string, string | undefined>): string {
    return buildUrl(base, { ...params, api_key: this.options.apiKey });
  }

  /**
   * Run *work*, and if `onPartialFetch` is configured, treat a failure as the
   * end of the fetch rather than the end of the run — reporting how much had
   * already been gathered. Without it, the error propagates as before.
   */
  private async tolerant<T>(collected: T[], work: () => Promise<void>): Promise<T[]> {
    const onPartial = this.options.onPartialFetch;
    if (!onPartial) {
      await work();
      return collected;
    }
    try {
      await work();
    } catch (error) {
      // A rate limit means "stop asking", so remember it and let every later
      // fetch on this client bail immediately. Without this, an outer loop
      // over batches would keep issuing requests — each with its own retry
      // ladder — against a service that had just asked us to back off, and
      // report the same failure once per batch.
      if (error instanceof RateLimitError) this.rateLimited = error;
      onPartial(error, collected.length);
    }
    return collected;
  }

  /** True once the API has rate-limited this client. Latches for the run. */
  private rateLimited?: RateLimitError;

  /** Whether the run has been told to stop. */
  wasRateLimited(): boolean {
    return this.rateLimited !== undefined;
  }

  /** Cursor-paginated fetch, junk-filtered, stopping at `limit`. */
  private async paginated(filter: string, sort: string, limit: number): Promise<Work[]> {
    const results: Work[] = [];
    const today = this.options.today?.() ?? new Date();

    return this.tolerant(results, async () => {
      let cursor: string | undefined = "*";
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
    });
  }

  /** The N most-cited works matching *topic*. */
  async topWorks(topic: string, n: number): Promise<Work[]> {
    const filter = `${OpenAlexClient.topicFilter(topic)},${this.typeFilter()}`;
    return this.paginated(filter, "cited_by_count:desc", n);
  }

  /**
   * Works matching *topic* published on/after `since` (YYYY-MM-DD), newest
   * first.
   *
   * `basis` defaults to `publication`, and **`created` is not usable on the
   * free tier**: `from_created_date` is a paid-plan filter, and OpenAlex
   * refuses it with a 429 whose body reads "Plan upgrade required" — which
   * looks exactly like rate limiting and is not. Indexing date would be the
   * better signal (OpenAlex indexes papers weeks after publication, so a
   * publication-date window misses anything indexed late), and the free
   * substitute is a *wide, overlapping* window: ask for the last N days every
   * run and let exact dedup absorb the repeats. That is why the window is a
   * user setting rather than "since you last ran".
   */
  async worksSince(
    topic: string,
    since: string,
    limit = 500,
    basis: RecencyBasis = "publication",
  ): Promise<Work[]> {
    const dateFilter = basis === "created" ? "from_created_date" : "from_publication_date";
    const filter = [
      OpenAlexClient.topicFilter(topic),
      this.typeFilter(),
      `${dateFilter}:${since}`,
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
   * Batched lookup by DOI, 50 per request.
   *
   * Same best-effort contract as `worksByIds`: OpenAlex simply won't have some
   * DOIs, so the result is a subset and never a positional match to the input.
   * Callers that need to report "these ones weren't found" must compare by id.
   */
  async worksByDois(dois: string[]): Promise<Work[]> {
    const normalized = dois
      .map((doi) => normalizeDoi(doi))
      .filter((doi): doi is string => Boolean(doi));
    const results: Work[] = [];
    return this.tolerant(results, async () => {
      for (const chunk of chunked(normalized, 50)) {
        const url = this.buildUrl(OPENALEX_BASE_URL, {
          filter: `doi:${chunk.join("|")}`,
          "per-page": String(chunk.length),
        });
        const data = await this.getJson(url);
        for (const item of data.results ?? []) results.push(workFromOpenAlex(item));
      }
    });
  }

  /**
   * Recent works citing any of *ids* — the selection mode that makes an
   * arrival connected *by construction*.
   *
   * A topic search finds papers about roughly the right subject and then hopes
   * an edge exists. This asks the opposite question: what has recently cited
   * the papers I already keep? Every result is guaranteed to wire into the
   * user's library, which is the entire premise of the plugin.
   *
   * Sorted newest-first, unlike `worksCiting`, which wants influence.
   */
  async worksCitingSince(
    ids: string[],
    since: string,
    limit: number,
    basis: RecencyBasis = "publication",
  ): Promise<Work[]> {
    if (ids.length === 0 || limit <= 0) return [];
    const dateFilter = basis === "created" ? "from_created_date" : "from_publication_date";
    const results: Work[] = [];
    const seen = new Set<string>();

    return this.tolerant(results, async () => {
      for (const chunk of chunked(ids, ADJACENCY_BATCH)) {
        if (results.length >= limit || this.rateLimited) break;
        const filter = [
          `cites:${chunk.join("|")}`,
          this.typeFilter(),
          `${dateFilter}:${since}`,
        ].join(",");
        for (const work of await this.paginated(filter, "publication_date:desc", limit)) {
          if (seen.has(work.key)) continue;
          seen.add(work.key);
          results.push(work);
          if (results.length >= limit) break;
        }
      }
    });
  }

  /**
   * Works that cite any of *ids* — the outward half of a snowball.
   *
   * Sorted by citation count rather than date on purpose: the point is to find
   * the papers that built on your seeds and mattered, not merely the most
   * recent thing to reference one.
   */
  async worksCiting(ids: string[], limit: number): Promise<Work[]> {
    if (ids.length === 0 || limit <= 0) return [];
    const results: Work[] = [];
    const seen = new Set<string>();
    // OpenAlex caps a filter's OR list, so ask in batches and merge. Each
    // batch gets the full limit; duplicates across batches are expected,
    // since one paper often cites several seeds.
    for (const chunk of chunked(ids, ADJACENCY_BATCH)) {
      if (results.length >= limit || this.rateLimited) break;
      const filter = `cites:${chunk.join("|")},${this.typeFilter()}`;
      for (const work of await this.paginated(filter, "cited_by_count:desc", limit)) {
        if (seen.has(work.key)) continue;
        seen.add(work.key);
        results.push(work);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * Works by one author.
   *
   * Accepts an OpenAlex author id (`A5023888391`), an ORCID, or a plain name.
   * A name is a search, so it can conflate two people who share one — the id
   * and ORCID forms are exact, and the settings copy says so.
   */
  async worksByAuthor(author: string, n: number): Promise<Work[]> {
    const trimmed = author.trim();
    let authorFilter: string;
    if (/^A\d+$/.test(trimmed)) {
      authorFilter = `authorships.author.id:${trimmed}`;
    } else if (/^(https?:\/\/orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(trimmed)) {
      const orcid = trimmed.replace(/^https?:\/\/orcid\.org\//i, "");
      authorFilter = `authorships.author.orcid:https://orcid.org/${orcid}`;
    } else {
      authorFilter = `raw_author_name.search:${trimmed}`;
    }
    return this.paginated(`${authorFilter},${this.typeFilter()}`, "cited_by_count:desc", n);
  }

  /**
   * Batched lookup by bare OpenAlex id, 50 per request. Not every requested
   * id necessarily comes back (records get merged or withdrawn) — treat the
   * result as a best-effort subset, never a positional match to the input.
   */
  async worksByIds(ids: string[]): Promise<Work[]> {
    const results: Work[] = [];
    return this.tolerant(results, async () => {
      for (const chunk of chunked(ids, 50)) {
        const url = this.buildUrl(OPENALEX_BASE_URL, {
          filter: `openalex_id:${chunk.join("|")}`,
          "per-page": String(chunk.length),
        });
        const data = await this.getJson(url);
        for (const item of data.results ?? []) results.push(workFromOpenAlex(item));
      }
    });
  }
}
