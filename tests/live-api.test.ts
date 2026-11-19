/**
 * Live checks against the real OpenAlex and arXiv APIs.
 *
 * **Skipped by default** — the rest of the suite is hermetic and must stay
 * that way. Run with `LIVE_API=1 npm test` (or `npm run test:live`).
 *
 * Recorded fixtures prove the parsing is right for the traffic as captured;
 * they fundamentally cannot notice that the API has *changed since*. That's
 * the failure this catches: a renamed field or a dropped endpoint would sail
 * past every other test and only surface as an empty inbox for a real user.
 *
 * Assertions are deliberately structural (this field exists and has this
 * shape), never about specific papers or counts, so a green run means "the
 * contract still holds" rather than "the world hasn't moved".
 */

import { describe, expect, it } from "vitest";
import { ArxivClient } from "../src/core/arxiv";
import { OpenAlexClient, OpenAlexKeyError } from "../src/core/openalex";
import { CrossrefClient } from "../src/core/crossref";
import type { Transport, TransportResponse } from "../src/core/http";

const LIVE = process.env.LIVE_API === "1";
const suite = LIVE ? describe : describe.skip;

/** A real network transport, standing in for Obsidian's requestUrl. */
class NodeTransport implements Transport {
  async get(url: string): Promise<TransportResponse> {
    const response = await fetch(url, {
      headers: { "User-Agent": "literature-inbox-tests/0.1 (contact via GitHub)" },
    });
    return { status: response.status, text: await response.text() };
  }
}

const transport = new NodeTransport();
const TIMEOUT = 45_000;

/** Optional: a real OpenAlex key, for the checks that need one — the same
 * variable the vault and simulation harnesses read. Never committed; set it
 * in the environment for a run. */
const API_KEY = process.env.LIVE_OPENALEX_KEY || undefined;

suite("OpenAlex, live", () => {
  const client = () => new OpenAlexClient(transport, { minIntervalMs: 250, apiKey: API_KEY });

  it(
    "still returns works for a topic search",
    async () => {
      const works = await client().topWorks("machine learning", 5);
      expect(works.length).toBeGreaterThan(0);
      for (const work of works) {
        expect(work.title).toBeTruthy();
        expect(work.ids.some((id) => id.namespace === "openalex")).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "keeps a topic source's arrivals on topic and dated no later than today",
    async () => {
      // The update path: every word in the title or abstract, ranked by
      // relevance. Newest-first over a concept tag led with crank uploads and
      // future-dated records when this was last measured.
      const today = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const works = await client().worksSince("quantum error correction", since, 10);
      expect(works.length).toBeGreaterThan(0);
      const onTopic = works.filter((work) => {
        const text = `${work.title} ${work.abstract ?? ""}`;
        return /error/i.test(text) && /correct/i.test(text) && /quantum/i.test(text);
      });
      expect(onTopic.length / works.length).toBeGreaterThanOrEqual(0.8);
      for (const work of works) expect((work.date ?? "") <= today).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "refuses a concept whose name is not the topic, and accepts one that is",
    async () => {
      // "diffusion models" once resolved, silently, to "Relativistic heat
      // conduction" — the concept search's top hit.
      const live = client();
      expect(await live.topicMatches("diffusion models")).toEqual([{ term: "diffusion models" }]);
      const [smartGrid] = await live.topicMatches("smart grid");
      expect(smartGrid?.concept?.name.toLowerCase()).toBe("smart grid");
    },
    TIMEOUT,
  );

  it(
    "still resolves a known DOI, with the fields we depend on",
    async () => {
      const work = await client().workByDoi("10.1109/cvpr.2016.90");
      expect(work).toBeDefined();
      expect(work?.title).toContain("Deep Residual Learning");
      expect(work?.doi).toBe("10.1109/cvpr.2016.90");
      // The whole citation feature rests on this field still existing.
      expect(work?.references.length).toBeGreaterThan(0);
      expect(work?.authors.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "still serves abstracts as an inverted index",
    async () => {
      const work = await client().workByDoi("10.1109/cvpr.2016.90");
      // If OpenAlex ever ships plain abstracts instead, reconstruction would
      // silently yield nothing — so assert we got prose out the far end.
      expect(work?.abstract && work.abstract.length > 50).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "still returns undefined (not an error) for a DOI it doesn't have",
    async () => {
      await expect(
        client().workByDoi("10.9999/definitely-not-a-real-doi-xyz"),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "still supports batched id lookup",
    async () => {
      // Ids are discovered from a live search rather than hardcoded: OpenAlex
      // merges and withdraws records, so a literal id rots. (This test
      // originally pinned W2963403868, which now 404s — the client was fine,
      // the test was wrong. `worksByIds` is documented as best-effort for
      // exactly this reason.)
      const seed = await client().topWorks("machine learning", 2);
      const ids = seed
        .map((work) => work.ids.find((id) => id.namespace === "openalex")?.value)
        .filter((id): id is string => Boolean(id));
      expect(ids.length).toBeGreaterThan(0);

      const works = await client().worksByIds(ids);
      expect(works.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "returns a best-effort subset rather than failing on a withdrawn id",
    async () => {
      // A merged/withdrawn id must simply not come back — never throw, and
      // never be mistaken for a positional match to the input.
      const works = await client().worksByIds(["W2963403868"]);
      expect(Array.isArray(works)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "still paginates by cursor",
    async () => {
      // More than one page's worth — a page holds at most 200 — so a second
      // request really happens. (This asked for 120 once pages grew to 200,
      // and quietly stopped testing anything.) Since October 2026 OpenAlex
      // refuses a keyless second page, so without LIVE_OPENALEX_KEY set this
      // fails — with the plugin's own wording — and that failure is the
      // finding.
      const works = await client().topWorks("quantum computing", 250);
      expect(works.length).toBeGreaterThan(200);
    },
    TIMEOUT,
  );

  it(
    "recognises a rejected key for what it is",
    async () => {
      const keyed = new OpenAlexClient(transport, { minIntervalMs: 250, apiKey: "not-a-real-key" });
      const error = await keyed.workByDoi("10.1109/cvpr.2016.90").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenAlexKeyError);
      expect((error as OpenAlexKeyError).reason).toBe("invalid");
    },
    TIMEOUT,
  );
});

suite("the starting graph, live", () => {
  it(
    "a real top-cited fetch produces a densely connected core",
    async () => {
      // The kernel's whole premise is that top-cited papers cite *each other*,
      // so seeding them yields a graph rather than a list. If that stopped
      // being true the feature would technically work and be useless, which
      // no fixture-based test would notice.
      const client = new OpenAlexClient(transport, { minIntervalMs: 250 });
      const works = await client.topWorks("machine learning", 100);
      expect(works.length).toBeGreaterThan(50);

      const idsPresent = new Set<string>();
      for (const work of works) {
        for (const id of work.ids) {
          if (id.namespace === "openalex") idsPresent.add(id.value);
        }
      }
      const internalEdges = works.reduce(
        (total, work) =>
          total + work.references.filter((ref) => idsPresent.has(ref.value)).length,
        0,
      );

      // Not a precise threshold — just proof the set is interconnected at all.
      expect(internalEdges).toBeGreaterThan(10);
    },
    120_000,
  );
});

suite("arXiv, live", () => {
  const client = () => new ArxivClient(transport, { minIntervalMs: 3000 });

  it(
    "still returns a category feed we can parse",
    async () => {
      const works = await client().categoryFeed("cs.CL", 5);
      expect(works.length).toBeGreaterThan(0);
      for (const work of works) {
        expect(work.title).toBeTruthy();
        expect(work.title).not.toMatch(/\s{2,}/); // whitespace collapsed
        const arxivId = work.ids.find((id) => id.namespace === "arxiv");
        expect(arxivId?.value).not.toMatch(/v\d+$/); // version stripped
      }
    },
    TIMEOUT,
  );

  it(
    "still resolves a single paper by id",
    async () => {
      const work = await client().workById("1706.03762");
      expect(work?.title).toContain("Attention Is All You Need");
      expect(work?.abstract).toBeTruthy();
      expect(work?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
    TIMEOUT,
  );

  it(
    "keeps the archive of a pre-2007 id",
    async () => {
      const work = await client().workById("hep-th/9711200");
      expect(work?.title).toMatch(/large N limit/i);
      expect(work?.ids).toContainEqual({ namespace: "arxiv", value: "hep-th/9711200" });
    },
    TIMEOUT,
  );
});

suite("Crossref, live", () => {
  const client = () => new CrossrefClient(transport, { minIntervalMs: 1200 });

  it(
    "still returns deposited references for a known DOI",
    async () => {
      // The fallback edge source. If this stops carrying DOIs, the fallback
      // silently becomes useless while every hermetic test stays green.
      const work = await client().workByDoi("10.1109/cvpr.2016.90");
      expect(work?.title).toBeTruthy();
      expect(work?.doi).toBe("10.1109/cvpr.2016.90");
      expect(work?.references.length).toBeGreaterThan(0);
      expect(work?.references.every((ref) => ref.namespace === "doi")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "still matches a title to a DOI",
    async () => {
      const work = await client().workByTitle(
        "Deep Residual Learning for Image Recognition",
      );
      expect(work?.doi).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    "still needs no key",
    async () => {
      // Documented as free and keyless; if that changed it would rewrite the
      // plugin's whole cost model. Goes through the client so its rate
      // limiter applies — Crossref allows 1 req/s anonymously, and a raw
      // request here would just measure our own impatience.
      await expect(client().workByDoi("10.1109/cvpr.2016.90")).resolves.toBeDefined();
    },
    TIMEOUT,
  );
});
