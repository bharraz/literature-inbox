import { describe, expect, it } from "vitest";
import { ARXIV_CATEGORIES, isKnownArxivCategory } from "../src/core/arxiv-categories";

describe("isKnownArxivCategory", () => {
  it("recognizes a real category code", () => {
    expect(isKnownArxivCategory("cs.CL")).toBe(true);
  });

  it("is case-insensitive, since codes are conventionally lowercase but easy to mistype", () => {
    expect(isKnownArxivCategory("CS.cl")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isKnownArxivCategory("  quant-ph  ")).toBe(true);
  });

  it("rejects an unknown code", () => {
    expect(isKnownArxivCategory("not.a.real.category")).toBe(false);
  });

  it("has no duplicate codes", () => {
    const codes = ARXIV_CATEGORIES.map((c) => c.code.toLowerCase());
    expect(new Set(codes).size).toBe(codes.length);
  });
});
