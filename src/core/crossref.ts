/**
 * Crossref client — the free, unmetered second source.
 *
 * Crossref is the DOI registration agency: publishers deposit metadata there
 * when they mint a DOI, so it is the *source of record* rather than an
 * aggregate. See docs/openalex-dependency.md §0 for how it sits beside
 * OpenAlex and why these two and nothing else.
 *
 * What it is for here, both cases where OpenAlex is a poor fit:
 *
 *  1. **Title → DOI.** OpenAlex bills a title search as its most expensive
 *     call type, ten times a filter. Crossref answers the same question for
 *     free, in under 300ms.
 *  2. **Reference fallback.** When OpenAlex has no record of a paper — or its
 *     allowance is spent — Crossref's deposited `reference` array still yields
 *     edges. Only entries carrying a DOI are usable, which measured at roughly
 *     half: 23 of 49 on a real paper. Half the edges beats none.
 *
 * What it cannot do: inbound citations. Crossref does not offer them at all,
 * which is why adjacency selection stays OpenAlex-only.
 *
 * Terms, verified 2026-08-06: no signup, no key, no daily quota, and the
 * metadata is CC0 — so writing it into a user's notes is unencumbered.
 * Rate limits are advertised per response; measured at 1 req/s anonymous and
 * 3 req/s in the "polite pool", which you join simply by identifying yourself.
 */

import { DOI, makeId, normalizeDoi } from "./ids";
import { RateLimiter, buildUrl, getWithRetry, NotFoundError, type Transport } from "./http";
import { emptyWork, type Author, type Work, type WorkId } from "./types";

export const CROSSREF_BASE_URL = "https://api.crossref.org/works";

/** Crossref types that are papers. Its vocabulary differs from OpenAlex's. */
const TYPE_TO_ITEM_TYPE: Record<string, string> = {
  "journal-article": "journalArticle",
  "proceedings-article": "conferencePaper",
  "posted-content": "preprint",
  "book-chapter": "bookSection",
  book: "book",
  dissertation: "thesis",
  report: "report",
};

export interface CrossrefOptions {
  /**
   * Contact address for the "polite pool".
   *
   * Unlike OpenAlex's retired equivalent this one is current and does
   * something measurable — 3 req/s instead of 1. Optional, blank by default,
   * and never a hardcoded address.
   */
  mailto?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string" && entry.trim());
    return typeof first === "string" ? first.trim() : undefined;
  }
  return undefined;
}

function authorsFrom(list: unknown): Author[] {
  if (!Array.isArray(list)) return [];
  const authors: Author[] = [];
  for (const entry of list) {
    const family = firstString((entry as any)?.family);
    const given = firstString((entry as any)?.given);
    // A corporate author has `name` and no family/given.
    const name = firstString((entry as any)?.name);
    if (family) authors.push(given ? { firstName: given, lastName: family } : { lastName: family });
    else if (name) authors.push({ lastName: name });
  }
  return authors;
}

/** Crossref dates are `{"date-parts": [[2016, 6, 1]]}`, with month and day
 * optional — a year alone is common and must not become an invalid date. */
function dateFrom(data: any): string | undefined {
  const parts = data?.["date-parts"]?.[0];
  if (!Array.isArray(parts) || typeof parts[0] !== "number") return undefined;
  const [year, month, day] = parts;
  const pad = (value: unknown) => String(typeof value === "number" ? value : 1).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Crossref abstracts are JATS XML fragments, not plain text. Stripping tags is
 * enough for a readable note and avoids pulling an XML parser into this path.
 */
function abstractFrom(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/**
 * References, keeping only those that carry a DOI.
 *
 * A reference without an identifier cannot be matched against anything in the
 * vault — our citation index is id-based by design (no fuzzy matching), so an
 * unstructured string reference is not an edge we can draw.
 */
export function referencesFrom(list: unknown): WorkId[] {
  if (!Array.isArray(list)) return [];
  const ids: WorkId[] = [];
  for (const entry of list) {
    const doi = normalizeDoi((entry as any)?.DOI);
    if (doi && !ids.some((id) => id.value === doi)) ids.push(makeId(DOI, doi));
  }
  return ids;
}

export function workFromCrossref(data: any): Work | undefined {
  const doi = normalizeDoi(data?.DOI);
  if (!doi) return undefined;

  const work = emptyWork(doi);
  work.itemType = TYPE_TO_ITEM_TYPE[data.type] ?? "journalArticle";
  work.ids = [makeId(DOI, doi)];
  work.doi = doi;
  work.title = firstString(data.title);
  work.abstract = abstractFrom(data.abstract);
  work.date = dateFrom(data.issued) ?? dateFrom(data.published);
  work.url = firstString(data.URL);
  work.publication = firstString(data["container-title"]);
  work.authors = authorsFrom(data.author);
  work.references = referencesFrom(data.reference);
  work.source = "crossref";
  return work;
}

export class CrossrefClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly transport: Transport,
    private readonly options: CrossrefOptions = {},
  ) {
    // Measured: 1 req/s anonymous, 3 req/s polite. Pace to the slower of the
    // two unless we are identifying ourselves, and leave a little headroom.
    const polite = Boolean(options.mailto?.trim());
    this.limiter = new RateLimiter(options.minIntervalMs ?? (polite ? 400 : 1100), options.sleep);
  }

  private buildUrl(base: string, params: Record<string, string | undefined>): string {
    return buildUrl(base, { ...params, mailto: this.options.mailto || undefined });
  }

  private async getJson(url: string): Promise<any> {
    await this.limiter.wait();
    const body = await getWithRetry(this.transport, url, {
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
    });
    return JSON.parse(body);
  }

  /** One work, with its deposited reference list. */
  async workByDoi(doi: string): Promise<Work | undefined> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return undefined;
    try {
      const data = await this.getJson(this.buildUrl(`${CROSSREF_BASE_URL}/${normalized}`, {}));
      return workFromCrossref(data?.message);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  /**
   * Best-effort title lookup.
   *
   * `query.bibliographic` is Crossref's fuzzy citation matcher, so the top hit
   * is a *candidate*, never an answer — searching "Attention is all you need"
   * really does return "Is Attention All You Need?". Callers must corroborate
   * with `titlesMatch` before believing it, exactly as with OpenAlex.
   */
  async workByTitle(title: string): Promise<Work | undefined> {
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    const data = await this.getJson(
      this.buildUrl(CROSSREF_BASE_URL, { rows: "1", "query.bibliographic": trimmed }),
    );
    const first = data?.message?.items?.[0];
    return first ? workFromCrossref(first) : undefined;
  }

  /** Crossref has no batch endpoint, so this is one request per DOI — free,
   * but paced. Kept to the same shape as the OpenAlex client so either can
   * satisfy `ReferenceResolver`. */
  async worksByDois(dois: string[]): Promise<Work[]> {
    const works: Work[] = [];
    for (const doi of dois) {
      const work = await this.workByDoi(doi);
      if (work) works.push(work);
    }
    return works;
  }
}
