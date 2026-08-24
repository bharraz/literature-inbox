/**
 * Parsing a pasted list of paper identifiers.
 *
 * This is the input to every "build me a graph from papers I already care
 * about" path, and the input is whatever the user had on their clipboard: a
 * bibliography column, a few browser URLs, a mix of DOIs and arXiv ids, with
 * or without prefixes. Being liberal here is the difference between the
 * feature working and the user hand-cleaning a list.
 *
 * Anything unrecognised is *returned*, never silently dropped — a typo that
 * vanishes without comment is how you end up wondering why your graph is
 * missing a paper.
 */

import { normalizeDoi } from "./ids";

export interface SeedList {
  dois: string[];
  arxivIds: string[];
  /** Entries that matched no known identifier shape, in the order given. */
  unrecognised: string[];
}

/** `10.1234/foo`, the shape every registered DOI has. */
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** Modern arXiv (`2401.12345`) and the pre-2007 scheme (`hep-th/9901001`). */
const ARXIV_NEW = /^\d{4}\.\d{4,5}$/;
const ARXIV_OLD = /^[a-z-]+(\.[A-Za-z]{2})?\/\d{7}$/;

/**
 * arXiv mints its own DOIs under the `10.48550` prefix.
 *
 * These look like ordinary DOIs and are not: they are registered with
 * **DataCite**, so Crossref answers 404, and OpenAlex often has no record of a
 * fresh preprint either. The arXiv id is right there inside the string, and
 * arXiv's own API resolves it every time — so unwrap it rather than sending a
 * doomed DOI lookup. (Cost a real "why didn't this work": a pasted
 * `https://doi.org/10.48550/arXiv.2608.04079` failed against both DOI sources
 * while the paper sat happily on arXiv.)
 */
const ARXIV_DOI = /^10\.48550\/arxiv\.(\S+)$/i;

/**
 * Split on newlines and whitespace, but **not** on commas: a comma is legal
 * inside a DOI, and splitting on it would quietly corrupt one. A pasted
 * comma-separated list still works, because the separator is almost always
 * ", " and the trailing comma is stripped below.
 *
 * A trailing period is stripped too, for the same reason: pasting a
 * bibliography straight from Zotero's "Create Bibliography from Items" (copy
 * to clipboard, a style that includes DOIs) ends every entry's DOI URL with
 * the reference's own closing period — `https://doi.org/10.1234/example.` —
 * and no real DOI ends in one.
 */
function tokenize(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((token) => token.replace(/[;,.]+$/, "").trim())
    .filter(Boolean);
}

/** Strip the prefixes people paste around an arXiv id, including a version
 * suffix — `2401.12345v3` and `2401.12345` are the same paper. */
function asArxivId(token: string): string | undefined {
  let value = arxivIdFromDoi(token) ?? token.trim();
  // `abs`, `pdf` and `html` are all real arXiv URL shapes, and people paste
  // whichever tab they had open. Stopping at `?` or `#` matters: a link copied
  // from a browser routinely carries `?context=quant-ph` or `#comments`, and
  // including that in the id makes it match nothing.
  const urlMatch = value.match(/arxiv\.org\/(?:abs|pdf|html)\/([^\s?#]+)/i);
  if (urlMatch?.[1]) value = urlMatch[1];
  value = value
    .replace(/^arxiv:/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/\/+$/, "");
  // Strip the version in place rather than via `bareArxivId`, which also takes
  // the last path segment — that would turn `hep-th/9901001` into `9901001`
  // and lose the archive half of a pre-2007 id.
  value = value.replace(/v\d+$/, "");
  if (ARXIV_NEW.test(value) || ARXIV_OLD.test(value)) return value;
  return undefined;
}

function asDoi(token: string): string | undefined {
  const value = normalizeDoi(token.replace(/^doi:/i, ""));
  if (!value || !DOI_PATTERN.test(value)) return undefined;
  // An arXiv-minted DOI is an arXiv id wearing a costume — see ARXIV_DOI.
  if (ARXIV_DOI.test(value)) return undefined;
  return value;
}

/** The arXiv id inside an arXiv-minted DOI, if that is what this is. */
function arxivIdFromDoi(token: string): string | undefined {
  const value = normalizeDoi(token.replace(/^doi:/i, ""));
  const match = value?.match(ARXIV_DOI);
  return match?.[1];
}

/**
 * Classify each entry, de-duplicating within each kind so pasting the same
 * paper twice doesn't cost two API lookups.
 */
export function parseSeedList(raw: string): SeedList {
  const dois: string[] = [];
  const arxivIds: string[] = [];
  const unrecognised: string[] = [];
  const seen = new Set<string>();

  for (const token of tokenize(raw)) {
    // DOI first: an arXiv-hosted paper with a DOI should be looked up by the
    // DOI, which is the identifier both tools are most likely to share.
    const doi = asDoi(token);
    if (doi) {
      if (!seen.has(`doi:${doi}`)) {
        seen.add(`doi:${doi}`);
        dois.push(doi);
      }
      continue;
    }
    const arxivId = asArxivId(token);
    if (arxivId) {
      if (!seen.has(`arxiv:${arxivId}`)) {
        seen.add(`arxiv:${arxivId}`);
        arxivIds.push(arxivId);
      }
      continue;
    }
    unrecognised.push(token);
  }

  return { dois, arxivIds, unrecognised };
}

/** Total identifiers understood — what the caller reports back as "N papers
 * to look up". */
export function seedCount(list: SeedList): number {
  return list.dois.length + list.arxivIds.length;
}

/**
 * Turn the vault's own notes into seeds, for expanding outward from a library
 * the user already has.
 *
 * Prefers the OpenAlex id where a note carries one, because that resolves in a
 * single batched lookup; falls back to the DOI. Notes with neither are skipped
 * — they cannot be looked up, and there is nothing to report to the user that
 * they could act on.
 *
 * `limit` caps how many notes are used as seeds. A 2,000-paper library would
 * otherwise issue an enormous expansion, and the marginal seed adds very
 * little once the core is dense.
 */
export function seedsFromOriginIds(
  originIdSets: readonly (readonly string[])[],
  limit: number,
): { openAlexIds: string[]; dois: string[] } {
  const openAlexIds: string[] = [];
  const dois: string[] = [];

  for (const ids of originIdSets) {
    if (openAlexIds.length + dois.length >= limit) break;
    const openAlex = ids.find((id) => id.startsWith("openalex:"))?.slice("openalex:".length);
    if (openAlex) {
      if (!openAlexIds.includes(openAlex)) openAlexIds.push(openAlex);
      continue;
    }
    const doi = ids.find((id) => id.startsWith("doi:"))?.slice("doi:".length);
    if (doi && !dois.includes(doi)) dois.push(doi);
  }

  return { openAlexIds, dois };
}
