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

import { CitationIndex, resolveCitations } from "./citations";
import { FilenameAllocator } from "./filenames";
import { idsIntersect, isDistinctiveTitle, normalizeTitle, originIds } from "./ids";
import { renderInboxNote } from "./notes";
import type { VaultAdapter } from "./update";
import type { VaultIndex } from "./vault-state";
import type { Work } from "./types";

export interface KernelReport {
  written: { title: string; notePath: string; edgeCount: number }[];
  skipped: number;
  /** Edges among the seeded papers — the density of the starting graph. */
  totalEdges: number;
}

export interface KernelRunInput {
  works: Work[];
  vault: VaultIndex;
  papersFolder: string;
  adapter: VaultAdapter;
  today: string;
  /** Called as notes are written, so a long run can show progress. */
  onProgress?: (written: number, total: number) => void;
}

export async function runKernel(input: KernelRunInput): Promise<KernelReport> {
  const { works, vault, papersFolder, adapter, today } = input;
  const report: KernelReport = { written: [], skipped: 0, totalEdges: 0 };

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
  for (const entry of vault.entriesForIndex()) {
    const base = entry.notePath.split("/").pop();
    if (base?.endsWith(".md")) index.add(entry.originIds, base.slice(0, -3));
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

  await adapter.ensureFolder(papersFolder);

  for (const entry of accepted) {
    const cites = citesByNote.get(entry.noteName) ?? [];
    const citedBy = citedByNote.get(entry.noteName) ?? [];
    const notePath = `${papersFolder}/${entry.noteName}.md`;
    const content = renderInboxNote({
      work: entry.work,
      cites,
      citedBy,
      arrivedOn: today,
      originIds: entry.ids,
    });
    await adapter.write(notePath, content);
    report.written.push({
      title: entry.work.title ?? entry.work.key,
      notePath,
      edgeCount: cites.length + citedBy.length,
    });
    report.totalEdges += cites.length;
    input.onProgress?.(report.written.length, accepted.length);
  }

  return report;
}
