/**
 * `_Inbox.md`, the dated front page — docs/interop-spec.md §6.3.
 *
 * Sections are dates, newest first; entries keep insertion order within a
 * date. Regenerated in full every run, so it holds no state of its own: what
 * you keep is expressed by *moving a note out of `Inbox/`*, not by ticking a
 * box here.
 */

export interface InboxEntry {
  /** Note filename without extension, used as the wikilink target. */
  filename: string;
  /** `YYYY-MM-DD` grouping key. */
  date: string;
  /** Display text, when it should differ from the filename. */
  label?: string;
  /** How many vault papers this arrival cites — the "is this connected to
   * anything I care about" signal, shown inline so the front page is useful
   * without opening the graph. */
  edgeCount?: number;
}

export const INBOX_PAGE_NAME = "_Inbox";

function renderEntry(entry: InboxEntry): string {
  const link =
    entry.label && entry.label !== entry.filename
      ? `[[${entry.filename}|${entry.label}]]`
      : `[[${entry.filename}]]`;
  if (entry.edgeCount && entry.edgeCount > 0) {
    const noun = entry.edgeCount === 1 ? "link" : "links";
    return `- ${link} — ${entry.edgeCount} ${noun} into your library`;
  }
  return `- ${link}`;
}

export function renderInboxPage(entries: readonly InboxEntry[], intro = ""): string {
  const sections = new Map<string, InboxEntry[]>();
  for (const entry of entries) {
    const bucket = sections.get(entry.date);
    if (bucket) bucket.push(entry);
    else sections.set(entry.date, [entry]);
  }

  const lines = ["# Literature Inbox", ""];
  if (intro) lines.push(intro, "");

  if (sections.size === 0) {
    lines.push("Nothing here yet. Run **Update inbox** to fetch new papers.");
    return lines.join("\n").trimEnd() + "\n";
  }

  lines.push(
    "Move a note into your papers folder to keep it — anything left here is " +
      "cleaned up once it's past the keep window.",
    "",
  );

  for (const date of [...sections.keys()].sort().reverse()) {
    lines.push(`## ${date}`, "");
    for (const entry of sections.get(date) as InboxEntry[]) lines.push(renderEntry(entry));
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
