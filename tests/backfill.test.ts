import { describe, expect, it } from "vitest";
import {
  arxivDerivedDoi,
  backfillReferences,
  hasExactIdentifier,
  type BackfillCandidate,
} from "../src/core/backfill";
import { titlesMatch } from "../src/core/ids";
import { emptyWork, type Work } from "../src/core/types";

function resolvedWork(title: string, refs: string[], doi?: string, openAlexId = "W1"): Work {
  const work = emptyWork(openAlexId);
  work.title = title;
  work.doi = doi;
  work.ids = [{ namespace: "openalex", value: openAlexId }];
  if (doi) work.ids.push({ namespace: "doi", value: doi });
  work.references = refs.map((r) => ({ namespace: "openalex", value: r }));
  return work;
}

const candidate = (overrides: Partial<BackfillCandidate> = {}): BackfillCandidate => ({
  notePath: "Inbox/A Fresh Preprint.md",
  originIds: ["arxiv:2401.12345"],
  title: "A Fresh Preprint About Things",
  hasEdges: false,
  ...overrides,
});

const noResolver = {
  worksByDois: async () => [],
  workByTitle: async () => undefined,
};

describe("backfillReferences", () => {
  it("skips arrivals that already have edges", async () => {
    let called = false;
    const outcomes = await backfillReferences(
      [candidate({ hasEdges: true })],
      {
        worksByDois: async () => { called = true; return []; },
        workByTitle: async () => { called = true; return undefined; },
      },
      titlesMatch,
    );
    expect(called).toBe(false);
    expect(outcomes).toEqual([]);
  });

  it("resolves by DOI when one is known", async () => {
    const outcomes = await backfillReferences(
      [candidate({ originIds: ["doi:10.1/x", "arxiv:2401.12345"] })],
      {
        worksByDois: async (dois: string[]) => {
          // One request for every DOI in the run, not one request each.
          expect(dois).toEqual(["10.1/x"]);
          return [resolvedWork("A Fresh Preprint About Things", ["W9"], "10.1/x")];
        },
        workByTitle: async () => {
          throw new Error("must not fall back to title when a DOI is known");
        },
      },
      titlesMatch,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.references).toEqual([{ namespace: "openalex", value: "W9" }]);
  });

  // No DOI and no arXiv id: the only real "must guess by title" case, since
  // an arXiv id now resolves through the cheap, exact, derived-DOI path
  // instead (see "resolves an arXiv-only arrival by its derived DOI" below).
  const titleOnly = (overrides: Partial<BackfillCandidate> = {}) =>
    candidate({ originIds: ["rss:guid-123"], ...overrides });

  it("falls back to a title lookup when there is no DOI or arXiv id", async () => {
    const outcomes = await backfillReferences(
      [titleOnly()],
      {
        worksByDois: async () => [],
        workByTitle: async () => resolvedWork("a fresh preprint about things!", ["W9"], "10.1/y"),
      },
      titlesMatch,
    );
    expect(outcomes).toHaveLength(1);
    // Ids learned during the lookup come back so the note can be found by
    // them next time.
    expect(outcomes[0]?.newIds).toContain("doi:10.1/y");
    expect(outcomes[0]?.newIds).toContain("openalex:W1");
  });

  it("refuses a title lookup that returns a different paper", async () => {
    // Attaching the wrong paper's references is far worse than no references.
    const outcomes = await backfillReferences(
      [titleOnly()],
      {
        worksByDois: async () => [],
        workByTitle: async () => resolvedWork("An Entirely Different Paper", ["W9"]),
      },
      titlesMatch,
    );
    expect(outcomes).toEqual([]);
  });

  it("ignores a resolution that has no references either", async () => {
    const outcomes = await backfillReferences(
      [titleOnly()],
      {
        worksByDois: async () => [],
        workByTitle: async () => resolvedWork("A Fresh Preprint About Things", []),
      },
      titlesMatch,
    );
    expect(outcomes).toEqual([]);
  });

  it("resolves an arXiv-only arrival by its derived DOI, never falling back to title", async () => {
    // arXiv mints a DOI for every submission (10.48550/arxiv.<id>), which is
    // fully computable from the id alone — confirmed live against the real
    // API. This is what lets an arXiv arrival skip the expensive, un-
    // batchable title-search path entirely.
    const outcomes = await backfillReferences(
      [candidate({ originIds: ["arxiv:2401.12345"] })],
      {
        worksByDois: async (dois: string[]) => {
          expect(dois).toEqual([arxivDerivedDoi("2401.12345")]);
          return [
            resolvedWork(
              "A Fresh Preprint About Things",
              ["W9"],
              arxivDerivedDoi("2401.12345"),
            ),
          ];
        },
        workByTitle: async () => {
          throw new Error("must not fall back to title when an arXiv id is known");
        },
      },
      titlesMatch,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.references).toEqual([{ namespace: "openalex", value: "W9" }]);
  });

  it("does not re-report an id the note already has", async () => {
    const outcomes = await backfillReferences(
      [candidate({ originIds: ["doi:10.1/x"] })],
      {
        worksByDois: async () => [resolvedWork("A Fresh Preprint About Things", ["W9"], "10.1/x")],
        workByTitle: async () => undefined,
      },
      titlesMatch,
    );
    expect(outcomes[0]?.newIds).not.toContain("doi:10.1/x");
  });

  it("returns nothing rather than throwing when the batch fails", async () => {
    // Batching trades failure granularity for cost: one dead request now
    // means no references for that whole batch, where individual lookups
    // would have isolated it. That is the right trade only because the retry
    // schedule exists — those notes are simply due again later, and a run
    // that fails must still leave every note exactly as it was.
    const outcomes = await backfillReferences(
      [
        candidate({ notePath: "Inbox/One.md", originIds: ["doi:10.1/one"] }),
        candidate({ notePath: "Inbox/Two.md", originIds: ["doi:10.1/two"] }),
      ],
      {
        worksByDois: async () => {
          throw new Error("offline");
        },
        workByTitle: async () => undefined,
      },
      titlesMatch,
    );
    expect(outcomes).toEqual([]);
  });

  it("still falls back to a title lookup when a note has no DOI or arXiv id", async () => {
    const outcomes = await backfillReferences(
      [titleOnly({ notePath: "Inbox/Titled.md" })],
      {
        worksByDois: async () => {
          throw new Error("should not be asked: no DOIs among the candidates");
        },
        workByTitle: async () => resolvedWork("A Fresh Preprint About Things", ["W9"]),
      },
      titlesMatch,
    );
    expect(outcomes.map((o) => o.notePath)).toEqual(["Inbox/Titled.md"]);
  });

  it("caps how many title lookups one run performs, but never caps the batched DOI lookup", async () => {
    // The DOI batch is one shared, cheap request regardless of size — capping
    // it would ration something that costs nothing extra to leave uncapped.
    // Only the un-batchable, per-item title-search path needs rationing.
    const manyWithDoi = Array.from({ length: 40 }, (_, i) =>
      candidate({ notePath: `Inbox/DOI Paper ${i}.md`, originIds: [`doi:10.1/${i}`] }),
    );
    const manyTitleOnly = Array.from({ length: 40 }, (_, i) =>
      titleOnly({ notePath: `Inbox/Title Paper ${i}.md`, title: `Title Paper ${i}` }),
    );
    const outcomes = await backfillReferences(
      [...manyWithDoi, ...manyTitleOnly],
      {
        worksByDois: async (dois: string[]) =>
          dois.map((doi) => resolvedWork("A Fresh Preprint About Things", ["W9"], doi)),
        workByTitle: async (title: string) => resolvedWork(title, ["W9"]),
      },
      titlesMatch,
      5,
    );
    const fromDoi = outcomes.filter((o) => o.notePath.startsWith("Inbox/DOI"));
    const fromTitle = outcomes.filter((o) => o.notePath.startsWith("Inbox/Title"));
    expect(fromDoi).toHaveLength(40);
    expect(fromTitle).toHaveLength(5);
  });

  it("does nothing when there is nothing to resolve", async () => {
    await expect(backfillReferences([], noResolver, titlesMatch)).resolves.toEqual([]);
  });
});

describe("hasExactIdentifier", () => {
  it("is true for a real DOI or an arXiv id", () => {
    expect(hasExactIdentifier(["doi:10.1/x"])).toBe(true);
    expect(hasExactIdentifier(["arxiv:2401.12345"])).toBe(true);
  });

  it("is false for anything else, including an RSS guid", () => {
    expect(hasExactIdentifier(["rss:guid-123"])).toBe(false);
    expect(hasExactIdentifier([])).toBe(false);
  });
});
