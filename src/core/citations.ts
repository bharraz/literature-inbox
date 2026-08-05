/**
 * Exact citation resolution — the plugin's only citation mechanism.
 *
 * Resolves a work's `references` against a corpus by id intersection: no PDF
 * parsing, no fuzzy matching, no ambiguity, nothing to review. That's the
 * whole reason this is viable in a mobile-compatible plugin, where the
 * PDF-text pipeline zot2vault uses would be out of the question.
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
