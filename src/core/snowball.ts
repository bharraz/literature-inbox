/**
 * Growing a starting graph outward from papers the user named.
 *
 * A topic search gives you the field's canon. A snowball gives you *your*
 * neighbourhood: take the handful of papers someone actually cares about, pull
 * what they cite and what cites them, and you get a core centred on their work
 * rather than on whatever is most famous. The two directions do different
 * jobs — references reach backward into the foundations a paper was built on,
 * citers reach forward into what came of it — so both are on by default.
 *
 * Pure policy behind a resolver interface, so the whole expansion is tested
 * without a network.
 */

import { OPENALEX, idsIntersect, originIds } from "./ids";
import type { Work } from "./types";

export interface SnowballResolver {
  /** Best-effort lookup by bare OpenAlex id — some ids simply won't resolve. */
  worksByIds(ids: string[]): Promise<Work[]>;
  /** Works citing any of *ids*, most-cited first. */
  worksCiting(ids: string[], limit: number): Promise<Work[]>;
}

export interface SnowballInput {
  seeds: Work[];
  resolver: SnowballResolver;
  /** Ceiling on works added *beyond* the seeds. */
  limit: number;
  includeReferences?: boolean;
  includeCiters?: boolean;
  /** Called between the two network phases, so a slow run can show progress. */
  onProgress?: (phase: "references" | "citers", found: number) => void;
}

export interface SnowballReport {
  /** Seeds first, then everything discovered — the caller writes these. */
  works: Work[];
  seedCount: number;
  referenceCount: number;
  citerCount: number;
  /** Expansion is best-effort; a failed phase is reported, never thrown. */
  errors: string[];
}

/** Bare OpenAlex ids for a work, which is the only id `cites:` and the id
 * lookup accept. */
function openAlexIds(works: readonly Work[]): string[] {
  const ids: string[] = [];
  for (const work of works) {
    for (const id of work.ids) {
      if (id.namespace === OPENALEX && !ids.includes(id.value)) ids.push(id.value);
    }
  }
  return ids;
}

/**
 * Accumulates works while rejecting anything already held, by id intersection
 * rather than by key — the same paper reached via a reference and via a citer
 * arrives as two records with different keys but overlapping ids.
 */
class WorkSet {
  private readonly ids: string[][] = [];
  readonly works: Work[] = [];

  add(work: Work): boolean {
    const ids = originIds(work);
    if (this.ids.some((held) => idsIntersect(held, ids))) return false;
    this.ids.push(ids);
    this.works.push(work);
    return true;
  }
}

export async function snowball(input: SnowballInput): Promise<SnowballReport> {
  const { seeds, resolver, limit } = input;
  const includeReferences = input.includeReferences ?? true;
  const includeCiters = input.includeCiters ?? true;

  const collected = new WorkSet();
  for (const seed of seeds) collected.add(seed);

  const report: SnowballReport = {
    works: collected.works,
    seedCount: collected.works.length,
    referenceCount: 0,
    citerCount: 0,
    errors: [],
  };
  if (limit <= 0 || seeds.length === 0) return report;

  // Split the budget: references first because they are one cheap batched
  // lookup and are what make the seeds cohere into a graph, then citers with
  // whatever is left.
  const referenceBudget = includeReferences && includeCiters ? Math.ceil(limit / 2) : limit;

  if (includeReferences) {
    const wanted: string[] = [];
    for (const seed of seeds) {
      for (const reference of seed.references) {
        if (reference.namespace !== OPENALEX) continue;
        if (!wanted.includes(reference.value)) wanted.push(reference.value);
      }
    }
    if (wanted.length > 0) {
      try {
        for (const work of await resolver.worksByIds(wanted.slice(0, referenceBudget))) {
          if (report.referenceCount >= referenceBudget) break;
          if (collected.add(work)) report.referenceCount += 1;
        }
      } catch (error) {
        report.errors.push(`references: ${String(error)}`);
      }
    }
    input.onProgress?.("references", report.referenceCount);
  }

  if (includeCiters) {
    const remaining = limit - report.referenceCount;
    if (remaining > 0) {
      try {
        const ids = openAlexIds(seeds);
        for (const work of await resolver.worksCiting(ids, remaining)) {
          if (report.citerCount >= remaining) break;
          if (collected.add(work)) report.citerCount += 1;
        }
      } catch (error) {
        report.errors.push(`citers: ${String(error)}`);
      }
    }
    input.onProgress?.("citers", report.citerCount);
  }

  return report;
}
