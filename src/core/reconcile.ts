/**
 * Bringing the inbox records back in line with the files, before every run.
 *
 * The folders are the source of truth; a record is only what the plugin
 * remembers about an arrival it wrote — its hash, the day it arrived, when
 * backfill last asked about it. So:
 *
 *  - Any note under the inbox folder is an arrival. One the user renamed, or
 *    moved into a subfolder, keeps its record (matched by id, not by path).
 *    One with no record at all is adopted: records live in plugin data, which
 *    is per-device and may not sync, and a vault whose inbox the plugin cannot
 *    see would fetch every one of those papers again.
 *  - Any note under the papers folder is kept; its record is simply dropped.
 *  - A note found in neither was deleted, or moved somewhere the plugin does
 *    not look. Both mean "I'm done with this", so its ids are handed back to
 *    be remembered, and the same paper does not return on the next fetch.
 */

import { idsIntersect } from "./ids";
import type { InboxRecord } from "./update";
import type { NoteEntry, VaultIndex } from "./vault-state";

export interface ReconcileResult {
  /** The records to keep, in their original order, adopted notes last. */
  inbox: InboxRecord[];
  /** Ids of arrivals that are gone — for the caller's `previouslyRemoved`. */
  removedIds: string[];
  /** False when nothing differs, so the caller can skip a save. */
  changed: boolean;
}

export function reconcileInbox(
  records: readonly InboxRecord[],
  inboxNotes: readonly NoteEntry[],
  kept: VaultIndex,
  today: string,
): ReconcileResult {
  // Only notes that carry an id can be an arrival: a note the user wrote
  // themselves, with at most a title, is none of this module's business.
  const papers = inboxNotes.filter((note) => note.originIds.length > 0);
  const claimed = new Set<string>();
  const byPath = new Map(papers.map((note) => [note.notePath, note] as const));

  const inbox: InboxRecord[] = [];
  const removedIds: string[] = [];
  let changed = false;

  // Exact paths first, so a renamed note can never be claimed by a record
  // whose own file is still sitting where it was written.
  const missing: InboxRecord[] = [];
  for (const record of records) {
    if (byPath.has(record.notePath) && !claimed.has(record.notePath)) {
      claimed.add(record.notePath);
    } else {
      missing.push(record);
    }
  }

  const relinked = new Map<InboxRecord, string>();
  for (const record of missing) {
    const moved = papers.find(
      (note) => !claimed.has(note.notePath) && idsIntersect(note.originIds, record.originIds),
    );
    if (moved) {
      claimed.add(moved.notePath);
      relinked.set(record, moved.notePath);
    }
  }

  for (const record of records) {
    if (!missing.includes(record)) {
      inbox.push(record);
      continue;
    }
    changed = true;
    const newPath = relinked.get(record);
    if (newPath) {
      inbox.push({ ...record, notePath: newPath });
      continue;
    }
    // Kept papers need nothing remembered: the papers folder already blocks
    // them. Anything else is gone, and must not come straight back.
    if (!kept.findByOrigin(record.originIds)) removedIds.push(...record.originIds);
  }

  for (const note of papers) {
    if (claimed.has(note.notePath)) continue;
    changed = true;
    inbox.push({
      notePath: note.notePath,
      originIds: note.originIds,
      title: note.title,
      arrivedOn: today,
      // No hash to compare against, so the note is treated exactly like one
      // the user has edited: never regenerated or marked, only ever given
      // citation links inside its own block.
      contentHash: "",
    });
  }

  return { inbox, removedIds: [...new Set(removedIds)], changed };
}
