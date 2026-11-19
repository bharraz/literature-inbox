/**
 * Following the user's renames, as they happen.
 *
 * Reconciliation (`reconcile.ts`) already sorts every note into arrival, kept
 * or gone at the start of a run, by id. What it cannot recover from is a
 * renamed *folder*: rename `Inbox/` in the file explorer and, with the setting
 * still pointing at the old name, every arrival looks deleted at once — its
 * ids remembered as let go, its record discarded. So the configured folders
 * follow a rename the moment Obsidian reports it, and so do the records'
 * paths, which keeps counts honest between runs.
 *
 * Deliberately path-following only. Whether a note that left the inbox was
 * kept or let go is still decided at the next run, from the folders, by the
 * one module whose job that is.
 */

import type { InboxRecord } from "./update";

/**
 * Where *path* ends up when *from* is renamed to *to*: *to* itself, the same
 * place under *to* if *path* was inside *from*, or undefined if unaffected.
 */
export function renamedPath(path: string, from: string, to: string): string | undefined {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return undefined;
}

export interface RenameState {
  inboxFolder: string;
  papersFolder: string;
  inbox: readonly InboxRecord[];
}

export interface RenameResult extends RenameState {
  changed: boolean;
}

/**
 * Apply one rename — a file or a folder — to everything that holds a path.
 *
 * Idempotent per path: when Obsidian reports a folder rename and then each
 * file inside it, the folder's event has already moved those records, so the
 * files' events find nothing left at their old paths.
 */
export function applyRename(state: RenameState, from: string, to: string): RenameResult {
  let changed = false;
  const follow = (path: string) => {
    const moved = renamedPath(path, from, to);
    if (moved === undefined) return path;
    changed = true;
    return moved;
  };

  const inboxFolder = follow(state.inboxFolder);
  const papersFolder = follow(state.papersFolder);

  const inbox = state.inbox.map((record) => {
    const notePath = follow(record.notePath);
    return notePath === record.notePath ? record : { ...record, notePath };
  });

  return { inboxFolder, papersFolder, inbox, changed };
}
