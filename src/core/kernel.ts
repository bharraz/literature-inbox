/**
 * The kernel run: build the starting graph.
 *
 * Why this exists. On an empty vault, arrivals have nothing to connect to —
 * every new paper lands as an isolated dot, the "why you're seeing this"
 * signal never fires, and the product's whole premise is invisible. The most
 * cited papers in a field are also the ones everything else cites, so
 * fetching a few hundred of them produces a densely connected core that later
 * arrivals attach themselves to. That core *is* the triage surface.
 *
 * These notes go straight into the papers folder, not the inbox: they are
 * reference material the user chose to seed, not arrivals awaiting a verdict,
 * so they are never subject to the keep window or cleanup. Consistent with
 * the rest of the design, that's expressed purely by which folder they're in.
 *
 * Run once, or again later with a bigger N or a different topic — it skips
 * anything already present, so re-running is additive rather than duplicating.
 */

import { CitationIndex, resolveCitations, type ReferenceRecord } from "./citations";
import { FilenameAllocator } from "./filenames";
import { idsIntersect, isDistinctiveTitle, normalizeTitle, originIds, serializeId } from "./ids";
import { renderInboxNote, type AuthorPlacement, type SubjectOptions } from "./notes";
import type { VaultAdapter } from "./update";
import type { VaultIndex } from "./vault-state";
import type { Work } from "./types";

export interface KernelReport {
  written: { title: string; notePath: string; edgeCount: number }[];
  skipped: number;
  /** Edges among the seeded papers — the density of the starting graph. */
  totalEdges: number;
  /** One record per paper written, for the caller to fold into its
   * persisted `referenceIndex` (see `core/update.ts`) — a kernel-seeded
   * paper is just as valid a source of a future retroactive edge as any
   * other kept paper. */
  newReferenceRecords: ReferenceRecord[];
}

export interface KernelRunInput {
  works: Work[];
  vault: VaultIndex;
  papersFolder: string;
  adapter: VaultAdapter;
  today: string;
  authorPlacement?: AuthorPlacement;
  subjects?: SubjectOptions;
  readStatus?: string;
  /**
   * Cap on how many of `works` get written. When set and there are more
   * candidates than this, half the slots go to the highest-impact candidates
   * regardless of connectivity (the field's classics — a pure-connectivity
   * sort can bury a famous, loosely-cited-within-this-batch paper under
   * obscure ones that happen to interlink) and the rest go to whichever
   * remaining candidates connect best to what's already selected. Unset means
   * "write everything accepted", the old behaviour, for modes (seeds,
   * snowball, library) where the caller already fetched exactly what it
   * wants.
   */
  targetCount?: number;
  /** Called as notes are written, so a long run can show progress. */
  onProgress?: (written: number, total: number) => void;
}

const EMPTY_NEIGHBORS: ReadonlySet<string> = new Set();

/**
 * Anchors first — the first `ceil(targetCount / 2)` of `orderedIds`,
 * guaranteed regardless of connectivity, since `orderedIds` arrives in
 * citation-rank order and these are the field's classics. Then greedily fill
 * the rest with whichever remaining candidate connects to the most of what's
 * already selected, so fill picks cluster around the anchors instead of
 * forming their own disconnected pocket elsewhere in the pool. Ties go to
 * the higher citation rank throughout.
 */
function selectBalanced(
  orderedIds: readonly string[],
  targetCount: number,
  neighborsOf: (id: string) => ReadonlySet<string>,
): string[] {
  if (orderedIds.length <= targetCount) return [...orderedIds];

  const anchorCount = Math.min(targetCount, Math.ceil(targetCount / 2));
  const selected = orderedIds.slice(0, anchorCount);
  const selectedSet = new Set(selected);
  const pool = orderedIds.slice(anchorCount);

  while (selected.length < targetCount && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      let score = 0;
      for (const neighbor of neighborsOf(pool[i])) if (selectedSet.has(neighbor)) score += 1;
      // Strict >, and pool is still in citation-rank order, so the first
      // candidate to reach a new best score is also the tiebreak winner.
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    selected.push(chosen);
    selectedSet.add(chosen);
  }

  return selected;
}

/** Undirected adjacency from a directed "cites" map — a link either way
 * counts as a connection for selection purposes. */
function undirectedAdjacency(citesByKey: ReadonlyMap<string, string[]>): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const [source, targets] of citesByKey) {
    for (const target of targets) {
      link(source, target);
      link(target, source);
    }
  }
  return adjacency;
}

export async function runKernel(input: KernelRunInput): Promise<KernelReport> {
  const { works, vault, papersFolder, adapter, today } = input;
  const report: KernelReport = {
    written: [],
    skipped: 0,
    totalEdges: 0,
    newReferenceRecords: [],
  };

  const allocator = new FilenameAllocator();
  for (const name of vault.noteBaseNames()) allocator.reserve(name);

  const accepted: { work: Work; noteName: string; ids: string[] }[] = [];
  for (const work of works) {
    const ids = originIds(work);

    // Already in the vault, or already seeded by an earlier kernel run.
    if (vault.findByOrigin(ids)) {
      report.skipped += 1;
      continue;
    }
    if (isDistinctiveTitle(work.title) && vault.findByTitle(normalizeTitle(work.title as string))) {
      report.skipped += 1;
      continue;
    }
    if (accepted.some((entry) => idsIntersect(ids, entry.ids))) {
      report.skipped += 1;
      continue;
    }

    const { filename } = allocator.allocate(work);
    accepted.push({ work, noteName: filename, ids });
  }

  // Index the papers already in the vault *and* everything being seeded, so
  // the kernel's internal citations resolve — that mutual citation is exactly
  // what makes a top-cited set into a connected graph rather than a list.
  const index = new CitationIndex();
  const vaultNoteNames = new Set<string>();
  for (const entry of vault.entriesForIndex()) {
    const base = entry.notePath.split("/").pop();
    if (base?.endsWith(".md")) {
      const noteName = base.slice(0, -3);
      index.add(entry.originIds, noteName);
      vaultNoteNames.add(noteName);
    }
  }
  for (const entry of accepted) index.add(entry.ids, entry.noteName);

  const citesByNote = new Map<string, string[]>();
  for (const entry of accepted) {
    const { edges } = resolveCitations(entry.work, entry.noteName, index);
    if (edges.length > 0) {
      citesByNote.set(entry.noteName, edges.map((edge) => edge.targetKey));
    }
  }

  // "Cited by" is worth the extra pass here (unlike a normal update, where
  // arrivals rarely cite each other): in a top-cited set the inbound links are
  // most of what makes the graph readable.
  const citedByNote = new Map<string, string[]>();
  for (const [source, targets] of citesByNote) {
    for (const target of targets) {
      const list = citedByNote.get(target);
      if (list) list.push(source);
      else citedByNote.set(target, [source]);
    }
  }

  // Trim to a balanced subset when the caller over-fetched a larger pool
  // than it wants written (topic mode: "most cited" alone can surface a
  // mutually disconnected set for a narrow or recent field, and pure
  // connectivity can bury the field's classics under obscure interlinked
  // ones — see roadmap.md).
  let selected = accepted;
  if (input.targetCount !== undefined && accepted.length > input.targetCount) {
    const adjacency = undirectedAdjacency(citesByNote);
    const byName = new Map(accepted.map((entry) => [entry.noteName, entry] as const));
    const orderedNames = accepted.map((entry) => entry.noteName);
    selected = selectBalanced(
      orderedNames,
      input.targetCount,
      (name) => adjacency.get(name) ?? EMPTY_NEIGHBORS,
    ).map((name) => byName.get(name)!);
  }

  // Dropping unselected candidates can leave edges pointing at a note that
  // will never be written — filter those out rather than link to nothing.
  const selectedNames = new Set(selected.map((entry) => entry.noteName));
  const isWrittenNote = (name: string) => selectedNames.has(name) || vaultNoteNames.has(name);

  await adapter.ensureFolder(papersFolder);

  for (const entry of selected) {
    const cites = (citesByNote.get(entry.noteName) ?? []).filter(isWrittenNote);
    const citedBy = (citedByNote.get(entry.noteName) ?? []).filter(isWrittenNote);
    const notePath = `${papersFolder}/${entry.noteName}.md`;
    const content = renderInboxNote({
      work: entry.work,
      authorPlacement: input.authorPlacement,
      cites,
      citedBy,
      arrivedOn: today,
      originIds: entry.ids,
      subjects: input.subjects,
      readStatus: input.readStatus,
    });
    await adapter.write(notePath, content);
    report.written.push({
      title: entry.work.title ?? entry.work.key,
      notePath,
      edgeCount: cites.length + citedBy.length,
    });
    report.totalEdges += cites.length;
    report.newReferenceRecords.push({
      ids: entry.ids,
      references: entry.work.references.map(serializeId),
      date: entry.work.date,
    });
    input.onProgress?.(report.written.length, selected.length);
  }

  return report;
}

/**
 * The same anchor-then-connect selection `runKernel` applies when trimming a
 * candidate pool, but pool-only (no vault awareness) — for contexts, namely
 * the settings preview, that want to know what Build would actually pick
 * without a `VaultIndex` or filename allocation in hand.
 */
export function selectTopicCandidates(works: readonly Work[], targetCount: number): Work[] {
  const index = new CitationIndex();
  for (const work of works) index.add(originIds(work), work.key);

  const citesByKey = new Map<string, string[]>();
  for (const work of works) {
    const { edges } = resolveCitations(work, work.key, index);
    if (edges.length > 0) citesByKey.set(work.key, edges.map((edge) => edge.targetKey));
  }
  const adjacency = undirectedAdjacency(citesByKey);
  const byKey = new Map(works.map((work) => [work.key, work] as const));
  const orderedKeys = works.map((work) => work.key);

  return selectBalanced(orderedKeys, targetCount, (key) => adjacency.get(key) ?? EMPTY_NEIGHBORS).map(
    (key) => byKey.get(key)!,
  );
}

export interface ConnectivityEstimate {
  /** How many of `works` cite, or are cited by, at least one other in the set. */
  connected: number;
  total: number;
  /** Distinct citing pairs within the set — the graph's edge count. */
  edges: number;
}

/**
 * A cheap, vault-independent read on how connected a candidate set already
 * is to itself — used by the settings preview to answer "does this look like
 * your field?" with a number instead of just a title list, before spending a
 * real fetch on building it.
 */
export function estimateConnectivity(works: readonly Work[]): ConnectivityEstimate {
  const index = new CitationIndex();
  for (const work of works) index.add(originIds(work), work.key);

  const connected = new Set<string>();
  const pairs = new Set<string>();
  for (const work of works) {
    const { edges } = resolveCitations(work, work.key, index);
    for (const edge of edges) {
      connected.add(edge.sourceKey);
      connected.add(edge.targetKey);
      const pairKey = [edge.sourceKey, edge.targetKey].sort().join("|");
      pairs.add(pairKey);
    }
  }
  return { connected: connected.size, total: works.length, edges: pairs.size };
}
