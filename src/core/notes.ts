/**
 * Inbox note rendering — docs/interop-spec.md §5.
 *
 * The generated-section markers and the frontmatter conventions are shared
 * with zot2vault on purpose. That's what lets a note you move from `Inbox/`
 * into `Papers/` be *upgraded in place* if that paper later enters your
 * Zotero library: zot2vault regenerates the block between the markers and
 * preserves everything you wrote below them. Change these strings and the
 * upgrade silently becomes a duplicate file instead.
 */

import { workYear, fullName, type Work } from "./types";

export const GENERATED_START = "<!-- zot2vault:generated:start -->";
export const GENERATED_END = "<!-- zot2vault:generated:end -->";

export const NO_ABSTRACT_PLACEHOLDER = "*No abstract available.*";

/** Values that YAML would otherwise reinterpret as a non-string must be
 * quoted — a bare `2017` is a number, `no` is a boolean, and a leading `@`
 * or `:` is a syntax error. */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if ("\"'@`|>*&!%#,[]{}:".includes(value[0] as string)) return true;
  if (value.trim() !== value) return true;
  if (["true", "false", "null", "~", "yes", "no"].includes(value.toLowerCase())) return true;
  if (value !== "" && !Number.isNaN(Number(value))) return true;
  return value.includes(":") || value.includes("#");
}

function yamlScalar(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type FrontmatterValue = string | string[];

export function renderFrontmatter(fields: Array<[string, FrontmatterValue | undefined]>): string {
  const lines = ["---"];
  for (const [key, value] of fields) {
    if (value === undefined) continue;              // omit, never write blank
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      if (value === "") continue;
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

export interface InboxNoteOptions {
  work: Work;
  /** Note filenames (no extension) this work cites that exist in the vault. */
  cites?: string[];
  /** Note filenames that cite this work. */
  citedBy?: string[];
  /** ISO date the paper arrived, used by the keep window. */
  arrivedOn: string;
  originIds: string[];
  /**
   * Of the notes this work connects to, the ones that are papers the user
   * *kept* — i.e. live outside the inbox — rather than fellow arrivals.
   *
   * This is the "why am I seeing this" signal, and it is the product thesis
   * in one line: a paper connected to work you already care about is worth a
   * look; one connected only to other unread arrivals is not.
   */
  connectedKept?: string[];
  /** How subject terms reach the note, if at all. */
  subjects?: SubjectOptions;
  /**
   * Seed the note with a read-status property. Off unless the user turned the
   * feature on — an unused property in every note is just clutter.
   */
  readStatus?: string;
}

/** Where subject terms go, and which vocabularies they come from. */
export interface SubjectOptions {
  placement: "off" | "property" | "tags";
  topics?: boolean;
  keywords?: boolean;
  concepts?: boolean;
}

/**
 * Fold a subject term into something usable as an Obsidian tag.
 *
 * Tags cannot contain spaces, and a tag that is entirely numeric is not a
 * valid tag either. Terms that survive neither rule are dropped rather than
 * mangled into nonsense.
 */
export function tagify(term: string): string | undefined {
  const slug = term
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return undefined;
  if (/^[\d/-]+$/.test(slug)) return undefined; // a purely numeric tag is invalid
  return slug;
}

/** The chosen vocabularies, in the order most-curated first, de-duplicated. */
export function collectSubjects(work: Work, options: SubjectOptions): string[] {
  const terms: string[] = [];
  const push = (list: string[]) => {
    for (const term of list) if (!terms.includes(term)) terms.push(term);
  };
  if (options.topics) push(work.topics);
  if (options.keywords) push(work.keywords);
  if (options.concepts) push(work.concepts);
  return terms;
}

function renderCitations(cites: string[], citedBy: string[]): string {
  if (cites.length === 0 && citedBy.length === 0) return "";
  const lines = ["## Citations", ""];
  if (cites.length > 0) {
    lines.push("### Cites", "");
    for (const name of cites) lines.push(`- [[${name}]]`);
    lines.push("");
  }
  if (citedBy.length > 0) {
    lines.push("### Cited by", "");
    for (const name of citedBy) lines.push(`- [[${name}]]`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * The "why am I seeing this" line, phrased in terms of the papers the user
 * already kept rather than a raw edge count — a count says nothing about
 * whether the connection is to anything they care about.
 */
function renderWhy(connectedKept: readonly string[]): string {
  if (connectedKept.length === 0) return "";
  const links = connectedKept.map((name) => `[[${name}]]`);
  const shown = links.slice(0, 5).join(", ");
  const rest = links.length > 5 ? `, and ${links.length - 5} more` : "";
  const noun = links.length === 1 ? "a paper you kept" : "papers you kept";
  return `> **Why you're seeing this:** it connects to ${noun} — ${shown}${rest}.\n`;
}

export function renderInboxNote(options: InboxNoteOptions): string {
  const { work, arrivedOn, originIds } = options;
  const cites = options.cites ?? [];
  const citedBy = options.citedBy ?? [];

  const subjects = options.subjects ?? { placement: "off" };
  const terms = subjects.placement === "off" ? [] : collectSubjects(work, subjects);
  const asTags =
    subjects.placement === "tags"
      ? terms.map(tagify).filter((tag): tag is string => Boolean(tag))
      : [];

  const frontmatter = renderFrontmatter([
    ["title", work.title],
    ["authors", work.authors.map(fullName).filter(Boolean)],
    ["year", workYear(work)],
    ["doi", work.doi],
    ["url", work.url],
    ["publication", work.publication],
    ["item-type", work.itemType],
    // Provenance: a note always says where it came from and when, so nothing
    // in the vault is of mysterious origin.
    ["source", work.source],
    ["fetched", arrivedOn],
    ["origin-ids", originIds],
    ["read-status", options.readStatus],
    ["subjects", subjects.placement === "property" ? terms : undefined],
    ["tags", asTags.length > 0 ? asTags : undefined],
    // Deliberately no `inbox`/`kept` tag. The folder is the source of truth
    // for whether a paper is kept, and a tag written at generation time cannot
    // track a file the user drags by hand — so it went stale the moment
    // keeping worked, labelling kept papers `inbox` and kernel seeds `kept`.
    // Anything that needs to distinguish them, including graph colouring,
    // keys on the path instead.
  ]);

  const title = work.title || work.key;
  const parts = [`# ${title}\n`];
  const authorLine = work.authors.map(fullName).filter(Boolean).join(", ");
  if (authorLine) parts.push(`**Authors:** ${authorLine}\n`);
  const why = renderWhy(options.connectedKept ?? []);
  if (why) parts.push(why);
  parts.push(`## Abstract\n\n${work.abstract?.trim() || NO_ABSTRACT_PLACEHOLDER}\n`);
  const citations = renderCitations(cites, citedBy);
  if (citations) parts.push(citations);

  const body = parts.join("\n");
  return `${frontmatter}\n${GENERATED_START}\n${body}\n${GENERATED_END}\n`;
}

/**
 * Add a Citations section to an existing note, in place.
 *
 * Used by backfill, when a paper that arrived edge-less turns out to have
 * references after all. The block is inserted *inside* the generated section,
 * immediately before the end marker, so anything the user wrote below it is
 * untouched — and callers only ever pass notes that are still byte-identical
 * to what was generated, so there is nothing above the marker to lose either.
 *
 * A note that somehow already has citations is returned unchanged rather than
 * gaining a second section.
 */
export function appendCitations(content: string, cites: readonly string[]): string {
  if (cites.length === 0) return content;
  if (content.includes("## Citations")) return content;
  const markerIndex = content.indexOf(GENERATED_END);
  if (markerIndex === -1) return content;

  const section = renderCitations([...cites], []);
  return `${content.slice(0, markerIndex)}${section}\n${content.slice(markerIndex)}`;
}

/** Whatever the user has written below the end marker. Carried across a
 * regenerate verbatim — this is the never-destroy-user-work guarantee. */
export function preservedUserContent(existing: string): string {
  const index = existing.indexOf(GENERATED_END);
  if (index === -1) return "";
  return existing.slice(index + GENERATED_END.length).replace(/^\n+/, "");
}

/** True when a note still matches what we generated — i.e. untouched. Any
 * edit at all, anywhere in the file, makes this false. */
export function isUnchanged(existing: string, expected: string): boolean {
  return existing === expected;
}
