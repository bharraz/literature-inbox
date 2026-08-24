/**
 * The source-agnostic model, mirroring scriptorium's `model/` package.
 *
 * Deliberately a plain data shape with no methods and no Obsidian imports:
 * every module under `core/` must be testable in isolation, and the plugin
 * shell is the only place that touches the Obsidian API.
 */

/** A namespaced identity, serialized as `"<namespace>:<value>"` — see
 * docs/interop-spec.md §3.1 for the namespace list and normalization rules. */
export interface WorkId {
  namespace: string;
  value: string;
}

export interface Author {
  firstName?: string;
  lastName: string;
}

/** One paper. `references` holds exact citation edges when the source
 * provides them (OpenAlex does); an empty list just means "unknown", never
 * "cites nothing". */
export interface Work {
  /** Stable key within a fetch batch — the bare source id. */
  key: string;
  itemType: string;
  ids: WorkId[];
  title?: string;
  abstract?: string;
  /** Publication date, `YYYY-MM-DD` where the source gives one. */
  date?: string;
  doi?: string;
  url?: string;
  publication?: string;
  authors: Author[];
  references: WorkId[];
  /** Citation count, when the source gives one (OpenAlex does; arXiv and
   * Crossref generally don't) — a real impact signal for ranking, rather than
   * relying on incidental fetch order. Undefined, not 0: "unknown" must not
   * outrank or underrank a work whose count is genuinely zero. */
  citedByCount?: number;
  /**
   * Subject terms, kept separate by vocabulary because they behave
   * differently: `topics` is a small curated set, `keywords` is close to what
   * an author would write, and `concepts` is a large machine-assigned
   * hierarchy that goes broad fast ("Physics"). The user chooses which of
   * them, if any, reach their notes.
   */
  topics: string[];
  keywords: string[];
  concepts: string[];
  /** Which source this arrived from, recorded in note frontmatter so a note
   * always says where it came from (the suite's transparency principle). */
  source?: string;
}

export function emptyWork(key: string): Work {
  return {
    key,
    itemType: "journalArticle",
    ids: [],
    authors: [],
    references: [],
    topics: [],
    keywords: [],
    concepts: [],
  };
}

/** Publication year, derived from `date` rather than stored separately so the
 * two can't disagree. */
export function workYear(work: Work): string | undefined {
  const match = work.date?.match(/^(\d{4})/);
  return match ? match[1] : undefined;
}

export function firstAuthorLastName(work: Work): string | undefined {
  return work.authors[0]?.lastName || undefined;
}

export function fullName(author: Author): string {
  return [author.firstName, author.lastName].filter(Boolean).join(" ").trim();
}
