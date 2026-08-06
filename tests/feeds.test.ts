import { describe, expect, it } from "vitest";
import { effective, emptyFeed, migrateFeedList, withinWindow } from "../src/core/feeds";
import { emptyWork, type Work } from "../src/core/types";

const dated = (key: string, date?: string): Work => {
  const work = emptyWork(key);
  work.date = date;
  return work;
};

describe("migrateFeedList", () => {
  it("converts the old newline-separated string into rows", () => {
    const feeds = migrateFeedList("https://a.example/f.xml\nhttps://b.example/f.xml", []);
    expect(feeds).toEqual([
      { url: "https://a.example/f.xml", enabled: true },
      { url: "https://b.example/f.xml", enabled: true },
    ]);
  });

  it("handles the comma-separated form too", () => {
    expect(migrateFeedList("https://a.example/f.xml, https://b.example/f.xml", [])).toHaveLength(2);
  });

  it("leaves existing rows alone, so migration runs once", () => {
    // Otherwise every load would resurrect feeds the user had deleted.
    const existing = [{ url: "https://kept.example/f.xml", enabled: false }];
    expect(migrateFeedList("https://old.example/f.xml", existing)).toEqual(existing);
  });

  it("copies rather than aliasing the stored rows", () => {
    const existing = [emptyFeed("https://a.example/f.xml")];
    const migrated = migrateFeedList(undefined, existing);
    migrated[0]!.enabled = false;
    expect(existing[0]!.enabled).toBe(true);
  });

  it("is empty when there is nothing to migrate", () => {
    expect(migrateFeedList(undefined, undefined)).toEqual([]);
    expect(migrateFeedList("   ", [])).toEqual([]);
  });
});

describe("withinWindow", () => {
  it("drops items older than the window", () => {
    const works = [dated("old", "2026-01-01"), dated("new", "2026-08-01")];
    expect(withinWindow(works, "2026-07-01").map((w) => w.key)).toEqual(["new"]);
  });

  it("keeps an item dated exactly on the boundary", () => {
    expect(withinWindow([dated("edge", "2026-07-01")], "2026-07-01")).toHaveLength(1);
  });

  it("keeps undated items rather than silently losing them", () => {
    // Plenty of feeds omit dates. A false keep costs one dedup skip; a false
    // drop loses the paper permanently.
    expect(withinWindow([dated("undated")], "2026-07-01")).toHaveLength(1);
  });
});

describe("effective", () => {
  it("prefers the override when it is a usable number", () => {
    expect(effective(7, 30)).toBe(7);
    expect(effective(0, 30)).toBe(0);
  });

  it("falls back for blank, negative, or nonsense values", () => {
    expect(effective(undefined, 30)).toBe(30);
    expect(effective(-1, 30)).toBe(30);
    expect(effective(Number.NaN, 30)).toBe(30);
  });
});
