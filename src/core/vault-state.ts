/**
 * What the vault already contains, recovered by reading notes directly.
 *
 * Every note this plugin writes carries its own `origin-ids` and `title` in
 * frontmatter, so the papers folder is an authoritative, self-contained
 * record of "what's already here" — no separate manifest file, no plugin
 * state, nothing that could fall out of sync with the folder itself. This is
 * also what makes the keep mechanism work at all: moving a note out of the
 * inbox is the keep signal, and without scanning the folder the next update
 * would find no record of that paper and fetch it straight back in.
 */

/** Ids carrying this prefix are author pages, not papers, and must never be
 * treated as a dedup target for a fetched work. */
const AUTHOR_PREFIX = "author:";

export interface NoteEntry {
  notePath: string;
  originIds: string[];
  title?: string;
}

/**
 * Recover identity entries by reading every note in *folder*.
 *
 * Never throws: an unreadable or unrecognisable note is skipped, because a
 * hand-written note in the papers folder is normal and must not break a run.
 */
export async function scanFolderIdentities(
  folder: string,
  list: (folder: string) => Promise<string[]>,
  read: (path: string) => Promise<string | undefined>,
  parse: (content: string) => { originIds: string[]; title?: string } | undefined,
): Promise<NoteEntry[]> {
  let paths: string[];
  try {
    paths = await list(folder);
  } catch {
    return [];
  }

  const entries: NoteEntry[] = [];
  for (const path of paths) {
    try {
      const content = await read(path);
      if (content === undefined) continue;
      const identity = parse(content);
      if (!identity) continue;
      entries.push({ notePath: path, originIds: identity.originIds, title: identity.title });
    } catch {
      continue;
    }
  }
  return entries;
}

/** Fast id -> entry lookup over paper entries only. */
export class VaultIndex {
  private readonly byId = new Map<string, NoteEntry>();
  private readonly byTitle = new Map<string, NoteEntry>();

  constructor(
    entries: readonly NoteEntry[],
    normalizeTitleFn: (title: string) => string,
  ) {
    // Author pages excluded, since matching a fetched work against one would
    // be nonsense. (Vacuously true for an entry with no ids at all, so a
    // title-only entry is excluded here too — unchanged from before this
    // file stopped also reading a manifest.)
    for (const entry of entries) {
      if (entry.originIds.every((id) => id.startsWith(AUTHOR_PREFIX))) continue;
      for (const id of entry.originIds) {
        if (!this.byId.has(id)) this.byId.set(id, entry);
      }
      if (entry.title) {
        const key = normalizeTitleFn(entry.title);
        if (key && !this.byTitle.has(key)) this.byTitle.set(key, entry);
      }
    }
  }

  findByOrigin(originIds: readonly string[]): NoteEntry | undefined {
    for (const id of originIds) {
      const hit = this.byId.get(id);
      if (hit) return hit;
    }
    return undefined;
  }

  findByTitle(normalizedTitle: string): NoteEntry | undefined {
    return normalizedTitle ? this.byTitle.get(normalizedTitle) : undefined;
  }

  /** Every distinct paper entry, for building a citation index over notes
   * that already exist in the vault. */
  entriesForIndex(): NoteEntry[] {
    return [...new Set(this.byId.values())];
  }

  /** Note filenames (no extension) already used in the vault, so an inbox
   * note can be allocated a non-colliding name. */
  noteBaseNames(): string[] {
    const names = new Set<string>();
    for (const entry of this.byId.values()) {
      const base = entry.notePath.split("/").pop();
      if (base?.endsWith(".md")) names.add(base.slice(0, -3));
    }
    return [...names];
  }

  get paperCount(): number {
    return new Set([...this.byId.values()]).size;
  }
}
