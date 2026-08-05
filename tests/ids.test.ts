import { describe, expect, it } from "vitest";
import {
  bareArxivId,
  bareOpenAlexId,
  idsIntersect,
  isDistinctiveTitle,
  normalizeDoi,
  normalizeTitle,
  originIds,
  titlesMatch,
} from "../src/core/ids";
import { emptyWork } from "../src/core/types";

describe("origin id normalization (spec §3.1)", () => {
  it("strips doi.org prefixes and lowercases", () => {
    expect(normalizeDoi("https://doi.org/10.5555/Attention")).toBe("10.5555/attention");
    expect(normalizeDoi("HTTP://doi.org/10.1/X")).toBe("10.1/x");
    expect(normalizeDoi("10.1/Bare")).toBe("10.1/bare");
  });

  it("treats blanks as absent", () => {
    expect(normalizeDoi(undefined)).toBeUndefined();
    expect(normalizeDoi("")).toBeUndefined();
    expect(normalizeDoi("   ")).toBeUndefined();
  });

  it("reduces openalex ids to the bare id", () => {
    expect(bareOpenAlexId("https://openalex.org/W2963403868")).toBe("W2963403868");
    expect(bareOpenAlexId("W123")).toBe("W123");
  });

  it("reduces arxiv ids to the bare id and drops the version suffix", () => {
    expect(bareArxivId("http://arxiv.org/abs/2607.15277v1")).toBe("2607.15277");
    expect(bareArxivId("http://arxiv.org/abs/2607.15277v12")).toBe("2607.15277");
    expect(bareArxivId("2607.15277")).toBe("2607.15277");
  });

  it("does not mistake a non-numeric v for a version marker", () => {
    expect(bareArxivId("cond-mat/9901001")).toBe("9901001");
    expect(bareArxivId("hep-thv")).toBe("hep-thv");
  });
});

describe("originIds (spec §3.2)", () => {
  it("lists the doi first, then every other id", () => {
    const work = emptyWork("W1");
    work.doi = "10.5555/Attention";
    work.ids = [
      { namespace: "openalex", value: "W2963403868" },
      { namespace: "arxiv", value: "1706.03762" },
    ];
    expect(originIds(work)).toEqual([
      "doi:10.5555/attention",
      "openalex:W2963403868",
      "arxiv:1706.03762",
    ]);
  });

  it("never duplicates an id already present in ids[]", () => {
    const work = emptyWork("W1");
    work.doi = "10.1/x";
    work.ids = [{ namespace: "doi", value: "10.1/x" }];
    expect(originIds(work)).toEqual(["doi:10.1/x"]);
  });

  it("falls back to the work key when nothing else is known", () => {
    expect(originIds(emptyWork("SOLO"))).toEqual(["key:SOLO"]);
  });
});

describe("idsIntersect", () => {
  it("matches on any overlapping id, not a preferred one", () => {
    // The whole point: the other tool usually knows the paper by a different id.
    expect(idsIntersect(["zotero:ABC"], ["doi:10.1/x", "zotero:ABC"])).toBe(true);
    expect(idsIntersect(["zotero:ABC"], ["doi:10.1/x", "openalex:W1"])).toBe(false);
  });

  it("is false for empty sets", () => {
    expect(idsIntersect([], ["doi:10.1/x"])).toBe(false);
    expect(idsIntersect(["doi:10.1/x"], [])).toBe(false);
  });
});

describe("title normalization (spec §3.3)", () => {
  it("folds case, punctuation and spacing", () => {
    expect(normalizeTitle("Attention Is All You Need!")).toBe("attentionisallyouneed");
    expect(normalizeTitle("attention is all-you   need")).toBe("attentionisallyouneed");
  });

  it("matches equivalent titles", () => {
    expect(titlesMatch("Attention Is All You Need", "attention is all-you need!")).toBe(true);
  });

  it("stays pure equality, matching the spec rule exactly", () => {
    // No heuristics in here: this half must mirror find_by_title byte for
    // byte. Trustworthiness is isDistinctiveTitle's job, not this function's.
    expect(titlesMatch("Preface", "preface")).toBe(true);
  });

  it("is false when either side is missing", () => {
    expect(titlesMatch(undefined, "Attention Is All You Need")).toBe(false);
    expect(titlesMatch("Attention Is All You Need", undefined)).toBe(false);
  });
});

describe("isDistinctiveTitle (dedup policy, not spec format)", () => {
  it("accepts real paper titles", () => {
    expect(isDistinctiveTitle("Attention Is All You Need")).toBe(true);
    expect(isDistinctiveTitle("Deep Residual Learning")).toBe(true);
  });

  it("rejects generic titles that collide across unrelated papers", () => {
    expect(isDistinctiveTitle("Preface")).toBe(false);
    expect(isDistinctiveTitle("Introduction")).toBe(false);
    expect(isDistinctiveTitle("Editorial Board")).toBe(false);
    expect(isDistinctiveTitle("Supplementary Material")).toBe(false);
  });

  it("rejects three very short words", () => {
    expect(isDistinctiveTitle("A B C")).toBe(false);
  });

  it("rejects missing titles", () => {
    expect(isDistinctiveTitle(undefined)).toBe(false);
    expect(isDistinctiveTitle("")).toBe(false);
  });
});
