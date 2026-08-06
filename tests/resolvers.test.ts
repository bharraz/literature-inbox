/**
 * Using both sources together: which one is asked first, and what happens
 * when one of them is off, empty, or broken.
 */

import { describe, expect, it } from "vitest";
import { doiResolver, titleResolver } from "../src/core/resolvers";
import { DOI, OPENALEX, makeId } from "../src/core/ids";
import { emptyWork, type Work } from "../src/core/types";

function work(doi: string, references: string[] = [], source = "openalex"): Work {
  const item = emptyWork(doi);
  item.doi = doi;
  item.title = doi;
  item.source = source;
  item.ids = [makeId(DOI, doi)];
  if (source === "openalex") item.ids.push(makeId(OPENALEX, `W${doi.length}`));
  item.references = references.map((ref) => makeId(DOI, ref));
  return item;
}

const asked: string[] = [];
const titleSource = (label: string, result?: Work) => ({
  async workByTitle() {
    asked.push(label);
    return result;
  },
});
const failingTitleSource = (label: string) => ({
  async workByTitle(): Promise<Work | undefined> {
    asked.push(label);
    throw new Error("down");
  },
});

describe("titleResolver", () => {
  it("asks the primary first and stops when it answers", async () => {
    asked.length = 0;
    const resolver = titleResolver(
      titleSource("crossref", work("10.1/a")),
      titleSource("openalex", work("10.1/b")),
    );

    const hit = await resolver.workByTitle("something");

    expect(hit?.doi).toBe("10.1/a");
    expect(asked).toEqual(["crossref"]);
  });

  it("falls through when the primary has no answer", async () => {
    asked.length = 0;
    const resolver = titleResolver(
      titleSource("crossref", undefined),
      titleSource("openalex", work("10.1/b")),
    );

    expect((await resolver.workByTitle("x"))?.doi).toBe("10.1/b");
    expect(asked).toEqual(["crossref", "openalex"]);
  });

  it("falls through when the primary throws", async () => {
    // One source being down must not lose the lookup, let alone the run.
    asked.length = 0;
    const resolver = titleResolver(failingTitleSource("crossref"), titleSource("openalex", work("10.1/b")));

    expect((await resolver.workByTitle("x"))?.doi).toBe("10.1/b");
    expect(asked).toEqual(["crossref", "openalex"]);
  });

  it("works with only one source configured", async () => {
    asked.length = 0;
    const resolver = titleResolver(undefined, titleSource("openalex", work("10.1/b")));
    expect((await resolver.workByTitle("x"))?.doi).toBe("10.1/b");
  });

  it("returns undefined rather than throwing when everything fails", async () => {
    asked.length = 0;
    const resolver = titleResolver(failingTitleSource("a"), failingTitleSource("b"));
    await expect(resolver.workByTitle("x")).resolves.toBeUndefined();
  });
});

describe("doiResolver", () => {
  it("prefers the primary and never asks about what it fully answered", async () => {
    const seen: string[][] = [];
    const resolver = doiResolver(
      { async worksByDois(dois) { seen.push(["primary", ...dois]); return [work("10.1/a", ["10.9/x"])]; } },
      { async worksByDois(dois) { seen.push(["fallback", ...dois]); return []; } },
    );

    const works = await resolver.worksByDois(["10.1/a"]);

    expect(works).toHaveLength(1);
    expect(works[0]?.source).toBe("openalex");
    expect(seen).toEqual([["primary", "10.1/a"]]);
  });

  it("asks the fallback about DOIs the primary missed entirely", async () => {
    const seen: string[][] = [];
    const resolver = doiResolver(
      { async worksByDois() { return [work("10.1/a", ["10.9/x"])]; } },
      { async worksByDois(dois) { seen.push(dois); return [work("10.1/b", ["10.9/y"], "crossref")]; } },
    );

    const works = await resolver.worksByDois(["10.1/a", "10.1/b"]);

    expect(seen).toEqual([["10.1/b"]]);
    expect(works.map((w) => w.doi).sort()).toEqual(["10.1/a", "10.1/b"]);
  });

  it("asks the fallback about a record the primary returned with no references", async () => {
    // The case that matters: a record with an empty reference list produces no
    // edges, which is indistinguishable from not having found it at all.
    const seen: string[][] = [];
    const resolver = doiResolver(
      { async worksByDois() { return [work("10.1/a", [])]; } },
      { async worksByDois(dois) { seen.push(dois); return [work("10.1/a", ["10.9/x"], "crossref")]; } },
    );

    const works = await resolver.worksByDois(["10.1/a"]);

    expect(seen).toEqual([["10.1/a"]]);
    expect(works[0]?.references).toEqual([{ namespace: "doi", value: "10.9/x" }]);
  });

  it("keeps the primary's identity while taking the fallback's references", async () => {
    const resolver = doiResolver(
      { async worksByDois() { return [work("10.1/a", [])]; } },
      { async worksByDois() { return [work("10.1/a", ["10.9/x"], "crossref")]; } },
    );

    const merged = (await resolver.worksByDois(["10.1/a"]))[0];

    expect(merged?.source).toBe("openalex");
    expect(merged?.ids.some((id) => id.namespace === OPENALEX)).toBe(true);
    expect(merged?.references).toHaveLength(1);
  });

  it("still answers when the primary throws", async () => {
    const resolver = doiResolver(
      { async worksByDois(): Promise<Work[]> { throw new Error("budget spent"); } },
      { async worksByDois() { return [work("10.1/a", ["10.9/x"], "crossref")]; } },
    );

    const works = await resolver.worksByDois(["10.1/a"]);
    expect(works.map((w) => w.source)).toEqual(["crossref"]);
  });

  it("still answers when the fallback throws", async () => {
    const resolver = doiResolver(
      { async worksByDois() { return [work("10.1/a", ["10.9/x"])]; } },
      { async worksByDois(): Promise<Work[]> { throw new Error("down"); } },
    );

    expect(await resolver.worksByDois(["10.1/a"])).toHaveLength(1);
  });

  it("works with the fallback switched off entirely", async () => {
    const resolver = doiResolver(
      { async worksByDois() { return [work("10.1/a", ["10.9/x"])]; } },
      undefined,
    );
    expect(await resolver.worksByDois(["10.1/a"])).toHaveLength(1);
  });

  it("returns nothing rather than throwing when both are absent", async () => {
    const resolver = doiResolver(undefined, undefined);
    await expect(resolver.worksByDois(["10.1/a"])).resolves.toEqual([]);
  });
});
