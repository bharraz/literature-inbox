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
  workByDoi(doi: string): Promise<Work | undefined>;
  workByTitle(title: string): Promise<Work | undefined>;
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

  for (const candidate of candidates) {
    if (outcomes.length >= limit) break;
    if (candidate.hasEdges) continue;

    let resolved: Work | undefined;
    const doi = doiFrom(candidate.originIds);

    try {
      if (doi) {
        resolved = await resolver.workByDoi(doi);
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
