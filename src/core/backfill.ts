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

import { DOI, OPENALEX, makeId, normalizeDoi } from "./ids";
import type { Work, WorkId } from "./types";

/** The narrow slice of the OpenAlex client this needs. */
export interface ReferenceResolver {
  /** Batched: one request per 50 DOIs rather than one per DOI. */
  worksByDois(dois: string[]): Promise<Work[]>;
  workByTitle(title: string): Promise<Work | undefined>;
}

/**
 * When to re-ask about a paper that had no references last time.
 *
 * Days since the arrival, per attempt: the next day, a few days later, then
 * about a month. A preprint OpenAlex has not indexed within a day is often
 * indexed within a week; one still missing after a month usually never will
 * be. Three widening tries catch the realistic cases without re-querying every
 * isolated dot on every run forever — which is what this replaces, and which
 * cost roughly 25 requests per update indefinitely.
 */
export const BACKFILL_SCHEDULE_DAYS = [0, 4, 30];

export interface BackfillProgress {
  /** How many lookups have already been spent on this note. */
  backfillAttempts?: number;
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
 * Is this note due for another lookup?
 *
 * False once the schedule is exhausted — that is the give-up, and the caller
 * marks the note so the user can see it was tried and failed rather than
 * silently skipped.
 */
export function isDueForBackfill(
  progress: BackfillProgress,
  arrivedOn: string,
  today: string,
): boolean {
  const attempts = progress.backfillAttempts ?? 0;
  if (attempts >= BACKFILL_SCHEDULE_DAYS.length) return false;
  if (progress.lastBackfillOn === today) return false;
  const dueAfter = BACKFILL_SCHEDULE_DAYS[attempts] as number;
  return daysBetween(arrivedOn, today) >= dueAfter;
}

/** True once every scheduled attempt has been spent. */
export function hasGivenUp(progress: BackfillProgress): boolean {
  return (progress.backfillAttempts ?? 0) >= BACKFILL_SCHEDULE_DAYS.length;
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

function alreadyKnown(originIds: readonly string[], candidate: string): boolean {
  return originIds.includes(candidate);
}

/**
 * Look up references for edge-less arrivals.
 *
 * Resolution order is deliberate: a DOI is an exact identifier, so it's tried
 * first; a title lookup is a guess and is only accepted when the returned
 * title actually matches, since attaching the wrong paper's references would
 * be worse than leaving the note bare.
 *
 * *limit* caps how many lookups one run performs, so a large inbox doesn't
 * turn an update into a hundreds-of-requests crawl.
 */
export async function backfillReferences(
  candidates: readonly BackfillCandidate[],
  resolver: ReferenceResolver,
  titlesMatchFn: (a: string | undefined, b: string | undefined) => boolean,
  limit = 25,
): Promise<BackfillOutcome[]> {
  const outcomes: BackfillOutcome[] = [];

  // Everything with a DOI resolves in one batched request rather than one
  // request each — the single biggest saving available here.
  const withDoi = candidates
    .filter((candidate) => !candidate.hasEdges && doiFrom(candidate.originIds))
    .slice(0, limit);
  const byDoi = new Map<string, Work>();
  if (withDoi.length > 0) {
    try {
      const dois = withDoi.map((candidate) => doiFrom(candidate.originIds) as string);
      for (const work of await resolver.worksByDois(dois)) {
        const doi = normalizeDoi(work.doi);
        if (doi) byDoi.set(doi, work);
      }
    } catch {
      // A failed batch leaves every note in it exactly as it was.
    }
  }

  for (const candidate of candidates) {
    if (outcomes.length >= limit) break;
    if (candidate.hasEdges) continue;

    let resolved: Work | undefined;
    const doi = doiFrom(candidate.originIds);

    try {
      if (doi) {
        resolved = byDoi.get(doi);
      } else if (candidate.title) {
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
