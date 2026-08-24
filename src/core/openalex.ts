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
export const OPENALEX_CONCEPTS_URL = "https://api.openalex.org/concepts";

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

/** Collapse runs of whitespace and trim, returning undefined for blanks. */
function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\s+/g, " ").trim() || undefined;
}

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
  return cleanText(
    data?.primary_location?.source?.display_name ?? data?.host_venue?.display_name,
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
  // Collapsed, not just taken as-is: a title carrying an embedded newline
  // breaks the note's YAML frontmatter and splits its heading in two.
  work.title = cleanText(data.title ?? data.display_name);
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
  if (typeof data.cited_by_count === "number") work.citedByCount = data.cited_by_count;
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

/** Strips embedded quotes before a term goes inside a quoted-phrase filter
 * value, so a user typing their own quotes can't produce a malformed filter. */
function quotedPhrase(term: string): string {
  return term.replace(/"/g, "");
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

  /**
   * A topic box may hold several comma-separated terms — "Smart Grid, AI" —
   * meant as an intersection ("papers at the intersection of both"), not
   * several separate searches. OpenAlex ANDs filter clauses joined by commas,
   * so each term becomes its own `concepts.id:` (or `default.search:` when it
   * doesn't resolve to a concept) clause, and joining them all with commas
   * narrows to works matching every term at once.
   */
  private static splitTopics(topic: string): string[] {
    return topic
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
  }

  /**
   * Resolves every comma-separated term in *topic* to its own filter clause
   * and ANDs them together. `unresolved` lists the terms that had no matching
   * OpenAlex concept and fell back to unscoped full-text search — the
   * settings preview uses this to warn before a fetch runs on that path.
   */
  private async resolveTopicFilter(
    topic: string,
  ): Promise<{ filter: string; unresolved: string[] }> {
    const terms = OpenAlexClient.splitTopics(topic);
    if (terms.length === 0) {
      const trimmed = topic.trim();
      return {
        filter: `default.search:"${quotedPhrase(trimmed)}"`,
        unresolved: trimmed ? [trimmed] : [],
      };
    }

    const resolved = await Promise.all(
      terms.map(async (term) => {
        if (OpenAlexClient.isConceptId(term)) return { term, conceptId: term };
        return { term, conceptId: await this.resolveConceptId(term) };
      }),
    );

    const filter = resolved
      .map((r) => (r.conceptId ? `concepts.id:${r.conceptId}` : `default.search:"${quotedPhrase(r.term)}"`))
      .join(",");
    const unresolved = resolved.filter((r) => !r.conceptId).map((r) => r.term);
    return { filter, unresolved };
  }

  /**
   * Free text resolved once to a concept id, memoized for the run.
   *
   * `default.search` unquoted matches *any* of the words anywhere in
   * title/abstract/fulltext — sorting those hits by citation count surfaces
   * the most-cited paper in the whole corpus that happens to contain just the
   * word "simulation" (a biomolecular simulation package, a DFT code),
   * regardless of field. `concepts.id` scopes to an actual field, so "most
   * cited" means something, and is tried first. Falls back to full-text
   * (returning undefined) if no concept matches or the lookup itself fails —
   * quoted as an exact phrase (see `topicFilter`'s caller), which turns that
   * fallback from "contains any of these words" into "contains this phrase",
   * a real precision fix confirmed live: an OR match across "trapped ion
   * quantum simulation" pulled in 82k works sorted by raw citation count
   * (unrelated top-cited papers dominate); the same string quoted as a phrase
   * narrows to 347, all genuinely on topic. A topic search degrading to
   * quoted full-text beats a kernel build failing outright.
   */
  private conceptIdCache = new Map<string, string | undefined>();

  private async resolveConceptId(topic: string): Promise<string | undefined> {
    const key = topic.trim().toLowerCase();
    if (this.conceptIdCache.has(key)) return this.conceptIdCache.get(key);
    try {
      const url = this.buildUrl(OPENALEX_CONCEPTS_URL, { search: topic, "per-page": "1" });
      const data = await this.getJson(url);
      const id = data.results?.[0]?.id;
      const resolved = typeof id === "string" ? bareOpenAlexId(id) : undefined;
      this.conceptIdCache.set(key, resolved);
      return resolved;
    } catch (error) {
      // A rate limit here must latch exactly like it does inside `paginated`,
      // so the works request right behind this one short-circuits instead of
      // spending a second request against a service that just said stop —
      // and must NOT be cached as "no concept found", since that's not what
      // happened and would poison every later call this run.
      if (error instanceof RateLimitError) this.rateLimited = error;
      return undefined;
    }
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

  /** True for an OpenAlex concept id, e.g. `C41008148` — already scoped, so
   * resolving it again would just spend a request to relearn the input. */
  private static isConceptId(topic: string): boolean {
    return /^C\d+$/.test(topic.trim());
  }

  /**
   * Which comma-separated terms in *topic* have no matching OpenAlex concept
   * and would fall back to unscoped full-text search (see `resolveConceptId`'s
   * doc comment). Empty means every term resolved. Used by the settings
   * preview to warn before a fetch runs on the unscoped path, where "most
   * cited" stops meaning "most cited in your field."
   */
  async unresolvedTopics(topic: string): Promise<string[]> {
    return (await this.resolveTopicFilter(topic)).unresolved;
  }

  /**
   * The cheapest possible real request — a List+Filter singleton page, billed
   * at the lowest rate — whose only purpose is to read the current
   * `X-RateLimit-*` headers. Used for a manual "refresh the budget gauge"
   * action, where the user wants today's real figures without waiting for an
   * update to happen to report them as a side effect.
   */
  async ping(): Promise<void> {
    const url = this.buildUrl(OPENALEX_BASE_URL, { filter: this.typeFilter(), "per-page": "1" });
    await this.getJson(url);
  }

  /** The N most-cited works matching *topic* (comma-separated terms AND together). */
  async topWorks(topic: string, n: number): Promise<Work[]> {
    const { filter: topicFilter } = await this.resolveTopicFilter(topic);
    const filter = `${topicFilter},${this.typeFilter()}`;
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
    const { filter: topicFilter } = await this.resolveTopicFilter(topic);
    const filter = [topicFilter, this.typeFilter(), `${dateFilter}:${since}`].join(",");
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
