/**
 * Origin ids and title normalization.
 *
 * This is the identity layer the whole dedup story rests on: every fetched
 * paper is matched against the vault by id first, and only falls back to a
 * normalized, distinctive title when no id overlaps at all.
 */

import type { Work, WorkId } from "./types";

export const DOI = "doi";
export const ZOTERO = "zotero";
export const OPENALEX = "openalex";
export const ARXIV = "arxiv";
export const RSS = "rss";
export const URL_NS = "url";
export const AUTHOR = "author";

export function serializeId(id: WorkId): string {
  return `${id.namespace}:${id.value}`;
}

export function makeId(namespace: string, value: string): WorkId {
  return { namespace, value };
}

/** Strip any `doi.org` prefix and lowercase. Returns undefined for blanks so
 * callers can pipe optional metadata straight through. */
export function normalizeDoi(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let doi = raw.trim();
  for (const prefix of ["https://doi.org/", "http://doi.org/"]) {
    if (doi.toLowerCase().startsWith(prefix)) {
      doi = doi.slice(prefix.length);
      break;
    }
  }
  doi = doi.toLowerCase();
  return doi || undefined;
}

/** `"https://openalex.org/W2963403868"` -> `"W2963403868"`. */
export function bareOpenAlexId(fullId: string): string {
  const parts = fullId.split("/");
  return parts[parts.length - 1] ?? fullId;
}

/** `"http://arxiv.org/abs/2607.15277v1"` -> `"2607.15277"` (URL and version
 * suffix both dropped, so the same paper doesn't arrive twice as v1 and v2). */
export function bareArxivId(fullId: string): string {
  const parts = fullId.split("/");
  const tail = parts[parts.length - 1] ?? fullId;
  const lastV = tail.lastIndexOf("v");
  if (lastV > 0) {
    const version = tail.slice(lastV + 1);
    if (version.length > 0 && /^\d+$/.test(version)) return tail.slice(0, lastV);
  }
  return tail;
}

/**
 * Every identity a work is known by, `doi:` first — spec §3.2.
 *
 * All of them, not one preferred id: the two tools sharing a vault rarely
 * learn the same single id for a paper, so recording only a favourite meant a
 * DOI-less item could never match anything the other side had and duplicated
 * silently.
 */
export function originIds(work: Work): string[] {
  const ids: string[] = [];
  const doi = normalizeDoi(work.doi);
  if (doi) ids.push(`${DOI}:${doi}`);
  for (const id of work.ids) {
    const serialized = serializeId(id);
    if (!ids.includes(serialized)) ids.push(serialized);
  }
  return ids.length > 0 ? ids : [`key:${work.key}`];
}

/** True when two id sets refer to the same work (any overlap) — spec §3.2. */
export function idsIntersect(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

/**
 * Fold a title to a comparable key: lowercase, alphanumerics only — spec §3.3.
 *
 * The last-resort identity match, deliberately *behind* id matching: titles
 * are not unique in principle ("Introduction", "Preface"), so a title-only hit
 * should be corroborated (year, first author) before being treated as the same
 * work. See `titlesMatch`.
 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Normalized-title equality. Exactly the spec's `find_by_title` rule and
 * nothing more — no heuristics layered in, because this half must stay
 * byte-compatible with the other implementation.
 *
 * Whether a title-only hit is *trustworthy* is a separate question; see
 * `isDistinctiveTitle`, which is policy rather than format.
 */
export function titlesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeTitle(a) === normalizeTitle(b);
}

/**
 * Whether a title is distinctive enough to identify a work *on its own*.
 *
 * Dedup policy, deliberately not part of `titlesMatch` (which must mirror the
 * spec exactly). Generic titles — "Preface", "Introduction", "Editorial
 * Board", "Supplementary Material" — collide across unrelated papers, and the
 * manifest carries no year or authors to corroborate against. Requiring three
 * words filters those out while keeping real titles ("Deep Residual
 * Learning"); the length floor catches three very short words.
 */
export function isDistinctiveTitle(title: string | undefined): boolean {
  if (!title) return false;
  const words = title.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 && normalizeTitle(title).length >= 12;
}
