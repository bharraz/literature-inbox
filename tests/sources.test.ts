import { describe, expect, it } from "vitest";
import {
  describeSource,
  effective,
  emptySource,
  isUsable,
  migrateSources,
  needsValue,
  withinWindow,
} from "../src/core/sources";
import { emptyWork, type Work } from "../src/core/types";

const dated = (key: string, date?: string): Work => {
  const work = emptyWork(key);
  work.date = date;
  return work;
};

describe("migrating the old per-source settings", () => {
  it("turns every old shape into rows, connected source first", () => {
    // Order matters beyond tidiness: when the per-run cap bites, rows higher
    // in the list are kept, and a paper citing your library beats a topic hit.
    const sources = migrateSources(
      {
        openAlexEnabled: true,
        openAlexTopic: "transformers",
        arrivalSelection: "both",
        arxivEnabled: true,
        arxivCategories: "quant-ph, cs.CL",
        rssEnabled: true,
        feeds: [{ url: "https://a.example/f.xml", enabled: true, windowDays: 7 }],
      },
      [],
    );

    expect(sources.map((s) => `${s.kind}:${s.value}`)).toEqual([
      "citing:",
      "topic:transformers",
      "arxiv:quant-ph",
      "arxiv:cs.CL",
      "feed:https://a.example/f.xml",
    ]);
    expect(sources[4]?.windowDays).toBe(7);
  });

  it("honours the old selection mode", () => {
    const adjacentOnly = migrateSources(
      { openAlexTopic: "x", arrivalSelection: "adjacent" },
      [],
    );
    expect(adjacentOnly.map((s) => s.kind)).toEqual(["citing"]);

    const topicOnly = migrateSources({ openAlexTopic: "x", arrivalSelection: "topic" }, []);
    expect(topicOnly.map((s) => s.kind)).toEqual(["topic"]);
  });

  it("carries the old on/off switches onto the rows", () => {
    const sources = migrateSources(
      {
        openAlexEnabled: false,
        openAlexTopic: "x",
        rssEnabled: false,
        feeds: [{ url: "https://a.example/f.xml", enabled: true }],
      },
      [],
    );
    expect(sources.every((s) => !s.enabled)).toBe(true);
  });

  it("leaves existing rows alone, so migration runs once", () => {
    const existing = [emptySource("feed")];
    expect(migrateSources({ openAlexTopic: "x" }, existing)).toEqual(existing);
  });

  it("copies rather than aliasing stored rows", () => {
    const existing = [emptySource("topic")];
    const migrated = migrateSources({}, existing);
    migrated[0]!.enabled = false;
    expect(existing[0]!.enabled).toBe(true);
  });

  it("skips a blank feed URL", () => {
    const sources = migrateSources({ feeds: [{ url: "   ", enabled: true }], rssEnabled: true }, []);
    expect(sources).toEqual([{ kind: "citing", value: "", enabled: true }]);
  });
});

describe("what a row needs", () => {
  it("only 'citing' has nothing to type", () => {
    expect(needsValue("citing")).toBe(false);
    for (const kind of ["topic", "arxiv", "feed"] as const) {
      expect(needsValue(kind)).toBe(true);
    }
  });

  it("is unusable when switched off, or when its input is blank", () => {
    expect(isUsable({ kind: "topic", value: "x", enabled: true })).toBe(true);
    expect(isUsable({ kind: "topic", value: "x", enabled: false })).toBe(false);
    expect(isUsable({ kind: "topic", value: "  ", enabled: true })).toBe(false);
    // ...but 'citing' needs no value at all.
    expect(isUsable({ kind: "citing", value: "", enabled: true })).toBe(true);
  });

  it("describes itself for a run report", () => {
    expect(describeSource({ kind: "arxiv", value: "quant-ph", enabled: true })).toContain(
      "quant-ph",
    );
    expect(describeSource({ kind: "citing", value: "", enabled: true })).toBe(
      "Papers citing my library",
    );
  });
});

describe("windows and caps", () => {
  it("drops items older than the window but keeps undated ones", () => {
    const works = [dated("old", "2026-01-01"), dated("new", "2026-08-01"), dated("undated")];
    expect(withinWindow(works, "2026-07-01").map((w) => w.key)).toEqual(["new", "undated"]);
  });

  it("keeps an item dated exactly on the boundary", () => {
    expect(withinWindow([dated("edge", "2026-07-01")], "2026-07-01")).toHaveLength(1);
  });

  it("prefers a usable override and otherwise inherits", () => {
    expect(effective(7, 30)).toBe(7);
    expect(effective(0, 30)).toBe(0);
    expect(effective(undefined, 30)).toBe(30);
    expect(effective(Number.NaN, 30)).toBe(30);
  });
});
