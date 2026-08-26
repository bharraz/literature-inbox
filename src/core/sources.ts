/**
 * Where new papers come from, as one list of rows.
 *
 * Every stream is the same kind of thing — something that produces candidate
 * papers on a schedule you control — so they get one table, one mental model,
 * and the same per-row window and cap. Previously an OpenAlex topic was a text
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
  /** Days back that count as new for this row. Blank inherits the global. */
  windowDays?: number;
  /** Ceiling on arrivals from this row per run. Blank inherits the global. */
  maxPerRun?: number;
  /** Where this row's arrivals land. Blank means the parent inbox folder
   * directly; anything else is nested under it — see `effectiveInboxFolder`. */
  inboxFolder?: string;
}

/**
 * A source's effective inbox folder, always nested under *parentInboxFolder*.
 *
 * This is what lets state reconciliation, "Keep this paper", and every other bit of code
 * that trusts a single prefix match against the parent folder go on doing
 * exactly that without ever learning about per-source folders: whatever a
 * source is given here, the result is guaranteed to start with
 * `${parentInboxFolder}/` (or equal it), so scanning the parent recursively
 * already covers it. The plugin's bound is the parent folder; a per-source
 * folder is only ever a way of organizing what's inside that bound.
 */
export function effectiveInboxFolder(source: SourceConfig, parentInboxFolder: string): string {
  const override = (source.inboxFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!override || override === parentInboxFolder) return parentInboxFolder;
  return override.startsWith(`${parentInboxFolder}/`)
    ? override
    : `${parentInboxFolder}/${override}`;
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
  if (existing && existing.length > 0) return existing.map((source) => ({ ...source }));

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
