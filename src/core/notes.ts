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
 * The outer generated-section markers guard the *whole* generated note:
 * edit anything inside them, anywhere, and the note is considered user-owned.
 * But that same
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
 * or `:` is a syntax error. The leading `-`, `?` and `=` matter for real
 * titles: `title: - Some Paper` is a parse error, not a title. */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if ("\"'@`|>*&!%#,[]{}:-?=".includes(value[0] as string)) return true;
  if (value.trim() !== value) return true;
  const lowered = value.toLowerCase();
  if (["true", "false", "null", "~", "yes", "no", "on", "off"].includes(lowered)) return true;
  if (value !== "" && !Number.isNaN(Number(value))) return true;
  return value.includes(":") || value.includes("#");
}

/**
 * A single-line, always-parseable YAML scalar.
 *
 * Control whitespace is folded to spaces before anything else. Sources do
 * publish titles containing literal newlines, and one reaching this point
 * unescaped ends the scalar early — which corrupts the rest of the block and
 * lets whatever followed be read as further YAML keys.
 */
function yamlScalar(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (!needsQuoting(flat)) return flat;
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
  /** Whether OpenAlex Topics appear as a property. */
  includeSubjects?: boolean;
}

/**
 * At most this many subject terms reach a note. Machine-assigned and ranked,
 * so past the head they tail off into terms too broad to say anything, while
 * each one is another line in the properties panel above the abstract.
 */
export const MAX_NOTE_SUBJECTS = 8;

/** OpenAlex Topics, de-duplicated in source order. */
export function collectSubjects(work: Work): string[] {
  return [...new Set(work.topics)].slice(0, MAX_NOTE_SUBJECTS);
}

/** Clickable provenance kept in the readable note body, not frontmatter. */
function renderSourceLinks(originIds: readonly string[]): string {
  const links: string[] = [];
  const openAlex = originIds.find((id) => id.startsWith("openalex:"))?.slice("openalex:".length);
  const arxiv = originIds.find((id) => id.startsWith("arxiv:"))?.slice("arxiv:".length);
  if (openAlex) links.push(`[OpenAlex](https://openalex.org/${encodeURIComponent(openAlex)})`);
  if (arxiv) links.push(`[arXiv](https://arxiv.org/abs/${encodeURI(arxiv)})`);
  return links.length > 0 ? `**Sources:** ${links.join(" · ")}\n` : "";
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

export function renderInboxNote(options: InboxNoteOptions): string {
  const { work, arrivedOn, originIds } = options;
  const cites = options.cites ?? [];
  const citedBy = options.citedBy ?? [];
  const terms = options.includeSubjects ? collectSubjects(work) : [];

  const frontmatter = renderFrontmatter([
    // What a reader looks at first, in the order they look for it. Every
    // author, always — a shortened list would be a wrong record of the paper.
    ["title", work.title],
    ["authors", work.authors.map(fullName).filter(Boolean)],
    ["year", workYear(work)],
    ["publication", work.publication],
    ["doi", work.doi],
    ["url", work.url],
    ["subjects", terms.length > 0 ? terms : undefined],
    // Then what the plugin keeps for itself, last and hidden in compact mode.
    ["item-type", work.itemType],
    ["fetched", arrivedOn],
    ["origin-ids", originIds],
    // Deliberately no `inbox`/`kept` tag. The folder is the source of truth
    // for whether a paper is kept, and a tag written at generation time cannot
    // track a file the user drags by hand — so it went stale the moment
    // keeping worked, labelling kept papers `inbox` and kernel seeds `kept`.
    // Anything that needs to distinguish them, including graph colouring,
    // keys on the path instead.
  ]);

  // Flattened for the same reason frontmatter scalars are: a newline here
  // would split the note's heading in two and orphan the rest of the title.
  const title = (work.title || work.key).replace(/\s+/g, " ").trim();
  const parts = [`# ${title}\n`];
  const sourceLinks = renderSourceLinks(originIds);
  if (sourceLinks) parts.push(sourceLinks);
  parts.push(`## Abstract\n\n${work.abstract?.trim() || NO_ABSTRACT_PLACEHOLDER}\n`);
  const citations = renderCitationsBlock(cites, citedBy);
  if (citations) parts.push(citations);

  const body = parts.join("\n");
  return `${frontmatter}\n${GENERATED_START}\n${body}\n${GENERATED_END}\n`;
}

/** Every `[[Name]]` link already inside a citations block — under Cites,
 * under Cited by, or anything the user added by hand. Used only to decide
 * what's missing; nothing already linked is ever touched or removed.
 *
 * Read down to the note name: when a note is renamed, Obsidian may rewrite
 * links to it as `[[Papers/Name]]` or `[[Name|Old name]]`, and taking those
 * for a different note added the same link a second time. */
function existingLinks(block: string): Set<string> {
  const links = new Set<string>();
  for (const match of block.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = (match[1] as string).split("|")[0]!.split("#")[0]!.trim();
    links.add(target.split("/").pop()!.replace(/\.md$/i, ""));
  }
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
