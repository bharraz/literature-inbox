/**
 * arXiv Atom API client.
 *
 * The freshest STEM stream — papers show up here days to weeks before
 * OpenAlex indexes them. arXiv gives no reference list, so arrivals from this
 * source start edge-less; `citation backfill` re-queries OpenAlex for them on
 * later runs, which is why every fetched work carries its `arxiv:` id (and
 * `doi:` when the entry declares one) for later matching.
 */

import { ARXIV, DOI, bareArxivId, makeId, normalizeDoi } from "./ids";
import { RateLimiter, buildUrl, getWithRetry, type Transport } from "./http";
import { childText, collapseWhitespace, parseXml } from "./xml";
import { emptyWork, type Author, type Work } from "./types";

export const ARXIV_BASE_URL = "http://export.arxiv.org/api/query";

function splitName(displayName: string): Author {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { lastName: parts[0] as string };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] as string };
}

export function workFromAtomEntry(entry: Element): Work | undefined {
  const rawId = childText(entry, "id");
  if (!rawId) return undefined;
  const arxivId = bareArxivId(rawId);
  const title = collapseWhitespace(childText(entry, "title"));
  if (!title) return undefined; // an entry with no title is unusable

  const work = emptyWork(arxivId);
  work.itemType = "preprint";
  work.ids = [makeId(ARXIV, arxivId)];

  // `arxiv:doi` is namespaced; getElementsByTagName matches the qualified
  // name in an XML document, so try both forms.
  const doi = normalizeDoi(childText(entry, "arxiv:doi") ?? childText(entry, "doi"));
  if (doi) {
    work.doi = doi;
    work.ids.push(makeId(DOI, doi));
  }

  work.title = title;
  work.abstract = collapseWhitespace(childText(entry, "summary"));
  const published = childText(entry, "published");
  work.date = published?.slice(0, 10);
  work.url = rawId;
  work.authors = Array.from(entry.getElementsByTagName("author"))
    .map((author) => collapseWhitespace(childText(author, "name")))
    .filter((name): name is string => Boolean(name))
    .map(splitName);
  work.source = "arxiv";
  return work;
}

export function parseAtomFeed(xml: string): Work[] {
  const doc = parseXml(xml);
  return Array.from(doc.getElementsByTagName("entry"))
    .map(workFromAtomEntry)
    .filter((work): work is Work => work !== undefined);
}

export interface ArxivOptions {
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ArxivClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly transport: Transport,
    private readonly options: ArxivOptions = {},
  ) {
    // arXiv asks for ~3s between requests; the default here is deliberately
    // slower than OpenAlex's for that reason.
    this.limiter = new RateLimiter(options.minIntervalMs ?? 3000, options.sleep);
  }

  private async fetch(url: string): Promise<string> {
    await this.limiter.wait();
    return getWithRetry(this.transport, url, {
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
    });
  }

  /** Most recent submissions in a category, e.g. `cs.CL`. */
  async categoryFeed(category: string, maxResults = 50): Promise<Work[]> {
    const url = buildUrl(ARXIV_BASE_URL, {
      search_query: `cat:${category}`,
      sortBy: "submittedDate",
      sortOrder: "descending",
      max_results: String(maxResults),
    });
    return parseAtomFeed(await this.fetch(url));
  }

  /** A single paper by arXiv id. */
  async workById(arxivId: string): Promise<Work | undefined> {
    const url = buildUrl(ARXIV_BASE_URL, {
      id_list: bareArxivId(arxivId),
      max_results: "1",
    });
    return parseAtomFeed(await this.fetch(url))[0];
  }
}
