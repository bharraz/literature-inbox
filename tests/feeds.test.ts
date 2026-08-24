import { describe, expect, it } from "vitest";
import { arxivCategoryFeedUrl, looksLikeArxivCategory } from "../src/core/feeds";

describe("arXiv categories as feeds", () => {
  it("builds the feed URL a category stands for", () => {
    // Researchers know "quant-ph"; nobody knows rss.arxiv.org.
    expect(arxivCategoryFeedUrl("quant-ph")).toBe("https://rss.arxiv.org/rss/quant-ph");
    expect(arxivCategoryFeedUrl(" cs.CL ")).toBe("https://rss.arxiv.org/rss/cs.CL");
  });

  it("recognises the real category shapes", () => {
    for (const good of ["quant-ph", "cs.CL", "math.AG", "astro-ph.HE"]) {
      expect(looksLikeArxivCategory(good)).toBe(true);
    }
  });

  it("recognises a hyphenated subcategory too", () => {
    // Regression: a first version only allowed the hyphen before the dot, so
    // "Test" reported these — a real, sizeable slice of the taxonomy — as
    // not found even though they're entirely valid.
    for (const good of ["physics.atom-ph", "cond-mat.mes-hall", "physics.acc-ph"]) {
      expect(looksLikeArxivCategory(good)).toBe(true);
    }
  });

  it("rejects an obvious typo before it becomes a silently empty feed", () => {
    for (const bad of ["quantph.", "https://example.org/f.xml", "", "cs/CL"]) {
      expect(looksLikeArxivCategory(bad)).toBe(false);
    }
  });
});
