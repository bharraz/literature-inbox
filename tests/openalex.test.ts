/**
 * OpenAlex client tests, run against the *same recorded API responses* the
 * Python implementation uses (copied from
 * packages/scriptorium/tests/fixtures/scholarly/). They are real captured
 * traffic, including a genuine OpenAlex data-quality artifact: entries with
 * publication dates decades in the future, which the sanity filter must drop.
 *
 * No network access — a fake transport replays the exact bytes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OpenAlexClient,
  passesSanityFilters,
  reconstructAbstract,
  workFromOpenAlex,
} from "../src/core/openalex";
import type { Transport, TransportResponse } from "../src/core/http";

const FIXTURES = join(__dirname, "fixtures");
const load = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

class SequenceTransport implements Transport {
  readonly requested: string[] = [];
  constructor(private readonly bodies: (string | { status: number; text: string })[]) {}

  async get(url: string): Promise<TransportResponse> {
    this.requested.push(url);
    const next = this.bodies.shift();
    if (next === undefined) throw new Error("SequenceTransport ran out of responses");
    return typeof next === "string" ? { status: 200, text: next } : next;
  }
}

const noSleep = async () => {};
const clientWith = (bodies: (string | { status: number; text: string })[], today?: Date) => {
  const transport = new SequenceTransport(bodies);
  const client = new OpenAlexClient(transport, {
    mailto: "test@example.com",
    sleep: noSleep,
    today: today ? () => today : undefined,
  });
  return { client, transport };
};

const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams.entries());

describe("workByDoi against a real recorded response", () => {
  it("parses the work", async () => {
    const { client } = clientWith([load("openalex_by_doi.json")]);
    const work = await client.workByDoi("10.1109/cvpr.2016.90");
    expect(work?.title).toBe("Deep Residual Learning for Image Recognition");
    expect(work?.doi).toBe("10.1109/cvpr.2016.90");
    expect(work?.authors.length).toBeGreaterThan(0);
    expect(work?.source).toBe("openalex");
  });

  it("records both openalex and doi ids", async () => {
    const { client } = clientWith([load("openalex_by_doi.json")]);
    const work = await client.workByDoi("10.1109/cvpr.2016.90");
    const namespaces = work?.ids.map((id) => id.namespace) ?? [];
    expect(namespaces).toContain("openalex");
    expect(namespaces).toContain("doi");
  });

  it("populates references as exact openalex ids", async () => {
    const { client } = clientWith([load("openalex_by_doi.json")]);
    const work = await client.workByDoi("10.1109/cvpr.2016.90");
    expect(work?.references.length).toBeGreaterThan(0);
    expect(work?.references.every((r) => r.namespace === "openalex")).toBe(true);
    expect(work?.references.every((r) => !r.value.includes("/"))).toBe(true); // bare ids
  });

  it("returns undefined on 404 rather than throwing", async () => {
    const { client } = clientWith([{ status: 404, text: "" }]);
    await expect(client.workByDoi("10.1/nope")).resolves.toBeUndefined();
  });

  it("sends the polite-pool mailto", async () => {
    const { client, transport } = clientWith([load("openalex_by_doi.json")]);
    await client.workByDoi("10.1109/cvpr.2016.90");
    expect(queryOf(transport.requested[0] as string).mailto).toBe("test@example.com");
  });
});

describe("topWorks pagination", () => {
  it("follows the cursor across two real pages", async () => {
    const page1 = load("openalex_top_works_page1.json");
    const page2 = load("openalex_top_works_page2.json");
    const expectedCursor = JSON.parse(page1).meta.next_cursor as string;

    const { client, transport } = clientWith([page1, page2]);
    const works = await client.topWorks("machine learning", 6); // 3 per fixture page

    expect(transport.requested).toHaveLength(2);
    // Compare the decoded param, not a substring — the cursor is base64 and
    // gets percent-encoded in the URL.
    expect(queryOf(transport.requested[1] as string).cursor).toBe(expectedCursor);
    expect(works).toHaveLength(6);
  });

  it("stops at the requested limit", async () => {
    const { client } = clientWith([load("openalex_top_works_page1.json")]);
    const works = await client.topWorks("machine learning", 3);
    expect(works).toHaveLength(3);
  });

  it("filters to article-like types and sorts by citations", async () => {
    const { client, transport } = clientWith([load("openalex_top_works_page1.json")]);
    await client.topWorks("machine learning", 3);
    const query = queryOf(transport.requested[0] as string);
    expect(query.filter).toContain("type:");
    expect(query.sort).toBe("cited_by_count:desc");
  });

  it("treats a bare concept id as a concept filter, not free text", async () => {
    const { client, transport } = clientWith([load("openalex_top_works_page1.json")]);
    await client.topWorks("C41008148", 3);
    expect(queryOf(transport.requested[0] as string).filter).toContain("concepts.id:C41008148");
  });
});

describe("worksSince recency basis", () => {
  it("filters on index date by default, not publication date", async () => {
    // OpenAlex indexes papers weeks after their publication date. A window on
    // publication date drops everything indexed late, permanently.
    const { client, transport } = clientWith([load("openalex_works_since.json")]);
    await client.worksSince("quantum", "2026-07-01");
    const filter = queryOf(transport.requested[0] as string).filter ?? "";
    expect(filter).toContain("from_created_date:2026-07-01");
    expect(filter).not.toContain("from_publication_date");
  });

  it("still sorts newest-published first, so a capped run gets recent papers", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")]);
    await client.worksSince("quantum", "2026-07-01");
    expect(queryOf(transport.requested[0] as string).sort).toBe("publication_date:desc");
  });

  it("uses publication date when asked explicitly", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")]);
    await client.worksSince("quantum", "2026-07-01", 500, "publication");
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "from_publication_date:2026-07-01",
    );
  });
});

describe("queries the starting-graph modes depend on", () => {
  const page = (results: unknown[]) =>
    JSON.stringify({ results, meta: { next_cursor: null } });
  const record = (id: string) => ({
    id: `https://openalex.org/${id}`,
    title: id,
    type: "article",
    publication_date: "2026-01-01",
  });

  it("looks DOIs up in one batched request", async () => {
    const { client, transport } = clientWith([page([record("W1"), record("W2")])]);
    await client.worksByDois(["10.1234/one", "https://doi.org/10.1234/TWO"]);

    expect(transport.requested).toHaveLength(1);
    // Normalised on the way in, so the caller can paste URLs and mixed case.
    expect(queryOf(transport.requested[0] as string).filter).toBe(
      "doi:10.1234/one|10.1234/two",
    );
  });

  it("sorts citers by influence, not by date", async () => {
    // A snowball wants what built on your seeds and mattered, not merely the
    // most recent thing to reference one.
    const { client, transport } = clientWith([page([record("W9")])]);
    await client.worksCiting(["W1", "W2"], 5);

    const query = queryOf(transport.requested[0] as string);
    expect(query.filter).toContain("cites:W1|W2");
    expect(query.sort).toBe("cited_by_count:desc");
  });

  it("asks for nothing when there is nothing to cite", async () => {
    const { client, transport } = clientWith([]);
    expect(await client.worksCiting([], 5)).toEqual([]);
    expect(transport.requested).toHaveLength(0);
  });

  it("treats a bare author id as exact, not as a name search", async () => {
    const { client, transport } = clientWith([page([record("W1")])]);
    await client.worksByAuthor("A5023888391", 5);
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "authorships.author.id:A5023888391",
    );
  });

  it("recognises an ORCID", async () => {
    const { client, transport } = clientWith([page([record("W1")])]);
    await client.worksByAuthor("0000-0002-1825-0097", 5);
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "authorships.author.orcid:https://orcid.org/0000-0002-1825-0097",
    );
  });

  it("falls back to a name search", async () => {
    const { client, transport } = clientWith([page([record("W1")])]);
    await client.worksByAuthor("Ada Lovelace", 5);
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "raw_author_name.search:Ada Lovelace",
    );
  });
});

describe("junk filtering against real bad data", () => {
  it("drops entries with implausible future publication dates", async () => {
    // This fixture holds five REAL OpenAlex records dated 2027-2050, plus one
    // hand-added valid control entry. Only the control should survive.
    const { client } = clientWith([load("openalex_works_since.json")], new Date("2026-07-19"));
    const works = await client.worksSince("quantum", "2026-01-01");
    expect(works).toHaveLength(1);
    expect(works[0]?.title).toBe("A Perfectly Ordinary Control Paper");
  });

  it("rejects a record with no title at all", () => {
    expect(passesSanityFilters({ publication_date: "2020-01-01" })).toBe(false);
    expect(passesSanityFilters({ title: "Fine", publication_date: "2020-01-01" })).toBe(true);
  });

  it("allows near-future dates within the grace window", () => {
    const today = new Date("2026-07-19");
    expect(passesSanityFilters({ title: "Soon", publication_date: "2026-08-01" }, 60, today)).toBe(
      true,
    );
    expect(passesSanityFilters({ title: "Absurd", publication_date: "2050-01-01" }, 60, today)).toBe(
      false,
    );
  });

  it("rejects an unparseable date", () => {
    expect(passesSanityFilters({ title: "Bad", publication_date: "not-a-date" })).toBe(false);
  });
});

describe("worksByIds", () => {
  it("batches ids into one filter", async () => {
    const { client, transport } = clientWith([load("openalex_by_ids.json")]);
    const works = await client.worksByIds(["W2963403868", "W2194775991"]);
    const query = queryOf(transport.requested[0] as string);
    expect(query.filter).toBe("openalex_id:W2963403868|W2194775991");
    expect(works.length).toBeGreaterThan(0);
  });

  it("makes no request for an empty id list", async () => {
    const { client, transport } = clientWith([]);
    await expect(client.worksByIds([])).resolves.toEqual([]);
    expect(transport.requested).toHaveLength(0);
  });
});

describe("abstract reconstruction", () => {
  it("reassembles words from the inverted index in order", () => {
    expect(reconstructAbstract({ deep: [0], learning: [1], works: [2] })).toBe(
      "deep learning works",
    );
  });

  it("handles a word appearing at several positions", () => {
    expect(reconstructAbstract({ the: [0, 2], cat: [1], sat: [3] })).toBe("the cat the sat");
  });

  it("returns undefined for missing or empty input", () => {
    expect(reconstructAbstract(undefined)).toBeUndefined();
    expect(reconstructAbstract({})).toBeUndefined();
  });
});

describe("workFromOpenAlex id extraction", () => {
  it("captures an arxiv id from a landing page url", () => {
    const work = workFromOpenAlex({
      id: "https://openalex.org/W1",
      title: "Preprint",
      type: "preprint",
      primary_location: { landing_page_url: "https://arxiv.org/abs/1706.03762v2" },
    });
    expect(work.ids).toContainEqual({ namespace: "arxiv", value: "1706.03762" });
  });

  it("maps openalex types onto the shared item-type vocabulary", () => {
    const book = workFromOpenAlex({ id: "https://openalex.org/W2", title: "B", type: "book" });
    expect(book.itemType).toBe("book");
    const chapter = workFromOpenAlex({
      id: "https://openalex.org/W3", title: "C", type: "book-chapter",
    });
    expect(chapter.itemType).toBe("bookSection");
  });
});
