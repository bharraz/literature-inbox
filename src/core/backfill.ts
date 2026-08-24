/**
 * Citation backfill for arrivals that landed without edges.
 *
 * arXiv publishes no reference list at all, and an RSS item often resolves to
 * nothing richer than a title — so papers from those sources arrive as
 * isolated dots. That's the one case where the product's core promise
 * (arrivals wired into your graph) silently fails.
 *
 * OpenAlex usually indexes those papers within days, so re-asking on later
 * runs turns yesterday's isolated dot into a connected one. This is why the
 * inbox records every id a note is known by: an arXiv arrival keeps its
 * `arxiv:` id, which is what lets it be found again later.
 *
 * Never throws and never blocks a run: backfill is an improvement on what's
 * already there, so any failure just leaves the note as it is.
 */

import { ARXIV, DOI, OPENALEX, makeId, normalizeDoi } from "./ids";
import type { Work, WorkId } from "./types";

/**
 * arXiv mints a DOI for every submission, following a fixed pattern —
 * confirmed live: `2401.12345` resolves in OpenAlex as
 * `10.48550/arxiv.2401.12345`. An RSS-sourced arrival never carries this DOI
 * (RSS doesn't provide one), but it's fully computable from the bare arxiv
 * id alone, so an arxiv-only arrival can use the same cheap, batched DOI
 * lookup as anything with a real DOI — no per-item title search needed.
 * List+Filter is priced at roughly a tenth of Search per request (see
 * docs/openalex-dependency.md §2), and batches up to 50 ids into one request
 * regardless, so checking these on every run costs one shared credit rather
 * than one Search call per paper.
 */
export function arxivDerivedDoi(arxivId: string): string {
  return `10.48550/arxiv.${arxivId.toLowerCase()}`;
}

/** The narrow slice of the OpenAlex client this needs. */
export interface ReferenceResolver {
  /** Batched: one request per 50 DOIs rather than one per DOI. */
  worksByDois(dois: string[]): Promise<Work[]>;
  workByTitle(title: string): Promise<Work | undefined>;
}

/**
 * How long a title-only arrival stays on the backfill watchlist, counted
 * from the day it arrived — tracked entirely via `arrivedOn` and
 * `lastBackfillOn`, both already persisted on the inbox record, so there is
 * no separate attempt counter to keep in sync. A preprint OpenAlex hasn't
 * indexed within a month usually never will be, so the note is marked and
 * left alone past that point rather than asked about forever.
 */
export const BACKFILL_WINDOW_DAYS = 30;

export interface BackfillProgress {
  /** `YYYY-MM-DD` of the last lookup. */
  lastBackfillOn?: string;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Is this note due for another lookup? Once a day, for the first
 * `BACKFILL_WINDOW_DAYS` days after it arrived — no widening schedule, no
 * attempt count, just "still within the window and not already asked today".
 */
export function isDueForBackfill(
  progress: BackfillProgress,
  arrivedOn: string,
  today: string,
): boolean {
  if (progress.lastBackfillOn === today) return false;
  return daysBetween(arrivedOn, today) <= BACKFILL_WINDOW_DAYS;
}

/** True once the window has passed — the give-up, and the caller marks the
 * note so the user can see it was tried and failed rather than silently
 * skipped. */
export function hasGivenUp(arrivedOn: string, today: string): boolean {
  return daysBetween(arrivedOn, today) > BACKFILL_WINDOW_DAYS;
}

export interface BackfillCandidate {
  notePath: string;
  originIds: string[];
  title?: string;
  /** Whether the note currently has any citation edges. */
  hasEdges: boolean;
}

export interface BackfillOutcome {
  notePath: string;
  references: WorkId[];
  /** Ids learned during the lookup, to be merged into the note's identity. */
  newIds: string[];
}

function doiFrom(originIds: readonly string[]): string | undefined {
  const prefix = `${DOI}:`;
  const found = originIds.find((id) => id.startsWith(prefix));
  return found?.slice(prefix.length);
}

function arxivFrom(originIds: readonly string[]): string | undefined {
  const prefix = `${ARXIV}:`;
  const found = originIds.find((id) => id.startsWith(prefix));
  return found?.slice(prefix.length);
}

/** The DOI to look this candidate up by — its real one if it has one,
 * otherwise its arXiv-derived one. Exact either way, unlike a title guess. */
function doiToLookUp(originIds: readonly string[]): string | undefined {
  const real = doiFrom(originIds);
  if (real) return real;
  const arxivId = arxivFrom(originIds);
  return arxivId ? arxivDerivedDoi(arxivId) : undefined;
}

/**
 * Whether this candidate has an exact identifier to look up by (a real DOI,
 * or an arXiv id — see `arxivDerivedDoi`), as opposed to only a title guess.
 * The caller uses this to skip the widening retry schedule for these: they
 * resolve through the cheap, batched DOI lookup, so there's no cost reason to
 * make them wait — only the un-batchable title-search path needs rationing.
 */
export function hasExactIdentifier(originIds: readonly string[]): boolean {
  return doiToLookUp(originIds) !== undefined;
}

function alreadyKnown(originIds: readonly string[], candidate: string): boolean {
  return originIds.includes(candidate);
}

/**
 * Look up references for edge-less arrivals.
 *
 * Resolution order is deliberate: an exact identifier — a real DOI, or an
 * arXiv id's derived one — is tried first, batched into one cheap request; a
 * title lookup is a guess, costs an order of magnitude more per item (see
 * `arxivDerivedDoi`'s doc comment), and is only accepted when the returned
 * title actually matches, since attaching the wrong paper's references would
 * be worse than leaving the note bare.
 *
 * *limit* caps how many *title* lookups one run performs, since those are
 * the expensive, un-batchable ones — a large inbox full of DOI-less,
 * arxiv-less feed items is the one case that could still turn an update into
 * a many-request crawl. The batched DOI lookup covers everything with an
 * exact identifier regardless of how many there are.
 */
export async function backfillReferences(
  candidates: readonly BackfillCandidate[],
  resolver: ReferenceResolver,
  titlesMatchFn: (a: string | undefined, b: string | undefined) => boolean,
  limit = 25,
): Promise<BackfillOutcome[]> {
  const outcomes: BackfillOutcome[] = [];

  // Everything with an exact identifier resolves in one batched request
  // rather than one request each — the single biggest saving available here,
  // and unlike the title-search fallback below, not capped by `limit`: it's
  // one shared credit whether it covers 3 candidates or 50.
  const withDoi = candidates.filter(
    (candidate) => !candidate.hasEdges && doiToLookUp(candidate.originIds),
  );
  const byDoi = new Map<string, Work>();
  if (withDoi.length > 0) {
    try {
      const dois = withDoi.map((candidate) => doiToLookUp(candidate.originIds) as string);
      for (const work of await resolver.worksByDois(dois)) {
        const doi = normalizeDoi(work.doi);
        if (doi) byDoi.set(doi, work);
      }
    } catch {
      // A failed batch leaves every note in it exactly as it was.
    }
  }

  let titleLookups = 0;
  for (const candidate of candidates) {
    if (candidate.hasEdges) continue;

    let resolved: Work | undefined;
    const doi = doiToLookUp(candidate.originIds);

    try {
      if (doi) {
        // Both origin-id DOIs and arXiv-derived ones are already normalized.
        resolved = byDoi.get(doi);
      } else if (candidate.title) {
        if (titleLookups >= limit) continue;
        titleLookups += 1;
        const guess = await resolver.workByTitle(candidate.title);
        // Only trust a title lookup when the title genuinely matches.
        resolved = titlesMatchFn(guess?.title, candidate.title) ? guess : undefined;
      }
    } catch {
      continue; // a failed lookup leaves the note exactly as it was
    }

    if (!resolved || resolved.references.length === 0) continue;

    const newIds: string[] = [];
    const openAlexId = resolved.ids.find((id) => id.namespace === OPENALEX);
    if (openAlexId) {
      const serialized = `${OPENALEX}:${openAlexId.value}`;
      if (!alreadyKnown(candidate.originIds, serialized)) newIds.push(serialized);
    }
    const resolvedDoi = normalizeDoi(resolved.doi);
    if (resolvedDoi) {
      const serialized = `${DOI}:${resolvedDoi}`;
      if (!alreadyKnown(candidate.originIds, serialized)) newIds.push(serialized);
    }

    outcomes.push({
      notePath: candidate.notePath,
      references: resolved.references.map((ref) => makeId(ref.namespace, ref.value)),
      newIds,
    });
  }

  return outcomes;
}
