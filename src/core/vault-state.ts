/**
 * Reader for zot2vault's `.scriptorium/state.json` — docs/interop-spec.md §4.
 *
 * **Strictly read-only.** zot2vault is that file's only writer; this plugin
 * keeps its own state in Obsidian's per-plugin `data.json`. One writer per
 * file is what makes concurrent use safe without any locking.
 *
 * Every failure mode here degrades to "empty state", never to an error:
 *  - the file is absent (a vault that has only ever used this plugin — the
 *    normal case, since zot2vault doesn't create it until it writes something);
 *  - it is unreadable or malformed;
 *  - its `version` is newer than this code understands.
 * In every one of those cases the right behaviour is "I know of no existing
 * papers", which costs at worst a duplicate note, versus a failed run.
 */

export const STATE_DIR = ".scriptorium";
export const STATE_FILE = "state.json";
export const STATE_PATH = `${STATE_DIR}/${STATE_FILE}`;
export const SUPPORTED_VERSION = 1;

/** Manifest entries whose ids carry this prefix are author pages, not papers,
 * and must never be treated as a dedup target for a fetched work (spec §3.2). */
const AUTHOR_PREFIX = "author:";

export interface ManifestEntry {
  notePath: string;
  contentHash: string;
  generatedAt: string;
  originIds: string[];
  title?: string;
}

export interface VaultStateSnapshot {
  present: boolean;
  version?: number;
  entries: ManifestEntry[];
}

export const EMPTY_STATE: VaultStateSnapshot = { present: false, entries: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse state.json defensively. Unknown keys are ignored by construction
 * (spec §1), and a malformed entry is skipped rather than poisoning the lot. */
export function parseVaultState(raw: string): VaultStateSnapshot {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_STATE;
  }
  if (!isRecord(data)) return EMPTY_STATE;

  const version = typeof data.version === "number" ? data.version : undefined;
  // A newer format may have changed the meaning of fields we think we know,
  // so read nothing rather than guess.
  if (version !== undefined && version > SUPPORTED_VERSION) {
    return { present: true, version, entries: [] };
  }

  const manifest = isRecord(data.note_manifest) ? data.note_manifest : {};
  const entries: ManifestEntry[] = [];
  for (const [notePath, value] of Object.entries(manifest)) {
    if (!isRecord(value)) continue;
    const contentHash = typeof value.content_hash === "string" ? value.content_hash : undefined;
    if (!contentHash) continue;
    entries.push({
      notePath,
      contentHash,
      generatedAt: typeof value.generated_at === "string" ? value.generated_at : "",
      originIds: Array.isArray(value.origin_ids)
        ? value.origin_ids.filter((id): id is string => typeof id === "string")
        : [],
      title: typeof value.title === "string" ? value.title : undefined,
    });
  }
  return { present: true, version, entries };
}

/** The subset of manifest entries that represent papers — author pages
 * excluded, since matching a fetched work against one would be nonsense. */
export function paperEntries(state: VaultStateSnapshot): ManifestEntry[] {
  return state.entries.filter(
    (entry) => !entry.originIds.every((id) => id.startsWith(AUTHOR_PREFIX)),
  );
}

/**
 * Recover manifest-equivalent entries by reading the notes in *folder*.
 *
 * The manifest is written only by zot2vault, so in a plugin-only vault it
 * doesn't exist — and without this, a paper kept by moving its note into the
 * papers folder would be invisible and get re-fetched on the next run. Every
 * note this plugin writes carries its own `origin-ids`, so the folder itself
 * is an authoritative source of "what's already here".
 *
 * Never throws: an unreadable or unrecognisable note is skipped, because a
 * hand-written note in the papers folder is normal and must not break a run.
 */
export async function scanFolderIdentities(
  folder: string,
  list: (folder: string) => Promise<string[]>,
  read: (path: string) => Promise<string | undefined>,
  parse: (content: string) => { originIds: string[]; title?: string } | undefined,
): Promise<ManifestEntry[]> {
  let paths: string[];
  try {
    paths = await list(folder);
  } catch {
    return [];
  }

  const entries: ManifestEntry[] = [];
  for (const path of paths) {
    try {
      const content = await read(path);
      if (content === undefined) continue;
      const identity = parse(content);
      if (!identity) continue;
      entries.push({
        notePath: path,
        // These are read from disk rather than generated now, so there is no
        // meaningful hash or timestamp — and neither is used for dedup.
        contentHash: "",
        generatedAt: "",
        originIds: identity.originIds,
        title: identity.title,
      });
    } catch {
      continue;
    }
  }
  return entries;
}

/** Combine manifest entries with folder-scanned ones into a single snapshot. */
export function mergeSnapshots(
  state: VaultStateSnapshot,
  extra: readonly ManifestEntry[],
): VaultStateSnapshot {
  const seen = new Set(state.entries.map((entry) => entry.notePath));
  return {
    present: state.present || extra.length > 0,
    version: state.version,
    entries: [...state.entries, ...extra.filter((entry) => !seen.has(entry.notePath))],
  };
}

/** Fast id -> entry lookup over paper entries only. */
export class VaultIndex {
  private readonly byId = new Map<string, ManifestEntry>();
  private readonly byTitle = new Map<string, ManifestEntry>();

  constructor(
    state: VaultStateSnapshot,
    normalizeTitleFn: (title: string) => string,
  ) {
    for (const entry of paperEntries(state)) {
      for (const id of entry.originIds) {
        if (!this.byId.has(id)) this.byId.set(id, entry);
      }
      if (entry.title) {
        const key = normalizeTitleFn(entry.title);
        if (key && !this.byTitle.has(key)) this.byTitle.set(key, entry);
      }
    }
  }

  findByOrigin(originIds: readonly string[]): ManifestEntry | undefined {
    for (const id of originIds) {
      const hit = this.byId.get(id);
      if (hit) return hit;
    }
    return undefined;
  }

  findByTitle(normalizedTitle: string): ManifestEntry | undefined {
    return normalizedTitle ? this.byTitle.get(normalizedTitle) : undefined;
  }

  /** Every distinct paper entry, for building a citation index over notes
   * that already exist in the vault. */
  entriesForIndex(): ManifestEntry[] {
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
