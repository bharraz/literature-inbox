/**
 * Inbox note rendering — docs/interop-spec.md §5.
 *
 * Everything between the generated-section markers is this plugin's to
 * regenerate; everything below the end marker is the user's, preserved
 * verbatim across a regenerate. These exact strings are an on-disk format,
 * not an implementation detail — changing them makes every existing note
 * look unmarked and would silently drop what users wrote below it.
 */

import { workYear, fullName, type Work } from "./types";

export const GENERATED_START = "<!-- literature-inbox:generated:start -->";
export const GENERATED_END = "<!-- literature-inbox:generated:end -->";

/**
 * A second, narrower marker pair around just the Citations section.
 *
 * The outer generated-section markers guard the *whole* note for cleanup:
 * edit anything inside them, anywhere, and the note is "touched" and safe
 * from cleanup forever — exactly what cleanup should do. But that same
 * all-or-nothing rule would also have frozen the citations list the moment
 * you wrote so much as a personal tag elsewhere in the note, and keeping the
 * graph's edges accurate matters independently of that. These markers let
 * the plugin always find and add to *just this block*, regardless of
 * anything else going on in the note — additively only: an existing link is
 * never removed, and anything you add inside the block yourself is left
 * exactly where it is.
 */
export const CITATIONS_START =
  "<!-- literature-inbox:citations:start — auto-updated, please don't edit inside this block -->";
export const CITATIONS_END = "<!-- literature-inbox:citations:end -->";

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

/** The Citations section, wrapped in its own always-findable markers. */
function renderCitationsBlock(cites: string[], citedBy: string[]): string {
  const inner = renderCitations(cites, citedBy);
  if (!inner) return "";
  return `${CITATIONS_START}\n${inner}${CITATIONS_END}\n`;
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
  const citations = renderCitationsBlock(cites, citedBy);
  if (citations) parts.push(citations);

  const body = parts.join("\n");
  return `${frontmatter}\n${GENERATED_START}\n${body}\n${GENERATED_END}\n`;
}

/** Every `[[Name]]` link already inside a citations block — under Cites,
 * under Cited by, or anything the user added by hand. Used only to decide
 * what's missing; nothing already linked is ever touched or removed. */
function existingLinks(block: string): Set<string> {
  const links = new Set<string>();
  for (const match of block.matchAll(/\[\[([^\]]+)\]\]/g)) links.add(match[1] as string);
  return links;
}

/** Insert `bullets` right after `heading`'s own list, creating the heading
 * (just before the block's end) if it isn't there yet. */
function appendUnderHeading(block: string, heading: string, names: readonly string[]): string {
  const bullets = names.map((name) => `- [[${name}]]`).join("\n");
  const headingIndex = block.indexOf(heading);
  const endMarkerIndex = block.indexOf(CITATIONS_END);
  if (headingIndex === -1) {
    return `${block.slice(0, endMarkerIndex)}${heading}\n\n${bullets}\n\n${block.slice(endMarkerIndex)}`;
  }
  // The end of this heading's section is the next "###" heading, or the
  // block's own end marker if this is the last section.
  const nextHeadingIndex = block.indexOf("###", headingIndex + heading.length);
  const boundary = nextHeadingIndex === -1 ? endMarkerIndex : nextHeadingIndex;
  // Back up over trailing blank lines so the new bullets land right after the
  // last existing one, not after a blank line.
  let cursor = boundary;
  while (cursor > 0 && block[cursor - 1] === "\n") cursor -= 1;
  return `${block.slice(0, cursor)}\n${bullets}\n${block.slice(cursor)}`;
}

/**
 * Add newly-discovered citation links to a note's citations block, in place —
 * creating the block if the note has none yet, and appending under the right
 * heading (creating that heading too, if needed) otherwise.
 *
 * Deliberately additive only, and deliberately indifferent to whatever else
 * has changed in the note: an existing link is never removed, anything else
 * written inside the block is left exactly where it is, and the rest of the
 * note — frontmatter, abstract, anything below the generated section — is
 * never even inspected. Returns the input unchanged if there is nothing new
 * to add.
 */
export function mergeCitations(
  content: string,
  cites: readonly string[],
  citedBy: readonly string[],
): string {
  const newCites = cites.filter(Boolean);
  const newCitedBy = citedBy.filter(Boolean);
  if (newCites.length === 0 && newCitedBy.length === 0) return content;

  const startIndex = content.indexOf(CITATIONS_START);
  if (startIndex === -1) {
    // No block yet — insert one where the note's generated content ends.
    const markerIndex = content.indexOf(GENERATED_END);
    if (markerIndex === -1) return content;
    const section = renderCitationsBlock([...newCites], [...newCitedBy]);
    if (!section) return content;
    return `${content.slice(0, markerIndex)}${section}\n${content.slice(markerIndex)}`;
  }

  const endMarkerIndex = content.indexOf(CITATIONS_END, startIndex);
  if (endMarkerIndex === -1) return content; // malformed; don't guess
  const blockEnd = endMarkerIndex + CITATIONS_END.length;
  const block = content.slice(startIndex, blockEnd);

  const already = existingLinks(block);
  const missingCites = newCites.filter((name) => !already.has(name));
  const missingCitedBy = newCitedBy.filter((name) => !already.has(name));
  if (missingCites.length === 0 && missingCitedBy.length === 0) return content;

  let updatedBlock = block;
  if (missingCites.length > 0) {
    updatedBlock = appendUnderHeading(updatedBlock, "### Cites", missingCites);
  }
  if (missingCitedBy.length > 0) {
    updatedBlock = appendUnderHeading(updatedBlock, "### Cited by", missingCitedBy);
  }
  return content.slice(0, startIndex) + updatedBlock + content.slice(blockEnd);
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
