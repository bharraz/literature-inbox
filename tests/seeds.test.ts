import { describe, expect, it } from "vitest";
import { parseSeedList, seedCount, seedsFromOriginIds } from "../src/core/seeds";

describe("parseSeedList", () => {
  it("takes a plain DOI", () => {
    expect(parseSeedList("10.1103/PhysRevA.101.032330").dois).toEqual([
      "10.1103/physreva.101.032330",
    ]);
  });

  it("takes the DOI URL you actually copy from a browser", () => {
    // The bug this replaces: a `startsWith("10.")` check sent this to the
    // arXiv client, where it could only ever fail.
    const list = parseSeedList("https://doi.org/10.1234/abc");
    expect(list.dois).toEqual(["10.1234/abc"]);
    expect(list.arxivIds).toEqual([]);
  });

  it("strips a doi: prefix", () => {
    expect(parseSeedList("doi:10.1234/abc").dois).toEqual(["10.1234/abc"]);
  });

  it("takes arXiv ids bare, prefixed, and as URLs", () => {
    const list = parseSeedList("2401.12345\narXiv:2402.00001\nhttps://arxiv.org/abs/2403.99999");
    expect(list.arxivIds).toEqual(["2401.12345", "2402.00001", "2403.99999"]);
  });

  it("drops an arXiv version suffix, so v1 and v2 are one paper", () => {
    expect(parseSeedList("2401.12345v3\n2401.12345").arxivIds).toEqual(["2401.12345"]);
  });

  it("understands the pre-2007 arXiv scheme", () => {
    expect(parseSeedList("hep-th/9901001").arxivIds).toEqual(["hep-th/9901001"]);
  });

  it("splits on newlines and whitespace, and tolerates trailing commas", () => {
    const list = parseSeedList("10.1234/one, 10.1234/two,\n10.1234/three");
    expect(list.dois).toEqual(["10.1234/one", "10.1234/two", "10.1234/three"]);
  });

  it("does not split inside a DOI that legally contains a comma", () => {
    // Commas are legal in a DOI, so they are not separators. Splitting on them
    // would silently corrupt the identifier into two dead ones.
    expect(parseSeedList("10.1234/a,b").dois).toEqual(["10.1234/a,b"]);
  });

  it("reports what it could not read rather than dropping it", () => {
    const list = parseSeedList("10.1234/ok\nnot an id\nbanana");
    expect(list.dois).toEqual(["10.1234/ok"]);
    expect(list.unrecognised).toEqual(["not", "an", "id", "banana"]);
  });

  it("de-duplicates so a repeated paste costs one lookup", () => {
    const list = parseSeedList("10.1234/abc\n10.1234/ABC\nhttps://doi.org/10.1234/abc");
    expect(list.dois).toEqual(["10.1234/abc"]);
  });

  it("is empty for empty input", () => {
    const list = parseSeedList("   \n  ");
    expect(seedCount(list)).toBe(0);
    expect(list.unrecognised).toEqual([]);
  });
});

describe("seedsFromOriginIds", () => {
  it("prefers the OpenAlex id, which resolves in one batched lookup", () => {
    const seeds = seedsFromOriginIds([["doi:10.1234/a", "openalex:W1"]], 10);
    expect(seeds.openAlexIds).toEqual(["W1"]);
    expect(seeds.dois).toEqual([]);
  });

  it("falls back to the DOI when there is no OpenAlex id", () => {
    const seeds = seedsFromOriginIds([["doi:10.1234/a"]], 10);
    expect(seeds.dois).toEqual(["10.1234/a"]);
  });

  it("skips notes with neither, since they cannot be looked up", () => {
    const seeds = seedsFromOriginIds([["zotero:ABCD1234"], ["key:something"]], 10);
    expect(seeds.openAlexIds).toEqual([]);
    expect(seeds.dois).toEqual([]);
  });

  it("caps the number of seeds so a big library can't issue a huge expansion", () => {
    const sets = Array.from({ length: 100 }, (_, i) => [`openalex:W${i}`]);
    expect(seedsFromOriginIds(sets, 5).openAlexIds).toHaveLength(5);
  });

  it("de-duplicates repeated ids", () => {
    expect(seedsFromOriginIds([["openalex:W1"], ["openalex:W1"]], 10).openAlexIds).toEqual(["W1"]);
  });
});

describe("arXiv-minted DOIs", () => {
  it("treats 10.48550/arXiv.* as an arXiv id, not a DOI", () => {
    // These are registered with DataCite, so Crossref 404s on them, and
    // OpenAlex often has no record of a fresh preprint. arXiv's own API
    // always resolves the id, which is right there in the string.
    const list = parseSeedList("https://doi.org/10.48550/arXiv.2608.04079");
    expect(list.arxivIds).toEqual(["2608.04079"]);
    expect(list.dois).toEqual([]);
  });

  it("handles the bare form and mixed case", () => {
    expect(parseSeedList("10.48550/ARXIV.2401.12345").arxivIds).toEqual(["2401.12345"]);
  });

  it("leaves ordinary DOIs alone", () => {
    const list = parseSeedList("https://doi.org/10.1103/PhysRevA.108.022412");
    expect(list.dois).toEqual(["10.1103/physreva.108.022412"]);
    expect(list.arxivIds).toEqual([]);
  });

  it("de-duplicates a paper given as both an arXiv DOI and a bare id", () => {
    expect(parseSeedList("10.48550/arXiv.2401.12345\n2401.12345").arxivIds).toEqual([
      "2401.12345",
    ]);
  });
});
