/**
 * Recovering a note's identity from the note itself.
 *
 * Why this exists: keeping a paper is nothing more than moving its note out
 * of `Inbox/` — there is no separate manifest or plugin-state record of what
 * that move means. Every note this plugin writes records its `origin-ids`
 * and `title` in frontmatter, so a kept note carries its own identity with
 * it wherever the user files it, and scanning the papers folder recovers
 * that directly. Without this, the next update would find no record of a
 * kept paper and fetch it straight back in.
 */

import { DOI, normalizeDoi } from "./ids";

export interface NoteIdentity {
  originIds: string[];
  title?: string;
}

/** Strip surrounding quotes and unescape, matching the writer in notes.ts. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

/**
 * Parse the leading `---` frontmatter block into identity fields.
 *
 * Deliberately a narrow reader rather than a YAML parser: this only has to
 * understand the shape this project writes (scalars and simple `- ` lists),
 * and shipping a YAML dependency to read two keys would be absurd. Anything
 * unrecognised is ignored — a hand-edited note must never break a run.
 */
export function parseNoteIdentity(content: string): NoteIdentity | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const lines = content.slice(3, end).split("\n");

  const identity: NoteIdentity = { originIds: [] };
  let listKey: string | undefined;

  // One place that appends, so an id reachable two ways — a DOI written both
  // as its own frontmatter field and inside `origin-ids` — is recorded once.
  const addId = (id: string) => {
    if (id && !identity.originIds.includes(id)) identity.originIds.push(id);
  };

  for (const line of lines) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      if (listKey === "origin-ids") addId(unquote(listItem[1] as string));
      continue;
    }

    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const key = field[1] as string;
    const value = unquote(field[2] as string);
    listKey = value === "" ? key : undefined;

    if (key === "title" && value) identity.title = value;
    if (key === "doi" && value) {
      // The `doi` field keeps its source casing in frontmatter while the
      // origin id is lowercased — normalize before recording it.
      const doi = normalizeDoi(value);
      if (doi) addId(`${DOI}:${doi}`);
    }
  }

  if (identity.originIds.length === 0 && !identity.title) return undefined;
  return identity;
}
