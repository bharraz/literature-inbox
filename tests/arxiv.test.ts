/** arXiv client tests against the real recorded Atom responses. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArxivClient, parseAtomFeed } from "../src/core/arxiv";
import type { Transport, TransportResponse } from "../src/core/http";

const FIXTURES = join(__dirname, "fixtures");
const load = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

class SingleTransport implements Transport {
  readonly requested: string[] = [];
  constructor(private readonly body: string) {}
  async get(url: string): Promise<TransportResponse> {
    this.requested.push(url);
    return { status: 200, text: this.body };
  }
}

const noSleep = async () => {};
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams.entries());

describe("parseAtomFeed against a real category feed", () => {
  it("parses every entry", () => {
    const works = parseAtomFeed(load("arxiv_cs_cl_recent.xml"));
    expect(works.length).toBeGreaterThan(0);
    expect(works.every((w) => w.title && w.title.length > 0)).toBe(true);
    expect(works.every((w) => w.source === "arxiv")).toBe(true);
  });

  it("records bare arxiv ids with the version stripped", () => {
    const works = parseAtomFeed(load("arxiv_cs_cl_recent.xml"));
    for (const work of works) {
      const arxivId = work.ids.find((id) => id.namespace === "arxiv");
      expect(arxivId).toBeDefined();
      expect(arxivId?.value).not.toMatch(/v\d+$/);
      expect(arxivId?.value).not.toContain("/abs/");
    }
  });

  it("collapses the whitespace Atom wraps titles in", () => {
    const works = parseAtomFeed(load("arxiv_cs_cl_recent.xml"));
    for (const work of works) {
      expect(work.title).not.toMatch(/\s{2,}/);
      expect(work.title).not.toMatch(/\n/);
    }
  });

  it("gives arxiv arrivals no reference list (backfilled later)", () => {
    // arXiv publishes no citations; these arrive edge-less by design.
    const works = parseAtomFeed(load("arxiv_cs_cl_recent.xml"));
    expect(works.every((w) => w.references.length === 0)).toBe(true);
  });
});

describe("parseAtomFeed on a single entry", () => {
  it("extracts title, authors, abstract and date", () => {
    const works = parseAtomFeed(load("arxiv_single_entry.xml"));
    expect(works).toHaveLength(1);
    const work = works[0]!;
    expect(work.title).toBe("Attention Is All You Need");
    expect(work.itemType).toBe("preprint");
    expect(work.authors.length).toBeGreaterThan(0);
    expect(work.abstract).toBeTruthy();
    expect(work.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("splits author display names into first and last", () => {
    const work = parseAtomFeed(load("arxiv_single_entry.xml"))[0]!;
    const vaswani = work.authors.find((a) => a.lastName === "Vaswani");
    expect(vaswani).toBeDefined();
    expect(vaswani?.firstName).toBe("Ashish");
  });
});

describe("malformed and empty input", () => {
  it("throws on malformed XML rather than silently finding no entries", () => {
    expect(() => parseAtomFeed("<feed><entry></feed>")).toThrow();
  });

  it("returns nothing for a well-formed feed with no entries", () => {
    expect(parseAtomFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toEqual([]);
  });

  it("skips an entry with no title", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry>' +
      "<id>http://arxiv.org/abs/1234.5678v1</id></entry></feed>";
    expect(parseAtomFeed(xml)).toEqual([]);
  });
});

describe("ArxivClient requests", () => {
  it("asks for a category sorted by submission date", async () => {
    const transport = new SingleTransport(load("arxiv_cs_cl_recent.xml"));
    const client = new ArxivClient(transport, { sleep: noSleep });
    await client.categoryFeed("cs.CL", 25);
    const query = queryOf(transport.requested[0] as string);
    expect(query.search_query).toBe("cat:cs.CL");
    expect(query.sortBy).toBe("submittedDate");
    expect(query.max_results).toBe("25");
  });

  it("looks a single paper up by bare id", async () => {
    const transport = new SingleTransport(load("arxiv_single_entry.xml"));
    const client = new ArxivClient(transport, { sleep: noSleep });
    const work = await client.workById("1706.03762v5");
    expect(queryOf(transport.requested[0] as string).id_list).toBe("1706.03762");
    expect(work?.title).toBe("Attention Is All You Need");
  });
});
