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
  OpenAlexKeyError,
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

/** A concept-search response: {@link OpenAlexClient} resolves free text to
 * this before a starting-graph search, so those tests need one queued first.
 * Only a hit whose name is the term itself is accepted. */
const conceptFound = (id: string, name: string) =>
  JSON.stringify({ results: [{ id: `https://openalex.org/${id}`, display_name: name }] });
const noConceptMatch = JSON.stringify({ results: [] });

describe("topWorks pagination", () => {
  it("resolves free text to a concept before searching, so results are field-scoped", async () => {
    // The bug this guards: `default.search` matches the words anywhere in
    // title/abstract/fulltext, so sorting those hits by citation count
    // surfaced the most-cited paper in the whole corpus that merely contained
    // the word "quantum" — a consciousness-studies paper, a phosphor paper —
    // regardless of field. concepts.id scopes to an actual field.
    const { client, transport } = clientWith([
      conceptFound("C41008148", "Machine learning"),
      load("openalex_top_works_page1.json"),
    ]);
    await client.topWorks("machine learning", 3);

    expect(queryOf(transport.requested[0] as string).search).toBe("machine learning");
    expect(queryOf(transport.requested[1] as string).filter).toContain("concepts.id:C41008148");
  });

  it("refuses a concept that is merely the search's top hit, not the term", async () => {
    // Verified live: "diffusion models" -> "Relativistic heat conduction",
    // "graph neural networks" -> "Recurrent neural network". Accepting the top
    // hit built a starting graph from the wrong discipline, with no warning.
    const { client, transport } = clientWith([
      conceptFound("C43818450", "Relativistic heat conduction"),
      load("openalex_top_works_page1.json"),
    ]);
    await client.topWorks("diffusion models", 3);

    const filter = queryOf(transport.requested[1] as string).filter;
    expect(filter).not.toContain("concepts.id");
    expect(filter).toContain('title_and_abstract.search:"diffusion models"');
    expect(await client.unresolvedTopics("diffusion models")).toEqual(["diffusion models"]);
  });

  it("takes the hit whose name matches even when it is not the first", async () => {
    const { client, transport } = clientWith([
      JSON.stringify({
        results: [
          { id: "https://openalex.org/C1", display_name: "Electrical grid" },
          { id: "https://openalex.org/C10558101", display_name: "Smart grid" },
        ],
      }),
      load("openalex_top_works_page1.json"),
    ]);
    await client.topWorks("smart grids", 3); // plural still names the field

    expect(queryOf(transport.requested[0] as string)["per-page"]).toBe("5");
    expect(queryOf(transport.requested[1] as string).filter).toContain("concepts.id:C10558101");
    expect(await client.topicMatches("smart grids")).toEqual([
      { term: "smart grids", concept: { id: "C10558101", name: "Smart grid" } },
    ]);
    expect(transport.requested).toHaveLength(2); // the match is memoized, not re-asked
  });

  it("falls back to a quoted title-and-abstract phrase when no concept matches", async () => {
    // Regression: unquoted default.search is an OR across every word, so
    // "trapped ion quantum simulation" pulled in ~82k works — anything
    // containing just "simulation" — sorted by raw citation count, surfacing
    // biomolecular simulation packages and DFT codes as the "top results."
    // Quoting it as a phrase narrowed that same live query to 347 results,
    // all genuinely on topic.
    const { client, transport } = clientWith([
      noConceptMatch,
      load("openalex_top_works_page1.json"),
    ]);
    await client.topWorks("machine learning", 3);

    // Not `default.search`, which also matches full text: there, "diffusion
    // models" ranked AlphaFold 3 and a radiocarbon calibration curve first --
    // highly cited papers that merely mention the phrase somewhere.
    expect(queryOf(transport.requested[1] as string).filter).toContain(
      'title_and_abstract.search:"machine learning"',
    );
  });

  it("follows the cursor across two real pages", async () => {
    const page1 = load("openalex_top_works_page1.json");
    const page2 = load("openalex_top_works_page2.json");
    const expectedCursor = JSON.parse(page1).meta.next_cursor as string;

    const { client, transport } = clientWith([noConceptMatch, page1, page2]);
    const works = await client.topWorks("machine learning", 6); // 3 per fixture page

    expect(transport.requested).toHaveLength(3);
    // Compare the decoded param, not a substring — the cursor is base64 and
    // gets percent-encoded in the URL.
    expect(queryOf(transport.requested[2] as string).cursor).toBe(expectedCursor);
    expect(works).toHaveLength(6);
  });

  it("stops at the requested limit", async () => {
    const { client } = clientWith([noConceptMatch, load("openalex_top_works_page1.json")]);
    const works = await client.topWorks("machine learning", 3);
    expect(works).toHaveLength(3);
  });

  it("filters to article-like types and sorts by citations", async () => {
    const { client, transport } = clientWith([
      noConceptMatch,
      load("openalex_top_works_page1.json"),
    ]);
    await client.topWorks("machine learning", 3);
    const query = queryOf(transport.requested[1] as string);
    expect(query.filter).toContain("type:");
    expect(query.sort).toBe("cited_by_count:desc");
  });

  it("treats a bare concept id as a concept filter, not free text, skipping resolution", async () => {
    const { client, transport } = clientWith([load("openalex_top_works_page1.json")]);
    await client.topWorks("C41008148", 3);
    expect(transport.requested).toHaveLength(1); // no concept-lookup request needed
    expect(queryOf(transport.requested[0] as string).filter).toContain("concepts.id:C41008148");
  });
});

describe("worksSince — what a topic source asks for", () => {
  const today = new Date("2026-07-19T12:00:00Z");

  it("filters on publication date, the only window the free tier allows", async () => {
    // `from_created_date` would be the better signal — OpenAlex indexes papers
    // weeks after publication — but it is a paid-plan filter that answers 429
    // "Plan upgrade required" for everyone else. Verified live, after it broke
    // every update for a free-tier user.
    const { client, transport } = clientWith([load("openalex_works_since.json")], today);
    await client.worksSince("quantum", "2026-07-01");
    const filter = queryOf(transport.requested[0] as string).filter ?? "";
    expect(filter).toContain("from_publication_date:2026-07-01");
    expect(filter).not.toContain("from_created_date");
  });

  it("matches every word in the title or abstract, ranked by relevance, not by date", async () => {
    // Measured live for "quantum error correction": newest-first over the
    // concept tag put future-dated records and crank repository uploads first
    // (2 genuine papers in the top 12); relevance over the title and abstract
    // gave 10 of 12. Every word rather than the exact phrase: over a month,
    // "trapped ion quantum computing" as a phrase matched 2 papers, as words
    // 30. And no concept lookup: that is a second search-priced request, spent
    // on a tag too liberal to rank by.
    const { client, transport } = clientWith([load("openalex_works_since.json")], today);
    await client.worksSince("quantum error correction", "2026-07-01");

    expect(transport.requested).toHaveLength(1);
    const query = queryOf(transport.requested[0] as string);
    expect(query.filter).toContain("title_and_abstract.search:quantum error correction,");
    expect(query.sort).toBe("relevance_score:desc");
  });

  it("keeps a term the user quoted as an exact phrase", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")], today);
    await client.worksSince('"surface code", decoder', "2026-07-01");
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      'title_and_abstract.search:"surface code",title_and_abstract.search:decoder,',
    );
  });

  it("never asks for papers dated after today", async () => {
    // In any recency query a future-dated record outranks everything real.
    const { client, transport } = clientWith([load("openalex_works_since.json")], today);
    await client.worksSince("quantum", "2026-07-01");
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "to_publication_date:2026-07-19",
    );
  });

  it("keeps newest-first for a bare concept id, which has nothing to rank by", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")], today);
    await client.worksSince("C41008148", "2026-07-01");
    const query = queryOf(transport.requested[0] as string);
    expect(query.filter).toContain("concepts.id:C41008148");
    expect(query.sort).toBe("publication_date:desc");
  });

  it("uses index date only when asked explicitly, for anyone with a plan", async () => {
    const { client, transport } = clientWith([load("openalex_works_since.json")], today);
    await client.worksSince("quantum", "2026-07-01", 500, "created");
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "from_created_date:2026-07-01",
    );
  });
});

describe("free text inside a filter", () => {
  const empty = JSON.stringify({ results: [], meta: { next_cursor: null } });

  it("keeps a title's commas from splitting the filter", async () => {
    // Verified live: `title.search:Attention, please` is a 400. Every feed
    // item whose title had a comma failed its lookup.
    const { client, transport } = clientWith([empty]);
    await client.workByTitle("Attention, please: a | survey");
    expect(queryOf(transport.requested[0] as string).filter).toBe(
      "title.search:Attention please: a survey",
    );
  });

  it("keeps a bibliography-style author name in one clause", async () => {
    const { client, transport } = clientWith([empty]);
    await client.worksByAuthor("Lovelace, Ada", 5);
    expect(queryOf(transport.requested[0] as string).filter).toContain(
      "raw_author_name.search:Lovelace Ada,type:",
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

  it("asks every batch even when the first fills the pool", async () => {
    // Stopping at the first full batch meant a library past 50 papers only
    // ever drew arrivals from whichever 50 its folder happened to list first.
    const anchors = Array.from({ length: 60 }, (_, i) => `W${i}`);
    const { client, transport } = clientWith([
      page([record("X1"), record("X2")]),
      page([record("X3")]),
    ]);

    const works = await client.worksCitingSince(anchors, "2026-07-01", 2);

    expect(transport.requested).toHaveLength(2);
    expect(queryOf(transport.requested[1] as string).filter).toContain("cites:W50|");
    expect(works.map((work) => work.key)).toEqual(["X1", "X2", "X3"]);
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
      noConceptMatch,
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
    const { client } = clientWith([noConceptMatch, { status: 500, text: "boom" }]);
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
      page([]), // the concept lookup succeeds on retry, finding no concept
      page([]), // the actual works fetch
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

describe("a 401 from OpenAlex", () => {
  // Bodies as OpenAlex sent them on 2026-10-21.
  const badKey = {
    status: 401,
    text: '{"error":"Invalid or missing API key","message":"API key not found. Get a free key at https://openalex.org/settings/api-key."}',
  };
  const pagingNeedsKey = {
    status: 401,
    text: '{"error":"API key required for cursor paging","message":"Paging past the first page with cursor= needs a free API key."}',
  };
  const page = (ids: string[], cursor: string | null) =>
    JSON.stringify({
      results: ids.map((id) => ({ id: `https://openalex.org/${id}`, title: id, type: "article" })),
      meta: { next_cursor: cursor },
    });

  it("says the key was rejected, and stops asking for the rest of the run", async () => {
    const { client, transport } = clientWith([badKey]);

    const first = await client.workByDoi("10.1/a").catch((error: unknown) => error);
    expect(first).toBeInstanceOf(OpenAlexKeyError);
    expect((first as OpenAlexKeyError).reason).toBe("invalid");

    // Every request would fail the same way: no second one is sent.
    await expect(client.workByDoi("10.1/b")).rejects.toBeInstanceOf(OpenAlexKeyError);
    expect(transport.requested).toHaveLength(1);
  });

  it("keeps the first page when paging past it needs a key", async () => {
    const partials: unknown[] = [];
    const transport = new SequenceTransport([page(["W1", "W2"], "next"), pagingNeedsKey]);
    const client = new OpenAlexClient(transport, {
      sleep: noSleep,
      onPartialFetch: (error) => partials.push(error),
    });

    const works = await client.worksByAuthor("A5023888391", 300);

    expect(works.map((work) => work.key)).toEqual(["W1", "W2"]);
    expect(partials).toHaveLength(1);
    expect((partials[0] as OpenAlexKeyError).reason).toBe("required");
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
