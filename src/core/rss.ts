/**
 * Bring-your-own RSS/Atom feed source — journal TOCs, bioRxiv, Scholar alerts.
 *
 * The ergonomic win: researchers already curate feeds. The differentiator over
 * a generic RSS reader is that items become *citation-graph-connected notes*
 * rather than a list of titles — which requires an identity we can match on.
 *
 * Identity, in order of preference (docs/interop-spec.md §3.1):
 *   1. `doi:` — from the item's own fields where the feed publishes one,
 *      otherwise resolved later via an OpenAlex title lookup. This is what
 *      lets an RSS arrival dedup against the rest of the vault and gain real
 *      citation edges.
 *   2. `arxiv:` — extracted from the link for arXiv-backed feeds.
 *   3. `rss:<guid>` — the feed standard's own stable per-item id.
 *   4. `url:<link>` — last resort for feeds that publish no guid.
 *
 * Items that resolve to nothing richer than a guid still arrive, as shallow
 * edge-less nodes. Dropping them would silently lose papers, which is worse
 * than showing an unconnected dot.
 */

import { ARXIV, DOI, RSS, URL_NS, bareArxivId, makeId, normalizeDoi } from "./ids";
import { getWithRetry, type Transport } from "./http";
import { childText, collapseWhitespace, parseXml } from "./xml";
import { emptyWork, type Work } from "./types";

/** A DOI appearing anywhere in free text (description, guid, link). The
 * trailing-punctuation trim matters: feeds routinely end a sentence right
 * after the DOI, and `10.1234/foo.` is not the same identifier. */
const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"'<>)\]]+)/i;

export function extractDoiFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(DOI_IN_TEXT);
  if (!match?.[1]) return undefined;
  return normalizeDoi(match[1].replace(/[.,;:)\]]+$/, ""));
}

export function extractArxivIdFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/arxiv\.org\/(?:abs|pdf)\/([^\s"'<>)\]]+)/i);
  if (!match?.[1]) return undefined;
  return bareArxivId(match[1].replace(/\.pdf$/i, ""));
}

/** Strip tags from an HTML-bearing description without pulling in a parser. */
function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return collapseWhitespace(value.replace(/<[^>]*>/g, " "));
}

function firstDefined(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

/** RSS 2.0 `pubDate` and Atom `updated`/`published` both reduce to YYYY-MM-DD. */
function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const match = raw.match(/(\d{4}-\d{2}-\d{2})/);
    return match?.[1];
  }
  return parsed.toISOString().slice(0, 10);
}

function linkOf(item: Element): string | undefined {
  const plain = childText(item, "link");
  if (plain) return plain;
  // Atom puts the URL in an attribute rather than the element text.
  const atomLink = item.getElementsByTagName("link")[0];
  return atomLink?.getAttribute("href") ?? undefined;
}

export function workFromFeedItem(item: Element): Work | undefined {
  const title = collapseWhitespace(childText(item, "title"));
  if (!title) return undefined;

  const link = linkOf(item);
  const guid = childText(item, "guid") ?? childText(item, "id");
  const description = stripHtml(
    firstDefined(childText(item, "description"), childText(item, "summary"), childText(item, "content")),
  );
  const searchable = [description, guid, link].filter(Boolean).join(" ");

  const doi = firstDefined(
    extractDoiFromText(childText(item, "prism:doi")),
    extractDoiFromText(childText(item, "dc:identifier")),
    extractDoiFromText(searchable),
  );
  const arxivId = extractArxivIdFromText(searchable);

  const key = doi ?? arxivId ?? guid ?? link ?? title;
  const work = emptyWork(key);
  work.itemType = "preprint";
  work.title = title;
  work.abstract = description;
  work.url = link;
  work.date = toIsoDate(
    firstDefined(childText(item, "pubDate"), childText(item, "published"), childText(item, "updated")),
  );
  work.source = "rss";

  if (doi) {
    work.doi = doi;
    work.ids.push(makeId(DOI, doi));
  }
  if (arxivId) work.ids.push(makeId(ARXIV, arxivId));
  if (guid) work.ids.push(makeId(RSS, guid));
  else if (link) work.ids.push(makeId(URL_NS, link));

  return work;
}

/** Parse an RSS 2.0 or Atom feed. Both shapes are handled because "bring your
 * own feed URL" means having no say in which one you get. */
export function parseFeed(xml: string): Work[] {
  const doc = parseXml(xml);
  const items = [
    ...Array.from(doc.getElementsByTagName("item")),      // RSS 2.0
    ...Array.from(doc.getElementsByTagName("entry")),     // Atom
  ];
  return items
    .map(workFromFeedItem)
    .filter((work): work is Work => work !== undefined);
}

/** Something that can turn a title into a DOI-bearing record — the OpenAlex
 * client in practice, narrowed to a one-method interface so this module stays
 * testable without one. */
export interface TitleResolver {
  workByTitle(title: string): Promise<Work | undefined>;
}

/**
 * Attach a `doi:` to feed items that arrived without one, by looking the title
 * up on OpenAlex. Only accepts a hit whose title actually matches — a
 * near-miss would attach the wrong identity to the note, which is far worse
 * than leaving it shallow.
 *
 * Never throws: a lookup failure leaves the item as-is, because "this arrival
 * has no edges yet" is a fine outcome and a failed run is not.
 */
export async function backfillDois(
  works: Work[],
  resolver: TitleResolver,
  titlesMatchFn: (a: string | undefined, b: string | undefined) => boolean,
): Promise<number> {
  let resolved = 0;
  for (const work of works) {
    if (work.doi || !work.title) continue;
    let candidate: Work | undefined;
    try {
      candidate = await resolver.workByTitle(work.title);
    } catch {
      continue;
    }
    if (!candidate?.doi || !titlesMatchFn(candidate.title, work.title)) continue;
    work.doi = candidate.doi;
    work.ids.unshift(makeId(DOI, candidate.doi));
    // Take the reference list too — this is what turns a shallow RSS node
    // into one wired into the graph.
    if (candidate.references.length > 0) work.references = candidate.references;
    for (const id of candidate.ids) {
      if (!work.ids.some((existing) => existing.namespace === id.namespace && existing.value === id.value)) {
        work.ids.push(id);
      }
    }
    resolved += 1;
  }
  return resolved;
}

export async function fetchFeed(transport: Transport, url: string): Promise<Work[]> {
  return parseFeed(await getWithRetry(transport, url));
}
