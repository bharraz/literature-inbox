/**
 * The update run: fetch, dedup, wire into the graph, write.
 *
 * All the policy lives here as pure-ish logic behind a `VaultAdapter`, so the
 * whole flow is testable without Obsidian. `src/main.ts` supplies the real
 * adapter and does nothing but plumbing.
 */

import {
  CitationIndex,
  resolveCitations,
  retroactiveEdges,
  type CitationEdge,
  type ReferenceRecord,
} from "./citations";
import { FilenameAllocator } from "./filenames";
import { contentHash } from "./hash";
import { idsIntersect, isDistinctiveTitle, normalizeTitle, originIds, serializeId } from "./ids";
import {
  mergeCitations,
  renderInboxNote,
  type AuthorPlacement,
  type SubjectOptions,
} from "./notes";
import { VaultIndex } from "./vault-state";
import type { Work } from "./types";

export type { ReferenceRecord } from "./citations";

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
  /** How many vault papers this arrival cites, recorded at arrival and shown
   * in the run report. */
  edgeCount?: number;
  /** `YYYY-MM-DD` the backfill watchlist last checked this note. */
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
  authorPlacement?: AuthorPlacement;
  subjects?: SubjectOptions;
  /** Initial read-status for new notes, when the feature is on. */
  readStatus?: string;
}

export type SkipReason =
  | "already-in-vault"
  | "already-in-inbox"
  | "duplicate-in-batch"
  | "previously-removed";

export interface UpdateReport {
  arrived: { title: string; notePath: string; edgeCount: number; source?: string }[];
  skipped: { title: string; reason: SkipReason; existingPath?: string }[];
  /** Fetch failures, by source — a source being down is "no update from that
   * source this run", never a failed run. */
  sourceErrors: { source: string; message: string }[];
  cappedAt?: number;
  /** Already-known papers whose note gained a "Cites" link to one of today's
   * arrivals, discovered via the persisted reference index rather than a
   * fresh fetch. */
  retroConnections?: number;
}

export function emptyReport(): UpdateReport {
  return { arrived: [], skipped: [], sourceErrors: [] };
}

/**
 * Decide whether a fetched work should become a note.
 *
 * Order matters: ids first (exact), then title, then "did you remove this
 * before" — and title only when it's distinctive enough to identify a paper
 * on its own, since the manifest carries no year or authors to corroborate
 * against. A false skip is recoverable and reported; a false *add* creates a
 * duplicate note, so the bias is toward skipping.
 *
 * `previouslyRemoved` stops a manually deleted arrival from silently
 * reappearing after its tracked record is reconciled away.
 */
export function findExisting(
  work: Work,
  vault: VaultIndex,
  inbox: readonly InboxRecord[],
  previouslyRemoved: readonly string[] = [],
): { reason: SkipReason; existingPath?: string } | undefined {
  const ids = originIds(work);

  const vaultHit = vault.findByOrigin(ids);
  if (vaultHit) return { reason: "already-in-vault", existingPath: vaultHit.notePath };

  const inboxHit = inbox.find((record) => idsIntersect(ids, record.originIds));
  if (inboxHit) return { reason: "already-in-inbox", existingPath: inboxHit.notePath };

  if (idsIntersect(ids, previouslyRemoved)) return { reason: "previously-removed" };

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
  /**
  * Ids of papers the user deleted from the inbox. Omit (or leave empty) for
  * a manual add so the explicitly requested paper is always allowed.
   */
  previouslyRemoved?: readonly string[];
  /**
   * Where a given work should be written, when it isn't just
   * `settings.inboxFolder` — a per-source folder override. Must always
   * return a path nested under (or equal to) `settings.inboxFolder`; see
   * `effectiveInboxFolder`, which is what a caller should build this from.
   * Omit to write everything into `settings.inboxFolder` directly.
   */
  folderFor?: (work: Work) => string;
  /**
   * Every paper's own reference list, as captured the run it was first
   * written — see `ReferenceRecord`. Omit to skip the retroactive pass
   * entirely (no persisted records yet, e.g. a fresh install).
   */
  referenceIndex?: readonly ReferenceRecord[];
  /** Which source row a given work came from, for the per-source breakdown
   * in the run report. Omit to leave `arrived[].source` unset. */
  sourceFor?: (work: Work) => string;
}

export interface UpdateRunOutput {
  report: UpdateReport;
  /** The full inbox record set after this run — caller persists it. */
  inbox: InboxRecord[];
  /**
   * One record per paper written this run, for the caller to fold into its
   * persisted `referenceIndex` — the only place a paper's reference list
   * survives past the run that fetched it.
   */
  newReferenceRecords: ReferenceRecord[];
}

export async function runUpdate(input: UpdateRunInput): Promise<UpdateRunOutput> {
  const { fetched, vault, settings, adapter, today } = input;
  const inbox = [...input.inbox];
  const report = emptyReport();
  const previouslyRemoved = input.previouslyRemoved ?? [];

  // Reserve every name already in use so an inbox note can never collide with
  // a Papers/ note — the rule that keeps wikilinks unambiguous (spec §2).
  const allocator = new FilenameAllocator();
  for (const name of vault.noteBaseNames()) allocator.reserve(name);
  for (const record of inbox) {
    const base = record.notePath.split("/").pop();
    if (base?.endsWith(".md")) allocator.reserve(base.slice(0, -3));
  }

  // The index of what already exists, built up front — a candidate has to be
  // ranked against your *current* library before the cap decides which ones
  // survive, not after.
  const index = new CitationIndex();
  // Note names that belong to papers the user kept, as opposed to arrivals
  // still sitting in the inbox. Only these count as "why you're seeing this",
  // and as a rank signal below: connecting to five unread arrivals means
  // nothing, connecting to five papers you deliberately kept is the entire
  // signal.
  const keptNames = new Set<string>();
  // Name -> path for every note already on disk, so a retroactive edge
  // (found below, against the persisted reference index) knows which file
  // to rewrite.
  const pathByName = new Map<string, string>();
  for (const record of inbox) {
    const base = record.notePath.split("/").pop();
    if (base?.endsWith(".md")) {
      const name = base.slice(0, -3);
      index.add(record.originIds, name);
      pathByName.set(name, record.notePath);
    }
  }
  for (const entry of vault.entriesForIndex()) {
    const base = entry.notePath.split("/").pop();
    if (base?.endsWith(".md")) {
      const name = base.slice(0, -3);
      index.add(entry.originIds, name);
      pathByName.set(name, entry.notePath);
      if (!entry.notePath.startsWith(`${settings.inboxFolder}/`)) keptNames.add(name);
    }
  }

  // First pass: drop what's already known — in the vault, in the inbox, or
  // previously removed — then rank what's left by how well it connects to
  // the *kept* library, newest first as a tiebreak. The cap then keeps the
  // best candidates rather than whichever a source happened to list first,
  // so repeatedly pressing fetch surfaces progressively less-connected
  // candidates instead of the same tier every time.
  const candidates: { work: Work; ids: string[]; connectedKeptCount: number }[] = [];
  for (const work of fetched) {
    const existing = findExisting(work, vault, inbox, previouslyRemoved);
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
    if (candidates.some((c) => idsIntersect(ids, c.ids))) {
      report.skipped.push({ title: work.title ?? work.key, reason: "duplicate-in-batch" });
      continue;
    }
    // A placeholder note name: this candidate has none yet, and one can never
    // collide with it since a real note name is never the empty string.
    const { edges } = resolveCitations(work, "", index);
    const connectedKeptCount = edges.filter((edge) => keptNames.has(edge.targetKey)).length;
    candidates.push({ work, ids, connectedKeptCount });
  }

  candidates.sort((a, b) => {
    if (b.connectedKeptCount !== a.connectedKeptCount) {
      return b.connectedKeptCount - a.connectedKeptCount;
    }
    return (b.work.date ?? "").localeCompare(a.work.date ?? "");
  });

  const kept = candidates.slice(0, settings.maxArrivalsPerRun);
  if (kept.length < candidates.length) report.cappedAt = settings.maxArrivalsPerRun;

  const accepted: { work: Work; noteName: string; ids: string[] }[] = [];
  for (const { work, ids } of kept) {
    const { filename } = allocator.allocate(work);
    accepted.push({ work, noteName: filename, ids });
  }

  // A candidate can also connect to a fellow arrival in this same batch —
  // ignored above (only the kept library counts toward ranking), but a real
  // edge once it's actually being written.
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

  // The reverse pass: papers already known — kept or still in the inbox —
  // whose *persisted* reference list turns out to include one of today's
  // arrivals. Their note never gets re-fetched; the edge comes entirely from
  // what was recorded when that paper was first written.
  const newNoteNames = new Set(accepted.map((entry) => entry.noteName));
  const newNoteDates = new Map(accepted.map((entry) => [entry.noteName, entry.work.date] as const));
  const retro = retroactiveEdges(input.referenceIndex ?? [], index, newNoteNames, newNoteDates);
  const retroCitedByNew = new Map<string, string[]>();
  const retroCitesByOld = new Map<string, string[]>();
  for (const edge of retro) {
    const citedByList = retroCitedByNew.get(edge.targetKey);
    if (citedByList) citedByList.push(edge.sourceKey);
    else retroCitedByNew.set(edge.targetKey, [edge.sourceKey]);
    const citesList = retroCitesByOld.get(edge.sourceKey);
    if (citesList) citesList.push(edge.targetKey);
    else retroCitesByOld.set(edge.sourceKey, [edge.targetKey]);
  }

  await adapter.ensureFolder(settings.inboxFolder);
  const ensuredFolders = new Set<string>([settings.inboxFolder]);
  const newReferenceRecords: ReferenceRecord[] = [];

  for (const entry of accepted) {
    const cites = citesByNote.get(entry.noteName) ?? [];
    const citedBy = retroCitedByNew.get(entry.noteName) ?? [];
    const folder = input.folderFor?.(entry.work) ?? settings.inboxFolder;
    if (!ensuredFolders.has(folder)) {
      await adapter.ensureFolder(folder);
      ensuredFolders.add(folder);
    }
    const notePath = `${folder}/${entry.noteName}.md`;
    const content = renderInboxNote({
      work: entry.work,
      authorPlacement: settings.authorPlacement,
      cites,
      citedBy,
      arrivedOn: today,
      originIds: entry.ids,
      connectedKept: [...cites, ...citedBy].filter((name) => keptNames.has(name)),
      subjects: settings.subjects,
      readStatus: settings.readStatus,
    });
    await adapter.write(notePath, content);
    inbox.push({
      notePath,
      originIds: entry.ids,
      title: entry.work.title,
      arrivedOn: today,
      contentHash: contentHash(content),
      edgeCount: cites.length + citedBy.length,
    });
    report.arrived.push({
      title: entry.work.title ?? entry.work.key,
      notePath,
      edgeCount: cites.length + citedBy.length,
      source: input.sourceFor?.(entry.work),
    });
    newReferenceRecords.push({
      ids: entry.ids,
      references: entry.work.references.map(serializeId),
      date: entry.work.date,
    });
  }

  // Rewrite each already-known paper that gained a backward link — additive
  // only, via the same merge the citation backfill uses, so an edit the user
  // made is never disturbed and the tracked hash only advances when the note
  // was still exactly what this plugin generated.
  let retroConnections = 0;
  for (const [sourceKey, targets] of retroCitesByOld) {
    const path = pathByName.get(sourceKey);
    if (!path) continue;
    const content = await adapter.read(path);
    if (content === undefined) continue;
    const updated = mergeCitations(content, targets, []);
    if (updated === content) continue;
    await adapter.write(path, updated);
    const record = inbox.find((r) => r.notePath === path);
    if (record) {
      const wasUnchanged = contentHash(content) === record.contentHash;
      if (wasUnchanged) record.contentHash = contentHash(updated);
    }
    retroConnections += 1;
  }
  if (retroConnections > 0) report.retroConnections = retroConnections;

  return { report, inbox, newReferenceRecords };
}

