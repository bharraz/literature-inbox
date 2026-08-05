import { describe, expect, it } from "vitest";
import {
  backfillDois,
  extractArxivIdFromText,
  extractDoiFromText,
  newestItem,
  parseFeed,
} from "../src/core/rss";
import { titlesMatch } from "../src/core/ids";
import { emptyWork, type Work } from "../src/core/types";

const rssFeed = (items: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
  <channel><title>A Journal</title>${items}</channel>
</rss>`;

describe("DOI extraction from free text", () => {
  it("finds a DOI anywhere in the text", () => {
    expect(extractDoiFromText("See https://doi.org/10.1234/abc.def for details")).toBe(
      "10.1234/abc.def",
    );
    expect(extractDoiFromText("doi:10.1038/nature12373")).toBe("10.1038/nature12373");
  });

  it("trims trailing sentence punctuation", () => {
    // "10.1234/foo." is a different identifier from "10.1234/foo".
    expect(extractDoiFromText("Published as 10.1234/foo.")).toBe("10.1234/foo");
    expect(extractDoiFromText("(10.1234/bar)")).toBe("10.1234/bar");
  });

  it("lowercases, matching the origin-id rule", () => {
    expect(extractDoiFromText("10.1234/ABC")).toBe("10.1234/abc");
  });

  it("returns undefined when there is no DOI", () => {
    expect(extractDoiFromText("no identifier here")).toBeUndefined();
    expect(extractDoiFromText(undefined)).toBeUndefined();
  });
});

describe("newestItem", () => {
  const dated = (key: string, date?: string): Work => {
    const work = emptyWork(key);
    work.title = key;
    work.date = date;
    return work;
  };

  it("returns nothing for an empty feed", () => {
    expect(newestItem([])).toBeUndefined();
  });

  it("picks the latest date, not the first item", () => {
    // Newest-first is a convention, not a rule — a feed listing oldest first
    // would otherwise report a title from years ago as its most recent.
    const works = [dated("old", "2020-01-01"), dated("new", "2026-08-01")];
    expect(newestItem(works)?.title).toBe("new");
  });

  it("falls back to document order when nothing is dated", () => {
    expect(newestItem([dated("first"), dated("second")])?.title).toBe("first");
  });

  it("prefers a dated item over an undated one", () => {
    expect(newestItem([dated("undated"), dated("dated", "2026-08-01")])?.title).toBe("dated");
  });
});

describe("arXiv id extraction", () => {
  it("pulls a bare id out of a link", () => {
    expect(extractArxivIdFromText("https://arxiv.org/abs/2401.12345v2")).toBe("2401.12345");
    expect(extractArxivIdFromText("https://arxiv.org/pdf/2401.12345.pdf")).toBe("2401.12345");
  });

  it("returns undefined for unrelated text", () => {
    expect(extractArxivIdFromText("https://example.com/paper")).toBeUndefined();
  });
});

describe("parseFeed on RSS 2.0", () => {
  it("uses the guid as identity when no DOI is present", () => {
    const works = parseFeed(
      rssFeed(`<item>
        <title>A Paper About Things</title>
        <link>https://journal.test/p/1</link>
        <guid>urn:journal:1</guid>
        <pubDate>Tue, 15 Jul 2025 09:00:00 GMT</pubDate>
      </item>`),
    );
    expect(works).toHaveLength(1);
    expect(works[0]?.ids).toContainEqual({ namespace: "rss", value: "urn:journal:1" });
    expect(works[0]?.date).toBe("2025-07-15");
    expect(works[0]?.source).toBe("rss");
  });

  it("prefers a DOI found in the description", () => {
    const works = parseFeed(
      rssFeed(`<item>
        <title>A Paper With A DOI</title>
        <guid>urn:journal:2</guid>
        <description>Abstract text. doi:10.1234/xyz</description>
      </item>`),
    );
    expect(works[0]?.doi).toBe("10.1234/xyz");
    expect(works[0]?.ids[0]).toEqual({ namespace: "doi", value: "10.1234/xyz" });
    // The guid is still recorded, so the item dedups across runs either way.
    expect(works[0]?.ids).toContainEqual({ namespace: "rss", value: "urn:journal:2" });
  });

  it("reads a prism:doi element when the feed publishes one", () => {
    const works = parseFeed(
      rssFeed(`<item>
        <title>Prism Tagged Paper</title>
        <guid>urn:journal:3</guid>
        <prism:doi>10.9999/prism.1</prism:doi>
      </item>`),
    );
    expect(works[0]?.doi).toBe("10.9999/prism.1");
  });

  it("falls back to the link when a feed publishes no guid", () => {
    const works = parseFeed(
      rssFeed(`<item>
        <title>No Guid Here</title>
        <link>https://journal.test/p/9</link>
      </item>`),
    );
    expect(works[0]?.ids).toContainEqual({
      namespace: "url", value: "https://journal.test/p/9",
    });
  });

  it("strips HTML out of descriptions", () => {
    const works = parseFeed(
      rssFeed(`<item>
        <title>HTML Description</title>
        <guid>urn:journal:4</guid>
        <description>&lt;p&gt;Some &lt;b&gt;bold&lt;/b&gt; abstract.&lt;/p&gt;</description>
      </item>`),
    );
    expect(works[0]?.abstract).toBe("Some bold abstract.");
  });

  it("keeps an item that resolves to nothing but a title", () => {
    // Shallow arrivals are still arrivals; dropping them loses papers.
    const works = parseFeed(rssFeed("<item><title>Bare Title Only</title></item>"));
    expect(works).toHaveLength(1);
    expect(works[0]?.title).toBe("Bare Title Only");
  });

  it("skips an item with no title at all", () => {
    expect(parseFeed(rssFeed("<item><guid>urn:x</guid></item>"))).toEqual([]);
  });
});

describe("parseFeed on Atom", () => {
  it("reads entries and the href-attribute link", () => {
    const works = parseFeed(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>An Atom Paper</title>
          <id>urn:atom:1</id>
          <link href="https://journal.test/atom/1"/>
          <published>2025-03-04T00:00:00Z</published>
        </entry>
      </feed>`);
    expect(works).toHaveLength(1);
    expect(works[0]?.url).toBe("https://journal.test/atom/1");
    expect(works[0]?.date).toBe("2025-03-04");
  });
});

describe("malformed input", () => {
  it("throws rather than quietly reporting an empty feed", () => {
    expect(() => parseFeed("<rss><channel><item></channel></rss>")).toThrow();
  });
});

describe("backfillDois", () => {
  const resolverReturning = (work: Work | undefined) => ({
    workByTitle: async () => work,
  });

  it("attaches a DOI and reference list when the title matches", async () => {
    const item = emptyWork("urn:1");
    item.title = "Attention Is All You Need";

    const candidate = emptyWork("W1");
    candidate.title = "attention is all you need"; // different casing
    candidate.doi = "10.5555/attention";
    candidate.references = [{ namespace: "openalex", value: "W99" }];
    candidate.ids = [{ namespace: "openalex", value: "W1" }];

    const resolved = await backfillDois([item], resolverReturning(candidate), titlesMatch);

    expect(resolved).toBe(1);
    expect(item.doi).toBe("10.5555/attention");
    expect(item.ids[0]).toEqual({ namespace: "doi", value: "10.5555/attention" });
    expect(item.ids).toContainEqual({ namespace: "openalex", value: "W1" });
    // The whole point: a shallow node becomes graph-connected.
    expect(item.references).toHaveLength(1);
  });

  it("refuses a near-miss title rather than attaching a wrong identity", async () => {
    const item = emptyWork("urn:1");
    item.title = "Attention Is All You Need";

    const wrong = emptyWork("W2");
    wrong.title = "Attention Is Not All You Need";
    wrong.doi = "10.5555/different";

    const resolved = await backfillDois([item], resolverReturning(wrong), titlesMatch);

    expect(resolved).toBe(0);
    expect(item.doi).toBeUndefined();
  });

  it("leaves items that already have a DOI alone", async () => {
    const item = emptyWork("urn:1");
    item.title = "Already Known";
    item.doi = "10.1/known";
    let called = false;
    await backfillDois([item], { workByTitle: async () => { called = true; return undefined; } }, titlesMatch);
    expect(called).toBe(false);
  });

  it("survives a lookup failure without throwing", async () => {
    const item = emptyWork("urn:1");
    item.title = "Some Paper Title";
    const failing = { workByTitle: async () => { throw new Error("offline"); } };
    await expect(backfillDois([item], failing, titlesMatch)).resolves.toBe(0);
    expect(item.doi).toBeUndefined();
  });
});
