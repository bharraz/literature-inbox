/**
 * Exact citation resolution — the plugin's only citation mechanism.
 *
 * Resolves a work's `references` against a corpus by id intersection: no PDF
 * parsing, no fuzzy matching, no ambiguity, nothing to review. That's also
 * what keeps this viable in a mobile-compatible plugin, where a PDF-text
 * pipeline would be out of the question.
 *
 * References that resolve to nothing are simply not edges — they're papers
 * outside the vault, which is the normal case for most of a bibliography and
 * emphatically not an error worth reporting per-reference.
 */

import { serializeId } from "./ids";
import type { Work, WorkId } from "./types";

export interface CitationEdge {
  /** Note filename (no extension) of the citing work. */
  sourceKey: string;
  /** Note filename (no extension) of the cited work. */
  targetKey: string;
}

/**
 * An id -> note-filename lookup covering everything already in the vault plus
 * everything arriving this run, so a new paper links to old notes *and* to its
 * fellow arrivals.
 */
export class CitationIndex {
  private readonly byId = new Map<string, string>();

  /** Register a note under every id it is known by. */
  add(originIds: readonly string[], noteName: string): void {
    for (const id of originIds) {
      if (!this.byId.has(id)) this.byId.set(id, noteName);
    }
  }

  lookup(id: WorkId): string | undefined {
    return this.byId.get(serializeId(id));
  }

  /** Same lookup, for an id already serialized to `namespace:value` — the
   * form both `originIds()` and a persisted `ReferenceRecord` use. */
  lookupRaw(id: string): string | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }
}

export interface ResolutionResult {
  edges: CitationEdge[];
  /** How many of the work's references pointed outside the vault. A count
   * only: listing them individually would flood any report, since a real
   * bibliography is mostly papers you don't have. */
  unresolvedCount: number;
}

export function resolveCitations(
  work: Work,
  noteName: string,
  index: CitationIndex,
): ResolutionResult {
  const edges: CitationEdge[] = [];
  const seen = new Set<string>();
  let unresolvedCount = 0;

  for (const reference of work.references) {
    const target = index.lookup(reference);
    if (!target) {
      unresolvedCount += 1;
      continue;
    }
    if (target === noteName) continue; // never link a note to itself
    if (seen.has(target)) continue;    // one edge per target, not per reference
    seen.add(target);
    edges.push({ sourceKey: noteName, targetKey: target });
  }
  return { edges, unresolvedCount };
}

/**
 * A paper's own reference list, captured once — at the moment its note is
 * first written — and persisted outside the vault (in plugin data, next to
 * `previouslyRemoved`). Nothing else remembers this: a note only ever
 * carries the edges that already resolved *when it was written*, so without
 * a persisted copy, a paper that arrives later but was actually cited by
 * something you kept months ago could never be linked back to it — that
 * would need re-fetching every kept paper's references on every run just to
 * ask "did any of you cite today's new arrivals?".
 */
export interface ReferenceRecord {
  /** The citing paper's own origin ids, so it can be found in a *future*
   * index even after this run ends. */
  ids: string[];
  /** That paper's references, pre-serialized to the same `namespace:value`
   * strings origin ids use, so they compare directly with no id object. */
  references: string[];
  /** The citing paper's own publication date (`YYYY-MM-DD`), when known —
   * used only to reject an impossible edge (see `retroactiveEdges`). */
  date?: string;
}

/**
 * Edges from a paper already known (but not re-fetched this run) to a paper
 * arriving *today* that it turns out to cite — the reverse of the normal
 * forward pass, which only ever asks "what does today's arrival cite".
 *
 * Restricted to targets in `newNoteNames`: an edge between two papers that
 * were both already known would have been created already, on whichever of
 * the two arrived second — recomputing the whole persisted set against
 * itself every run would be pure waste for no new edges.
 *
 * A citation can only point backward in time — a paper can't reference
 * something that didn't exist yet — so an edge is rejected whenever the
 * arrival's own date is *after* the citing paper's. This is a correctness
 * check first (an index collision or a mismatched record would otherwise
 * produce a nonsense edge) and a cheap one to skip early, before either side
 * is rewritten. Permissive when a date is missing on either side: an absent
 * date is not evidence of anything, so the edge stands rather than being
 * dropped on a technicality.
 */
export function retroactiveEdges(
  records: readonly ReferenceRecord[],
  index: CitationIndex,
  newNoteNames: ReadonlySet<string>,
  targetDates: ReadonlyMap<string, string | undefined>,
): CitationEdge[] {
  const edges: CitationEdge[] = [];
  for (const record of records) {
    let sourceKey: string | undefined;
    for (const id of record.ids) {
      sourceKey = index.lookupRaw(id);
      if (sourceKey) break;
    }
    if (!sourceKey) continue; // that paper's note no longer exists — nothing to link from
    for (const reference of record.references) {
      const targetKey = index.lookupRaw(reference);
      if (!targetKey || targetKey === sourceKey || !newNoteNames.has(targetKey)) continue;
      const targetDate = targetDates.get(targetKey);
      if (record.date && targetDate && targetDate > record.date) continue; // cites the future
      edges.push({ sourceKey, targetKey });
    }
  }
  return edges;
}

/** Invert edges into a per-note "cited by" map, so an existing paper can show
 * which new arrivals reference it. */
export function citedByMap(edges: readonly CitationEdge[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = result.get(edge.targetKey);
    if (existing) {
      if (!existing.includes(edge.sourceKey)) existing.push(edge.sourceKey);
    } else {
      result.set(edge.targetKey, [edge.sourceKey]);
    }
  }
  return result;
}
