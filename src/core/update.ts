/**
 * The update run: fetch, dedup, wire into the graph, write.
 *
 * All the policy lives here as pure-ish logic behind a `VaultAdapter`, so the
 * whole flow is testable without Obsidian. `src/main.ts` supplies the real
 * adapter and does nothing but plumbing.
 */

import { CitationIndex, resolveCitations, type CitationEdge } from "./citations";
import { FilenameAllocator } from "./filenames";
import { contentHash } from "./hash";
import { idsIntersect, isDistinctiveTitle, normalizeTitle, originIds } from "./ids";
import { renderInboxNote, type SubjectOptions } from "./notes";
import { renderInboxPage, type InboxEntry } from "./inbox-page";
import { VaultIndex } from "./vault-state";
import type { Work } from "./types";

/** One note this plugin created and is responsible for. */
export interface InboxRecord {
  /** Vault-relative path, including `.md`. */
  notePath: string;
  originIds: string[];
  title?: string;
  /** `YYYY-MM-DD` the paper arrived — the keep window counts from here. */
  arrivedOn: string;
  /** Hash of the note exactly as generated; a mismatch means the user edited it. */
  contentHash: string;
  /** Manual adds are intentional and never auto-pruned. */
  manual?: boolean;
  /**
   * How many vault papers this arrival cites, recorded at arrival.
   *
   * Stored on the record rather than recomputed, because `_Inbox.md` is
   * regenerated after a keep and after a cleanup too — and neither of those
   * has a citation index to hand. Without this the count would appear on one
   * run and silently vanish on the next.
   */
  edgeCount?: number;
  /** Backfill attempts spent so far, and when the last one ran. */
  backfillAttempts?: number;
  lastBackfillOn?: string;
}

/** The minimum this module needs from Obsidian, kept narrow so tests can
 * supply an in-memory stand-in. */
export interface VaultAdapter {
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  /** Vault-relative paths of the markdown files directly under *folder*. */
  list(folder: string): Promise<string[]>;
}

export interface UpdateSettings {
  inboxFolder: string;
  papersFolder: string;
  maxArrivalsPerRun: number;
  subjects?: SubjectOptions;
  /** When false, `_Inbox.md` is not written — see the setting's rationale. */
  inboxPageEnabled?: boolean;
}

export type SkipReason = "already-in-vault" | "already-in-inbox" | "duplicate-in-batch";

export interface UpdateReport {
  arrived: { title: string; notePath: string; edgeCount: number }[];
  skipped: { title: string; reason: SkipReason; existingPath?: string }[];
  /** Fetch failures, by source — a source being down is "no update from that
   * source this run", never a failed run. */
  sourceErrors: { source: string; message: string }[];
  cappedAt?: number;
}

export function emptyReport(): UpdateReport {
  return { arrived: [], skipped: [], sourceErrors: [] };
}

/**
 * Decide whether a fetched work should become a note.
 *
 * Order matters: ids first (exact), then title — and title only when it's
 * distinctive enough to identify a paper on its own, since the manifest
 * carries no year or authors to corroborate against. A false skip is
 * recoverable and reported; a false *add* creates a duplicate note, so the
 * bias is toward skipping.
 */
export function findExisting(
  work: Work,
  vault: VaultIndex,
  inbox: readonly InboxRecord[],
): { reason: SkipReason; existingPath: string } | undefined {
  const ids = originIds(work);

  const vaultHit = vault.findByOrigin(ids);
  if (vaultHit) return { reason: "already-in-vault", existingPath: vaultHit.notePath };

  const inboxHit = inbox.find((record) => idsIntersect(ids, record.originIds));
  if (inboxHit) return { reason: "already-in-inbox", existingPath: inboxHit.notePath };

  if (isDistinctiveTitle(work.title)) {
    const key = normalizeTitle(work.title as string);
    const byTitle = vault.findByTitle(key);
    if (byTitle) return { reason: "already-in-vault", existingPath: byTitle.notePath };
    const inboxByTitle = inbox.find(
      (record) => record.title && normalizeTitle(record.title) === key,
    );
    if (inboxByTitle) {
      return { reason: "already-in-inbox", existingPath: inboxByTitle.notePath };
    }
  }
  return undefined;
}

export interface UpdateRunInput {
  fetched: Work[];
  vault: VaultIndex;
  inbox: InboxRecord[];
  settings: UpdateSettings;
  adapter: VaultAdapter;
  /** `YYYY-MM-DD`; injected so tests aren't clock-dependent. */
  today: string;
}

export interface UpdateRunOutput {
  report: UpdateReport;
  /** The full inbox record set after this run — caller persists it. */
  inbox: InboxRecord[];
}

export async function runUpdate(input: UpdateRunInput): Promise<UpdateRunOutput> {
  const { fetched, vault, settings, adapter, today } = input;
  const inbox = [...input.inbox];
  const report = emptyReport();

  // Reserve every name already in use so an inbox note can never collide with
  // a Papers/ note — the rule that keeps wikilinks unambiguous (spec §2).
  const allocator = new FilenameAllocator();
  for (const name of vault.noteBaseNames()) allocator.reserve(name);
  for (const record of inbox) {
    const base = record.notePath.split("/").pop();
    if (base?.endsWith(".md")) allocator.reserve(base.slice(0, -3));
  }

  const accepted: { work: Work; noteName: string; ids: string[] }[] = [];
  for (const work of fetched) {
    if (accepted.length >= settings.maxArrivalsPerRun) {
      report.cappedAt = settings.maxArrivalsPerRun;
      break;
    }
    const existing = findExisting(work, vault, inbox);
    if (existing) {
      report.skipped.push({
        title: work.title ?? work.key,
        reason: existing.reason,
        existingPath: existing.existingPath,
      });
      continue;
    }
    const ids = originIds(work);
    // Guard against the same paper appearing twice in one fetch batch (two
    // sources, or a feed listing it twice).
    if (accepted.some((entry) => idsIntersect(ids, entry.ids))) {
      report.skipped.push({ title: work.title ?? work.key, reason: "duplicate-in-batch" });
      continue;
    }
    const { filename } = allocator.allocate(work);
    accepted.push({ work, noteName: filename, ids });
  }

  // Build the citation index over everything that exists *plus* everything
  // arriving now, so arrivals link to old notes and to each other.
  const index = new CitationIndex();
  // Note names that belong to papers the user kept, as opposed to arrivals
  // still sitting in the inbox. Only these count as "why you're seeing this":
  // connecting to five unread arrivals means nothing, connecting to five
  // papers you deliberately kept is the entire signal.
  const keptNames = new Set<string>();
  for (const record of inbox) {
    const base = record.notePath.split("/").pop();
    if (base?.endsWith(".md")) index.add(record.originIds, base.slice(0, -3));
  }
  for (const entry of vault.entriesForIndex()) {
    const base = entry.notePath.split("/").pop();
    if (base?.endsWith(".md")) {
      const name = base.slice(0, -3);
      index.add(entry.originIds, name);
      if (!entry.notePath.startsWith(`${settings.inboxFolder}/`)) keptNames.add(name);
    }
  }
  for (const entry of accepted) index.add(entry.ids, entry.noteName);

  const allEdges: CitationEdge[] = [];
  for (const entry of accepted) {
    const { edges } = resolveCitations(entry.work, entry.noteName, index);
    allEdges.push(...edges);
  }
  const citesByNote = new Map<string, string[]>();
  for (const edge of allEdges) {
    const list = citesByNote.get(edge.sourceKey);
    if (list) list.push(edge.targetKey);
    else citesByNote.set(edge.sourceKey, [edge.targetKey]);
  }

  await adapter.ensureFolder(settings.inboxFolder);

  for (const entry of accepted) {
    const cites = citesByNote.get(entry.noteName) ?? [];
    const notePath = `${settings.inboxFolder}/${entry.noteName}.md`;
    const content = renderInboxNote({
      work: entry.work,
      cites,
      arrivedOn: today,
      originIds: entry.ids,
      connectedKept: cites.filter((name) => keptNames.has(name)),
      subjects: settings.subjects,
    });
    await adapter.write(notePath, content);
    inbox.push({
      notePath,
      originIds: entry.ids,
      title: entry.work.title,
      arrivedOn: today,
      contentHash: contentHash(content),
      edgeCount: cites.length,
    });
    report.arrived.push({
      title: entry.work.title ?? entry.work.key,
      notePath,
      edgeCount: cites.length,
    });
  }

  await writeInboxPage(inbox, settings, adapter);
  return { report, inbox };
}

/**
 * Regenerate `_Inbox.md` from the current record set.
 *
 * Edge counts come off the records themselves, so the front page says the same
 * thing whether it was rebuilt by an update, a keep, or a cleanup.
 */
export async function writeInboxPage(
  inbox: readonly InboxRecord[],
  settings: UpdateSettings,
  adapter: VaultAdapter,
): Promise<void> {
  if (settings.inboxPageEnabled === false) return;
  const entries: InboxEntry[] = inbox.map((record) => {
    const base = record.notePath.split("/").pop() ?? record.notePath;
    const filename = base.endsWith(".md") ? base.slice(0, -3) : base;
    return {
      filename,
      date: record.arrivedOn,
      label: record.title && record.title !== filename ? record.title : undefined,
      edgeCount: record.edgeCount,
    };
  });
  await adapter.write(`${settings.inboxFolder}/_Inbox.md`, renderInboxPage(entries));
}
