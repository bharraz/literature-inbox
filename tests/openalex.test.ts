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

type CannedResponse = string | { status: number; text: string; retryAfter?: string };

class SequenceTransport implements Transport {
  readonly requested: string[] = [];
  constructor(private readonly bodies: CannedResponse[]) {}

  async get(url: string): Promise<TransportResponse> {
    this.requested.push(url);
    const next = this.bodies.shift();
    if (next === undefined) throw new Error("SequenceTransport ran out of responses");
    return typeof next === "string" ? { status: 200, text: next } : next;
  }
}

const noSleep = async () => {};
const clientWith = (bodies: CannedResponse[], today?: Date) => {
  const transport = new SequenceTransport(bodies);
  const client = new OpenAlexClient(transport, {
    apiKey: "test-key",
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

  it("sends the API key when one is configured", async () => {
    const { client, transport } = clientWith([load("openalex_by_doi.json")]);
    await client.workByDoi("10.1109/cvpr.2016.90");
    expect(queryOf(transport.requested[0] as string).api_key).toBe("test-key");
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
  it("filters on publication date, the only window the free tier allows", async () => {
    // `from_created_date` would be the better signal — OpenAlex indexes papers
    // weeks after publication — but it is a paid-plan filter that answers 429
    // "Plan upgrade required" for everyone else. Verified live, after it broke
    // every update for a free-tier user.
    const { client, transport } = clientWith([load("openalex_works_since.json")]);
    await client.worksSince("quantum", "2026-07-01");
    const filter = queryOf(transport.requested[0] as string).filter ?? "";
    expect(filter).toContain("from_publication_date:2026-07-01");
    expect(filter).not.toContain("from_created_date");
  });

  it("still sorts newest-published first, so a capped run gets recent papers", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")]);
    await client.worksSince("quantum", "2026-07-01");
    expect(queryOf(transport.requested[0] as string).sort).toBe("publication_date:desc");
  });

  it("uses index date only when asked explicitly, for anyone with a plan", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")]);
    await client.worksSince("quantum", "2026-07-01", 500, "created");
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "from_created_date:2026-07-01",
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

describe("adjacency selection", () => {
  const page = (results: unknown[]) => JSON.stringify({ results, meta: { next_cursor: null } });
  const record = (id: string) => ({
    id: `https://openalex.org/${id}`,
    title: id,
    type: "article",
    publication_date: "2026-01-01",
  });

  it("asks for recent citers, newest first", async () => {
    // The opposite question from worksCiting: what has cited my library
    // lately, not what cited it most influentially.
    const { client, transport } = clientWith([page([record("W9")])]);
    await client.worksCitingSince(["W1", "W2"], "2026-07-01", 25);

    const query = queryOf(transport.requested[0] as string);
    expect(query.filter).toContain("cites:W1|W2");
    expect(query.filter).toContain("from_publication_date:2026-07-01");
    expect(query.sort).toBe("publication_date:desc");
  });

  it("makes no request without anchors, so an empty library is silent not noisy", async () => {
    const { client, transport } = clientWith([]);
    expect(await client.worksCitingSince([], "2026-07-01", 25)).toEqual([]);
    expect(transport.requested).toHaveLength(0);
  });

  it("batches anchors and de-duplicates papers citing more than one", async () => {
    const anchors = Array.from({ length: 60 }, (_, i) => `W${i}`);
    const { client, transport } = clientWith([page([record("X1")]), page([record("X1")])]);

    const works = await client.worksCitingSince(anchors, "2026-07-01", 25);

    expect(transport.requested).toHaveLength(2); // 50 anchors per batch
    expect(works).toHaveLength(1);
  });
});

describe("partial fetches", () => {
  const page = (results: unknown[], cursor: string | null = null) =>
    JSON.stringify({ results, meta: { next_cursor: cursor } });
  const record = (id: string) => ({
    id: `https://openalex.org/${id}`,
    title: id,
    type: "article",
    publication_date: "2026-01-01",
  });

  it("keeps what it gathered when a later page fails", async () => {
    // A 400-paper kernel build that dies on page three is otherwise a total
    // loss, and 380 papers is a perfectly good starting graph.
    const partials: { fetched: number }[] = [];
    const transport = new SequenceTransport([
      page([record("W1"), record("W2")], "next"),
      { status: 500, text: "upstream is having a day" },
    ]);
    const client = new OpenAlexClient(transport, {
      sleep: noSleep,
      maxRetries: 0,
      onPartialFetch: (_error, fetched) => partials.push({ fetched }),
    });

    const works = await client.topWorks("anything", 100);

    expect(works).toHaveLength(2);
    expect(partials).toEqual([{ fetched: 2 }]);
  });

  it("still throws when no partial handler is configured", async () => {
    const { client } = clientWith([{ status: 500, text: "boom" }]);
    await expect(client.topWorks("anything", 10)).rejects.toThrow();
  });

  it("keeps earlier batches when a later batch fails", async () => {
    const partials: number[] = [];
    const transport = new SequenceTransport([
      page([record("W1")]),
      { status: 500, text: "boom" },
    ]);
    const client = new OpenAlexClient(transport, {
      sleep: noSleep,
      maxRetries: 0,
      onPartialFetch: (_error, fetched) => partials.push(fetched),
    });

    const ids = Array.from({ length: 60 }, (_, i) => `W${i}`); // two chunks of 50
    const works = await client.worksByIds(ids);

    expect(works).toHaveLength(1);
    expect(partials).toEqual([1]);
  });
});

describe("being rate limited", () => {
  const page = (results: unknown[]) => JSON.stringify({ results, meta: { next_cursor: null } });
  const tooMany = { status: 429, text: "slow down" };

  it("stops asking after a 429 instead of working through every batch", async () => {
    // The bug this guards: an outer loop over anchor batches caught each
    // failure, continued to the next batch, and ran a fresh retry ladder
    // against a service that had just asked us to back off — reporting the
    // same failure once per batch.
    const partials: number[] = [];
    const transport = new SequenceTransport([tooMany, page([]), page([]), page([])]);
    const client = new OpenAlexClient(transport, {
      sleep: noSleep,
      maxRetries: 0,
      onPartialFetch: (_error, fetched) => partials.push(fetched),
    });

    const anchors = Array.from({ length: 200 }, (_, i) => `W${i}`); // four batches
    await client.worksCitingSince(anchors, "2026-07-01", 25);

    expect(transport.requested).toHaveLength(1);
    expect(partials).toHaveLength(1);
    expect(client.wasRateLimited()).toBe(true);
  });

  it("stays stopped for every later call on the same client", async () => {
    // One client per run means one latch per run: once OpenAlex has said no,
    // the topic query should not go and ask again either.
    const transport = new SequenceTransport([tooMany]);
    const client = new OpenAlexClient(transport, {
      sleep: noSleep,
      maxRetries: 0,
      onPartialFetch: () => undefined,
    });

    await client.worksSince("quantum", "2026-07-01", 25);
    await client.topWorks("quantum", 25);

    expect(transport.requested).toHaveLength(1);
  });

  it("waits as long as the server asked", async () => {
    const slept: number[] = [];
    const transport = new SequenceTransport([
      { status: 429, text: "slow down", retryAfter: "7" },
      page([]),
    ]);
    const client = new OpenAlexClient(transport, {
      sleep: async (ms) => {
        slept.push(ms);
      },
      maxRetries: 1,
    });

    await client.topWorks("quantum", 5);

    expect(slept).toContain(7000);
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
