/**
 * Where new papers come from, as one list of rows.
 *
 * Every stream is the same kind of thing — something that produces candidate
 * papers on a schedule you control — so they get one table, one mental model,
 * and the same global recency window plus a per-row cap. Previously an OpenAlex topic was a text
 * box with a dropdown, arXiv was a comma-separated string, and only RSS had
 * rows; three shapes for one idea.
 *
 * **OpenAlex appears here only in its stream role.** It has a second job that
 * is not a stream at all — resolving DOIs, fetching reference lists, anchoring
 * snowballs, backfilling edges — and that keeps working regardless of what is
 * in this table. Switching off a `topic` row stops OpenAlex *suggesting*
 * papers; it does not stop it supplying the citation edges the whole plugin is
 * built on. That asymmetry is why this is a list of streams rather than a list
 * of providers.
 */

import type { Work } from "./types";

export type SourceKind = "topic" | "citing" | "arxiv" | "feed";

export interface SourceConfig {
  kind: SourceKind;
  /**
   * Topic query, arXiv category, or feed URL. Unused for `citing`, whose
   * subject is the papers folder rather than anything the user types.
   */
  value: string;
  enabled: boolean;
  /** Legacy pre-global-window value, retained only while old settings migrate. */
  windowDays?: number;
  /** Ceiling on arrivals from this row per run. Blank inherits the global. */
  maxPerRun?: number;
}

/**
 * *folder*, placed under *parent* unless it already is there. Blank means the
 * parent itself. Used for every folder a user may name for a subset of
 * papers, so whatever they type stays inside the tree the plugin scans.
 */
export function nestUnder(folder: string, parent: string): string {
  const override = folder.trim().replace(/^\/+|\/+$/g, "");
  if (!override || override === parent) return parent;
  return override.startsWith(`${parent}/`) ? override : `${parent}/${override}`;
}

/**
 * The deepest folder holding everything in *paths* — a folder's own path
 * counts as itself, a note counts as the folder it sits in. Where an
 * expansion of those items lands by default, so new papers join the subfolder
 * the user was working in.
 */
export function sharedFolder(paths: readonly { path: string; isFolder: boolean }[]): string {
  const folders = paths.map(({ path, isFolder }) =>
    isFolder ? path : path.split("/").slice(0, -1).join("/"),
  );
  if (folders.length === 0) return "";
  let shared = folders[0]!.split("/");
  for (const folder of folders.slice(1)) {
    const parts = folder.split("/");
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.join("/");
}

/**
 * Whether two folders are the same or one contains the other.
 *
 * The inbox and the papers folder must be disjoint: everything rests on a
 * note's folder saying whether it is an arrival or kept, and a note in both
 * trees at once is both. Case-insensitive, as the filesystems under most
 * vaults are.
 */
export function foldersOverlap(a: string, b: string): boolean {
  const fold = (path: string) => path.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  const x = fold(a);
  const y = fold(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  citing: "Papers citing my library",
  topic: "Papers matching a topic",
  arxiv: "arXiv category",
  feed: "RSS / Atom feed",
};

export const SOURCE_PLACEHOLDERS: Record<SourceKind, string> = {
  citing: "(uses your papers folder)",
  topic: "quantum error correction",
  arxiv: "quant-ph",
  feed: "https://example.org/journal/feed.xml",
};

/** `citing` is the one row with nothing to type. */
export function needsValue(kind: SourceKind): boolean {
  return kind !== "citing";
}

export function emptySource(kind: SourceKind = "topic"): SourceConfig {
  return { kind, value: "", enabled: true };
}

/** A row is usable when it is on and has whatever input its kind requires. */
export function isUsable(source: SourceConfig): boolean {
  return source.enabled && (!needsValue(source.kind) || source.value.trim().length > 0);
}

/** What the row is called in a run report or an error. */
export function describeSource(source: SourceConfig): string {
  return needsValue(source.kind)
    ? `${SOURCE_LABELS[source.kind]}: ${source.value}`
    : SOURCE_LABELS[source.kind];
}

/** The settings this replaced, read once on load. */
export interface LegacySourceSettings {
  openAlexEnabled?: boolean;
  openAlexTopic?: string;
  arrivalSelection?: "both" | "adjacent" | "topic";
  arxivEnabled?: boolean;
  arxivCategories?: string;
  rssEnabled?: boolean;
  feeds?: { url: string; enabled: boolean; windowDays?: number; maxPerRun?: number }[];
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Carry the old per-source settings forward into rows, once.
 *
 * Someone upgrading has toggles and strings and no rows; silently losing their
 * configured sources would be a poor welcome. Ordered so the connected source
 * comes first, which is also the order arrivals are kept in when a cap bites.
 */
export function migrateSources(
  legacy: LegacySourceSettings,
  existing: readonly SourceConfig[] | undefined,
): SourceConfig[] {
  if (existing && existing.length > 0) {
    return existing.map(({ kind, value, enabled, windowDays, maxPerRun }) => ({
      kind,
      value,
      enabled,
      windowDays,
      maxPerRun,
    }));
  }

  const sources: SourceConfig[] = [];
  const selection = legacy.arrivalSelection ?? "both";
  const openAlex = legacy.openAlexEnabled ?? true;

  if (selection !== "topic") {
    sources.push({ kind: "citing", value: "", enabled: openAlex });
  }
  if (selection !== "adjacent" && (legacy.openAlexTopic ?? "").trim()) {
    sources.push({ kind: "topic", value: (legacy.openAlexTopic as string).trim(), enabled: openAlex });
  }
  for (const category of splitList(legacy.arxivCategories)) {
    sources.push({ kind: "arxiv", value: category, enabled: legacy.arxivEnabled ?? false });
  }
  for (const feed of legacy.feeds ?? []) {
    if (!feed.url?.trim()) continue;
    sources.push({
      kind: "feed",
      value: feed.url,
      enabled: (legacy.rssEnabled ?? false) && feed.enabled,
      windowDays: feed.windowDays,
      maxPerRun: feed.maxPerRun,
    });
  }

  return sources;
}

/**
 * Drop items older than *since*.
 *
 * Undated items are **kept**. Plenty of feeds omit a date, and dropping those
 * would silently turn a working source into a dead one — a false positive
 * costs one skip on the dedup pass, a false negative loses the paper for good.
 */
export function withinWindow(works: readonly Work[], since: string): Work[] {
  return works.filter((work) => !work.date || work.date >= since);
}

/** The effective value of a per-row override, falling back to the global. */
export function effective(override: number | undefined, fallback: number): number {
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? override
    : fallback;
}
