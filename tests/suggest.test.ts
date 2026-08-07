import { describe, expect, it } from "vitest";
import {
  explain,
  isEligible,
  readStatusOf,
  suggest,
  weigh,
  withReadStatus,
  parseReadStatus,
  type Candidate,
} from "../src/core/suggest";

const paper = (over: Partial<Candidate> = {}): Candidate => ({
  notePath: "Inbox/A Paper.md",
  title: "A Paper",
  edgeCount: 0,
  status: "unread",
  inInbox: true,
  ...over,
});

describe("who is eligible", () => {
  it("skips papers you finished or keep only for reference", () => {
    // "reference" is the one that earns its keep: a methods paper you look
    // things up in would otherwise be suggested forever.
    expect(isEligible(paper({ status: "read" }))).toBe(false);
    expect(isEligible(paper({ status: "reference" }))).toBe(false);
    expect(isEligible(paper({ status: "to-read" }))).toBe(true);
    expect(isEligible(paper({ status: "unread" }))).toBe(true);
  });
});

describe("weighting", () => {
  it("favours a well-connected paper over an isolated one", () => {
    expect(weigh(paper({ edgeCount: 8 }))).toBeGreaterThan(weigh(paper({ edgeCount: 0 })));
  });

  it("still gives an unconnected paper a chance", () => {
    // A fresh preprint OpenAlex has not indexed is not a bad paper; it is a
    // paper we know nothing about.
    expect(weigh(paper({ edgeCount: 0 }))).toBeGreaterThan(0);
  });

  it("stops rewarding connectivity past a point", () => {
    expect(weigh(paper({ edgeCount: 200 }))).toBe(weigh(paper({ edgeCount: 10 })));
  });

  it("prefers what you said you meant to read", () => {
    expect(weigh(paper({ status: "to-read" }))).toBeGreaterThan(weigh(paper({ status: "unread" })));
  });

  it("prefers an arrival over an already-kept paper", () => {
    expect(weigh(paper({ inInbox: true }))).toBeGreaterThan(weigh(paper({ inInbox: false })));
  });
});

describe("choosing", () => {
  it("returns nothing when there is nothing eligible", () => {
    expect(suggest([])).toBeUndefined();
    expect(suggest([paper({ status: "read" })])).toBeUndefined();
  });

  it("picks the only eligible paper", () => {
    const chosen = suggest([paper({ status: "read" }), paper({ title: "Open", status: "unread" })]);
    expect(chosen?.title).toBe("Open");
  });

  it("is driven by the injected random, so it is deterministic in tests", () => {
    const a = paper({ title: "A", edgeCount: 0 });
    const b = paper({ title: "B", edgeCount: 0 });
    expect(suggest([a, b], () => 0)?.title).toBe("A");
    expect(suggest([a, b], () => 0.99)?.title).toBe("B");
  });

  it("does not always return the same paper", () => {
    // A deterministic "best" suggestion is the same paper every day until you
    // read it, which is not a suggestion.
    const papers = [
      paper({ title: "A", edgeCount: 5 }),
      paper({ title: "B", edgeCount: 5 }),
      paper({ title: "C", edgeCount: 5 }),
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) seen.add(suggest(papers, () => i / 3)?.title as string);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("survives a random() of exactly 1", () => {
    expect(suggest([paper()], () => 1)).toBeDefined();
  });
});

describe("explaining the choice", () => {
  it("leads with the connection count", () => {
    expect(explain(paper({ edgeCount: 3 }))).toContain("cites 3 papers in your library");
    expect(explain(paper({ edgeCount: 1 }))).toContain("cites 1 paper in your library");
  });

  it("is honest when there are no links", () => {
    expect(explain(paper({ edgeCount: 0 }))).toContain("no citation links yet");
  });

  it("says where it lives", () => {
    expect(explain(paper({ inInbox: true }))).toContain("still in your inbox");
    expect(explain(paper({ inInbox: false }))).toContain("in your library");
  });
});

describe("read status in frontmatter", () => {
  const note = (extra = "") =>
    `---\ntitle: A Paper\norigin-ids:\n  - doi:10.1/x\n${extra}---\n\nbody\n`;

  it("reads a status that is there", () => {
    expect(readStatusOf(note("read-status: read\n"))).toBe("read");
    expect(readStatusOf(note("read-status: to-read\n"))).toBe("to-read");
  });

  it("treats a note with no status as unread", () => {
    expect(readStatusOf(note())).toBe("unread");
    expect(readStatusOf("no frontmatter here")).toBe("unread");
  });

  it("tolerates however the user typed it", () => {
    expect(parseReadStatus("Read")).toBe("read");
    expect(parseReadStatus("  TO READ ")).toBe("to-read");
    expect(parseReadStatus("reference only")).toBe("reference");
    expect(parseReadStatus("gibberish")).toBe("unread");
  });

  it("adds the key when absent", () => {
    const updated = withReadStatus(note(), "read");
    expect(readStatusOf(updated)).toBe("read");
    expect(updated).toContain("title: A Paper");
    expect(updated).toContain("body");
  });

  it("replaces the key when present, without duplicating it", () => {
    const updated = withReadStatus(note("read-status: to-read\n"), "read");
    expect(readStatusOf(updated)).toBe("read");
    expect(updated.match(/read-status:/g)).toHaveLength(1);
  });

  it("leaves a note with no frontmatter alone", () => {
    // Not ours to restructure.
    const prose = "# My own note\n\nthoughts\n";
    expect(withReadStatus(prose, "read")).toBe(prose);
  });
});
