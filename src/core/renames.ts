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

import { nestUnder, type SourceConfig } from "./sources";
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
  /** The library subfolder to expand from, relative to `papersFolder`; blank
   * for the whole library. */
  librarySubfolder: string;
  sources: readonly SourceConfig[];
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

  // A source's own folder is resolved against the *old* inbox folder, moved,
  // then stored the way the user wrote it: blank when it is the inbox itself,
  // relative when they typed it relative.
  const sources = state.sources.map((source) => {
    const typed = (source.inboxFolder ?? "").trim();
    if (!typed) return source;
    const before = nestUnder(typed, state.inboxFolder);
    const after = follow(before);
    if (after === before && inboxFolder === state.inboxFolder) return source;
    const wasRelative = !typed.replace(/^\/+/, "").startsWith(`${state.inboxFolder}/`);
    let stored = after;
    if (after === inboxFolder) stored = "";
    else if (wasRelative && after.startsWith(`${inboxFolder}/`)) {
      stored = after.slice(inboxFolder.length + 1);
    }
    if (stored === source.inboxFolder) return source;
    changed = true;
    return { ...source, inboxFolder: stored };
  });

  // Stored relative to the library, so renaming the library itself changes
  // nothing here; a subfolder moved out of the library is no longer one to
  // expand from, and falls back to the whole library.
  let librarySubfolder = state.librarySubfolder;
  if (librarySubfolder.trim()) {
    const after = follow(nestUnder(librarySubfolder, state.papersFolder));
    const relative = after.startsWith(`${papersFolder}/`) ? after.slice(papersFolder.length + 1) : "";
    if (relative !== librarySubfolder) {
      changed = true;
      librarySubfolder = relative;
    }
  }

  const inbox = state.inbox.map((record) => {
    const notePath = follow(record.notePath);
    return notePath === record.notePath ? record : { ...record, notePath };
  });

  return { inboxFolder, papersFolder, librarySubfolder, sources, inbox, changed };
}
