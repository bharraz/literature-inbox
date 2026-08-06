import { describe, expect, it } from "vitest";
import { parseSeedList } from "../src/core/seeds";

describe("arXiv URL forms", () => {
  const cases: [string, string][] = [
    ["https://arxiv.org/abs/2401.12345", "2401.12345"],
    ["https://arxiv.org/abs/2401.12345v2", "2401.12345"],
    ["arxiv.org/abs/hep-th/9901001", "hep-th/9901001"],
    ["https://arxiv.org/pdf/2401.12345", "2401.12345"],
    ["https://arxiv.org/pdf/2401.12345v1.pdf", "2401.12345"],
    ["https://arxiv.org/html/2401.12345v1", "2401.12345"],
    ["https://arxiv.org/abs/2401.12345?context=quant-ph", "2401.12345"],
    ["https://www.arxiv.org/abs/2401.12345", "2401.12345"],
    ["https://arxiv.org/abs/2401.12345#comments", "2401.12345"],
    ["https://arxiv.org/abs/2401.12345/", "2401.12345"],
  ];
  for (const [url, expected] of cases) {
    it(`reads ${url}`, () => {
      expect(parseSeedList(url).arxivIds).toEqual([expected]);
    });
  }
});
