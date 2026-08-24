/**
 * Crossref client, against a real recorded response.
 *
 * The fixtures are genuine captured traffic for `10.1109/cvpr.2016.90` and a
 * real `query.bibliographic` search — including the thing that makes title
 * lookups dangerous: the top hit is often the wrong paper.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CrossrefClient,
  referencesFrom,
  workFromCrossref,
} from "../src/core/crossref";
import { titlesMatch } from "../src/core/ids";
import type { Transport, TransportResponse } from "../src/core/http";

const FIXTURES = join(__dirname, "fixtures");
const load = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

class SequenceTransport implements Transport {
  readonly requested: string[] = [];
  constructor(private readonly bodies: (string | { status: number; text: string })[]) {}
  async get(url: string): Promise<TransportResponse> {
    this.requested.push(url);
    const next = this.bodies.shift();
    if (next === undefined) throw new Error("ran out of responses");
    return typeof next === "string" ? { status: 200, text: next } : next;
  }
}

const noSleep = async () => {};
const clientWith = (bodies: (string | { status: number; text: string })[], mailto?: string) => {
  const transport = new SequenceTransport(bodies);
  return { client: new CrossrefClient(transport, { sleep: noSleep, mailto }), transport };
};

const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams.entries());

describe("parsing a real Crossref record", () => {
  const record = JSON.parse(load("crossref_by_doi.json")).message;

  it("reads the fields a note needs", () => {
    const work = workFromCrossref(record);
    expect(work?.title).toBe("Deep Residual Learning for Image Recognition");
    expect(work?.doi).toBe("10.1109/cvpr.2016.90");
    expect(work?.authors.length).toBeGreaterThan(0);
    expect(work?.source).toBe("crossref");
  });

  it("keeps only references that carry a DOI", () => {
    // An id-less reference cannot be matched to anything in the vault — this
    // plugin draws edges by id, never by fuzzy string matching. Measured at
    // roughly half of a real reference list.
    const work = workFromCrossref(record);
    expect(work?.references.length).toBeGreaterThan(0);
    expect(work?.references.every((ref) => ref.namespace === "doi")).toBe(true);
    expect(work!.references.length).toBeLessThan(record.reference.length + 1);
  });

  it("normalises reference DOIs so they match our origin ids", () => {
    const refs = referencesFrom([{ DOI: "10.1234/ABC" }, { DOI: "10.1234/abc" }, { key: "no-doi" }]);
    expect(refs).toEqual([{ namespace: "doi", value: "10.1234/abc" }]);
  });

  it("returns nothing for a record with no DOI, rather than a keyless work", () => {
    expect(workFromCrossref({ title: ["Untitled"] })).toBeUndefined();
  });
});

describe("Crossref's date and abstract shapes", () => {
  it("handles a year-only date without inventing an invalid one", () => {
    const work = workFromCrossref({ DOI: "10.1/x", issued: { "date-parts": [[2017]] } });
    expect(work?.date).toBe("2017-01-01");
  });

  it("handles a full date", () => {
    const work = workFromCrossref({ DOI: "10.1/x", issued: { "date-parts": [[2016, 6, 27]] } });
    expect(work?.date).toBe("2016-06-27");
  });

  it("survives a missing or malformed date", () => {
    expect(workFromCrossref({ DOI: "10.1/x" })?.date).toBeUndefined();
    expect(workFromCrossref({ DOI: "10.1/x", issued: { "date-parts": [[]] } })?.date).toBeUndefined();
  });

  it("strips the JATS markup Crossref wraps abstracts in", () => {
    const work = workFromCrossref({
      DOI: "10.1/x",
      abstract: "<jats:p>We present a <jats:italic>deep</jats:italic> framework.</jats:p>",
    });
    expect(work?.abstract).toBe("We present a deep framework.");
  });

  it("drops the redundant 'Abstract' title JATS opens with", () => {
    // 15 of 100 sampled live records open this way. Left in, every one of
    // them renders as "Abstract" directly under this plugin's own heading
    // of the same name.
    const work = workFromCrossref({
      DOI: "10.1/x",
      abstract:
        "<jats:title>Abstract</jats:title>\n  <jats:sec>" +
        "<jats:title>Background</jats:title><jats:p>Plate readers measure growth.</jats:p>" +
        "</jats:sec>",
    });
    expect(work?.abstract).toBe("Background Plate readers measure growth.");
  });

  it("keeps an inner section title that isn't the leading 'Abstract'", () => {
    const work = workFromCrossref({
      DOI: "10.1/x",
      abstract: "<jats:p>Text about the abstract nature of it.</jats:p>",
    });
    expect(work?.abstract).toBe("Text about the abstract nature of it.");
  });

  it("decodes the entities that survive a tag strip", () => {
    const work = workFromCrossref({
      DOI: "10.1/x",
      abstract: "<jats:p>Cost &lt; 5% &amp; rising&#x2014;see &#8220;note&#8221;.</jats:p>",
    });
    expect(work?.abstract).toBe("Cost < 5% & rising—see “note”.");
  });

  it("closes up inline tags instead of turning them into spaces", () => {
    // "H<sub>2</sub>O" became "H 2 O" when every tag was replaced by a space.
    const work = workFromCrossref({
      DOI: "10.1/x",
      abstract: "<jats:p>H<sub>2</sub>O and Fe(<sc>iv</sc>)-oxo.</jats:p>",
    });
    expect(work?.abstract).toBe("H2O and Fe(iv)-oxo.");
  });

  it("collapses the newlines publishers deposit inside titles", () => {
    // Roughly 1 in 200 live records. A newline reaching the note breaks its
    // YAML frontmatter outright.
    const work = workFromCrossref({
      DOI: "10.1/x",
      title: ["A Study on Safety\n            Management"],
    });
    expect(work?.title).toBe("A Study on Safety Management");
  });

  it("takes a corporate author that has no family name", () => {
    const work = workFromCrossref({ DOI: "10.1/x", author: [{ name: "The Consortium" }] });
    expect(work?.authors).toEqual([{ lastName: "The Consortium" }]);
  });
});

describe("requests", () => {
  it("looks a DOI up on the single-record endpoint", async () => {
    const { client, transport } = clientWith([load("crossref_by_doi.json")]);
    await client.workByDoi("https://doi.org/10.1109/CVPR.2016.90");
    expect(transport.requested[0]).toContain("/works/10.1109/cvpr.2016.90");
  });

  it("returns undefined on 404 rather than throwing", async () => {
    const { client } = clientWith([{ status: 404, text: "" }]);
    await expect(client.workByDoi("10.1/nope")).resolves.toBeUndefined();
  });

  it("uses the bibliographic matcher for titles", async () => {
    const { client, transport } = clientWith([load("crossref_title_search.json")]);
    await client.workByTitle("Deep residual learning for image recognition");
    const query = queryOf(transport.requested[0] as string);
    expect(query["query.bibliographic"]).toBe("Deep residual learning for image recognition");
    expect(query.rows).toBe("1");
  });

  it("sends the polite-pool address only when configured", async () => {
    const polite = clientWith([load("crossref_title_search.json")], "me@example.com");
    await polite.client.workByTitle("anything");
    expect(queryOf(polite.transport.requested[0] as string).mailto).toBe("me@example.com");

    const anon = clientWith([load("crossref_title_search.json")]);
    await anon.client.workByTitle("anything");
    expect(queryOf(anon.transport.requested[0] as string).mailto).toBeUndefined();
  });

  it("makes no request for an empty title", async () => {
    const { client, transport } = clientWith([]);
    await expect(client.workByTitle("   ")).resolves.toBeUndefined();
    expect(transport.requested).toHaveLength(0);
  });
});

describe("the title-match guard, on real search results", () => {
  it("returns a candidate that must still be corroborated", async () => {
    // The recorded search for "Deep residual learning for image recognition"
    // returns a *different* paper as its top hit. Crossref's matcher is fuzzy
    // by design, so believing it uncorroborated would attach the wrong
    // identity — and with it, the wrong reference list — to a note.
    const { client } = clientWith([load("crossref_title_search.json")]);
    const hit = await client.workByTitle("Deep residual learning for image recognition");

    expect(hit).toBeDefined();
    expect(titlesMatch(hit?.title, "Deep residual learning for image recognition")).toBe(false);
  });
});
