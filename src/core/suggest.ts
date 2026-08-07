/**
 * "What should I read?" — picking one paper out of the pile.
 *
 * The graph answers "what is worth my attention" visually, but only once you
 * are already looking at it. This is the other mood: you have ten minutes, you
 * do not want to browse, you want a paper.
 *
 * Not uniformly random. A paper connected to five things you kept is a better
 * suggestion than an isolated dot, and that is the same judgement the graph
 * makes visually — so the weighting is the product thesis expressed as
 * arithmetic. Random *among* the plausible ones, rather than always the
 * top-ranked paper, because a deterministic "best" suggestion is the same
 * paper every day until you read it.
 */

/** How a paper has been triaged, when the user has said. */
export type ReadStatus = "unread" | "to-read" | "read" | "reference";

export interface Candidate {
  notePath: string;
  title: string;
  /** How many papers in the vault this one cites. */
  edgeCount: number;
  status: ReadStatus;
  /** True for papers still awaiting a verdict, which are the point of a
   * suggestion; kept papers are offered too, but only as a fallback. */
  inInbox: boolean;
}

/**
 * Statuses that take a paper out of the running.
 *
 * `read` is obvious. `reference` is the one worth having: a methods paper or a
 * standard you keep for lookup is not something to sit down and read, and
 * without a way to say so it would be suggested forever.
 */
export function isEligible(candidate: Candidate): boolean {
  return candidate.status !== "read" && candidate.status !== "reference";
}

/**
 * Weight for the weighted draw.
 *
 * Connectivity dominates, with a floor so an unconnected paper is unlikely
 * rather than impossible — a fresh preprint that OpenAlex has not indexed yet
 * is not a bad paper, it is a paper we know nothing about. `to-read` doubles
 * the weight, because the user has already said they mean to read it.
 */
export function weigh(candidate: Candidate): number {
  const connectivity = 1 + Math.min(candidate.edgeCount, 10);
  const intent = candidate.status === "to-read" ? 2 : 1;
  const freshness = candidate.inInbox ? 1.5 : 1;
  return connectivity * intent * freshness;
}

/**
 * Choose one, or nothing when there is nothing to choose.
 *
 * `random` is injected so the choice is testable; callers pass `Math.random`.
 */
export function suggest(
  candidates: readonly Candidate[],
  random: () => number = Math.random,
): Candidate | undefined {
  const eligible = candidates.filter(isEligible);
  if (eligible.length === 0) return undefined;

  const weights = eligible.map(weigh);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return eligible[0];

  let target = random() * total;
  for (const [index, weight] of weights.entries()) {
    target -= weight;
    if (target < 0) return eligible[index];
  }
  // Only reachable through floating-point drift on the final element.
  return eligible[eligible.length - 1];
}

/** Why this one was offered, in a phrase. */
export function explain(candidate: Candidate): string {
  const parts: string[] = [];
  if (candidate.edgeCount > 0) {
    const noun = candidate.edgeCount === 1 ? "paper" : "papers";
    parts.push(`cites ${candidate.edgeCount} ${noun} in your library`);
  } else {
    parts.push("no citation links yet");
  }
  if (candidate.status === "to-read") parts.push("you marked it to-read");
  parts.push(candidate.inInbox ? "still in your inbox" : "in your library");
  return parts.join(" · ");
}

// --- read status in frontmatter ---------------------------------------------

/**
 * The frontmatter key. A plain text property, not a tag.
 *
 * Obsidian's property types are text, list, number, checkbox and date — there
 * is **no native select/enum type**, so a literal dropdown is not available.
 * A text property is the closest thing: Obsidian autocompletes values it has
 * seen elsewhere in the vault, so after the first note it behaves like one.
 *
 * A tag would give autocomplete too, and would colour in the graph — but it
 * would also put three machine-ish values into the tag pane for every paper,
 * which is the clutter the note settings already work to avoid. The user's own
 * tags stay theirs.
 */
export const READ_STATUS_KEY = "read-status";

export const READ_STATUS_VALUES: readonly ReadStatus[] = ["to-read", "read", "reference"];

export function parseReadStatus(value: unknown): ReadStatus {
  if (typeof value !== "string") return "unread";
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "read") return "read";
  if (normalized === "to-read" || normalized === "toread") return "to-read";
  if (normalized === "reference" || normalized === "reference-only") return "reference";
  return "unread";
}

/** Read the status out of a note's frontmatter without a YAML parser. */
export function readStatusOf(content: string): ReadStatus {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return "unread";
  const line = match[1]
    ?.split(/\r?\n/)
    .find((entry) => entry.startsWith(`${READ_STATUS_KEY}:`));
  return parseReadStatus(line?.slice(READ_STATUS_KEY.length + 1));
}

/**
 * Set the status in a note's frontmatter, adding the key if absent.
 *
 * Returns the content unchanged when there is no frontmatter to edit — a note
 * the plugin did not generate is not ours to restructure.
 */
export function withReadStatus(content: string, status: ReadStatus): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || match[1] === undefined) return content;

  const body = match[1];
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${READ_STATUS_KEY}:`));
  const entry = `${READ_STATUS_KEY}: ${status}`;

  if (index >= 0) lines[index] = entry;
  else lines.push(entry);

  return content.replace(body, lines.join("\n"));
}
