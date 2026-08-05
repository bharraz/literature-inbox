import { describe, expect, it } from "vitest";
import { backfillReferences, type BackfillCandidate } from "../src/core/backfill";
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
  workByDoi: async () => undefined,
  workByTitle: async () => undefined,
};

describe("backfillReferences", () => {
  it("skips arrivals that already have edges", async () => {
    let called = false;
    const outcomes = await backfillReferences(
      [candidate({ hasEdges: true })],
      {
        workByDoi: async () => { called = true; return undefined; },
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
        workByDoi: async (doi) => {
          expect(doi).toBe("10.1/x");
          return resolvedWork("A Fresh Preprint About Things", ["W9"], "10.1/x");
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

  it("falls back to a title lookup when there is no DOI", async () => {
    const outcomes = await backfillReferences(
      [candidate()],
      {
        workByDoi: async () => undefined,
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
      [candidate()],
      {
        workByDoi: async () => undefined,
        workByTitle: async () => resolvedWork("An Entirely Different Paper", ["W9"]),
      },
      titlesMatch,
    );
    expect(outcomes).toEqual([]);
  });

  it("ignores a resolution that has no references either", async () => {
    const outcomes = await backfillReferences(
      [candidate()],
      {
        workByDoi: async () => undefined,
        workByTitle: async () => resolvedWork("A Fresh Preprint About Things", []),
      },
      titlesMatch,
    );
    expect(outcomes).toEqual([]);
  });

  it("does not re-report an id the note already has", async () => {
    const outcomes = await backfillReferences(
      [candidate({ originIds: ["doi:10.1/x"] })],
      {
        workByDoi: async () => resolvedWork("A Fresh Preprint About Things", ["W9"], "10.1/x"),
        workByTitle: async () => undefined,
      },
      titlesMatch,
    );
    expect(outcomes[0]?.newIds).not.toContain("doi:10.1/x");
  });

  it("survives a lookup failure without losing the other candidates", async () => {
    let call = 0;
    const outcomes = await backfillReferences(
      [
        candidate({ notePath: "Inbox/Fails.md", originIds: ["doi:10.1/fail"] }),
        candidate({ notePath: "Inbox/Works.md", originIds: ["doi:10.1/ok"] }),
      ],
      {
        workByDoi: async () => {
          call += 1;
          if (call === 1) throw new Error("offline");
          return resolvedWork("A Fresh Preprint About Things", ["W9"], "10.1/ok");
        },
        workByTitle: async () => undefined,
      },
      titlesMatch,
    );
    expect(outcomes.map((o) => o.notePath)).toEqual(["Inbox/Works.md"]);
  });

  it("caps how many lookups one run performs", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      candidate({ notePath: `Inbox/Paper ${i}.md`, originIds: [`doi:10.1/${i}`] }),
    );
    const outcomes = await backfillReferences(
      many,
      {
        workByDoi: async (doi) => resolvedWork("A Fresh Preprint About Things", ["W9"], doi),
        workByTitle: async () => undefined,
      },
      titlesMatch,
      5,
    );
    expect(outcomes).toHaveLength(5);
  });

  it("does nothing when there is nothing to resolve", async () => {
    await expect(backfillReferences([], noResolver, titlesMatch)).resolves.toEqual([]);
  });
});
