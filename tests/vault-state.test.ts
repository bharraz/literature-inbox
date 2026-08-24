/**
 * `VaultIndex` lookup behaviour, over plain note-entry data — the shape
 * `scanFolderIdentities` produces by reading notes directly.
 */

import { describe, expect, it } from "vitest";
import { VaultIndex, type NoteEntry } from "../src/core/vault-state";
import { normalizeTitle } from "../src/core/ids";

const ENTRIES: NoteEntry[] = [
  {
    notePath: "Papers/Attention Is All You Need.md",
    originIds: ["doi:10.5555/attention", "zotero:ABC123", "openalex:W2963403868"],
    title: "Attention Is All You Need",
  },
  {
    notePath: "Authors/Ashish Vaswani.md",
    originIds: ["author:ashish vaswani"],
    title: "Ashish Vaswani",
  },
];

describe("author entries are not papers", () => {
  it("never matches a fetched work against an author page", () => {
    const index = new VaultIndex(ENTRIES, normalizeTitle);
    expect(index.findByOrigin(["author:ashish vaswani"])).toBeUndefined();
    expect(index.findByTitle(normalizeTitle("Ashish Vaswani"))).toBeUndefined();
  });

  it("excludes author entries from the paper count", () => {
    const index = new VaultIndex(ENTRIES, normalizeTitle);
    expect(index.paperCount).toBe(1);
  });
});

describe("VaultIndex lookups", () => {
  const index = () => new VaultIndex(ENTRIES, normalizeTitle);

  it("matches on any overlapping id", () => {
    expect(index().findByOrigin(["openalex:W2963403868"])?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
    expect(index().findByOrigin(["zotero:ABC123"])?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
    // The realistic case: a fetched work carries ids the note never listed,
    // plus one that overlaps.
    expect(index().findByOrigin(["arxiv:1706.03762", "doi:10.5555/attention"])?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
  });

  it("returns undefined when nothing overlaps", () => {
    expect(index().findByOrigin(["doi:10.1/unknown"])).toBeUndefined();
    expect(index().findByOrigin([])).toBeUndefined();
  });

  it("matches by normalized title", () => {
    expect(index().findByTitle(normalizeTitle("attention is all-you need!"))?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
  });

  it("exposes existing note base names for collision avoidance", () => {
    expect(index().noteBaseNames()).toContain("Attention Is All You Need");
  });

  it("is empty and harmless for a vault with no notes yet", () => {
    const empty = new VaultIndex([], normalizeTitle);
    expect(empty.paperCount).toBe(0);
    expect(empty.findByOrigin(["doi:10.1/x"])).toBeUndefined();
    expect(empty.noteBaseNames()).toEqual([]);
  });
});
