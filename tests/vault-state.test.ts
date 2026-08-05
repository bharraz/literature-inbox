/**
 * Reader conformance against docs/interop-spec.md §4 — including the failure
 * modes the spec explicitly requires be non-fatal.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  STATE_PATH,
  VaultIndex,
  paperEntries,
  parseVaultState,
} from "../src/core/vault-state";
import { normalizeTitle } from "../src/core/ids";

/** A real state.json, copied from zot2vault's actual output. */
const REAL_STATE = JSON.stringify({
  version: 1,
  params: { zot2vault: { zotero_folder: "/home/me/Zotero" } },
  note_manifest: {
    "Papers/Attention Is All You Need.md": {
      content_hash: "ca2296bd80268786e69fc2b3abc290c6dca7851d3250d20435aec5894fd0a75d",
      generated_at: "2026-07-22T18:34:39Z",
      origin_ids: ["doi:10.5555/attention", "zotero:ABC123", "openalex:W2963403868"],
      title: "Attention Is All You Need",
    },
    "Authors/Ashish Vaswani.md": {
      content_hash: "219020e7a9b513d38cd999493f60ec187c23ef9b75789d200dedfc0b7f69b71a",
      generated_at: "2026-07-22T18:34:39Z",
      origin_ids: ["author:ashish vaswani"],
      title: "Ashish Vaswani",
    },
  },
  pdf_cache: {},
});

describe("path constant", () => {
  it("matches the spec", () => {
    expect(STATE_PATH).toBe(".scriptorium/state.json");
  });
});

describe("parseVaultState on real output", () => {
  it("reads every manifest entry", () => {
    const state = parseVaultState(REAL_STATE);
    expect(state.present).toBe(true);
    expect(state.version).toBe(1);
    expect(state.entries).toHaveLength(2);
  });

  it("keeps all origin ids, not just the first", () => {
    const entry = parseVaultState(REAL_STATE).entries.find((e) =>
      e.notePath.startsWith("Papers/"),
    );
    expect(entry?.originIds).toEqual([
      "doi:10.5555/attention", "zotero:ABC123", "openalex:W2963403868",
    ]);
  });
});

describe("degrading to empty state instead of failing (spec §4, §7.3)", () => {
  it("treats malformed JSON as empty", () => {
    expect(parseVaultState("{ not json")).toEqual(EMPTY_STATE);
  });

  it("treats a non-object payload as empty", () => {
    expect(parseVaultState("[1,2,3]")).toEqual(EMPTY_STATE);
    expect(parseVaultState('"a string"')).toEqual(EMPTY_STATE);
  });

  it("reads nothing from a newer schema version rather than guessing", () => {
    const future = JSON.stringify({
      version: 99,
      note_manifest: { "Papers/X.md": { content_hash: "abc", origin_ids: ["doi:10.1/x"] } },
    });
    const state = parseVaultState(future);
    expect(state.present).toBe(true);
    expect(state.version).toBe(99);
    expect(state.entries).toEqual([]);
  });

  it("tolerates a missing note_manifest", () => {
    expect(parseVaultState('{"version":1}').entries).toEqual([]);
  });

  it("skips a malformed entry without discarding the good ones", () => {
    const mixed = JSON.stringify({
      version: 1,
      note_manifest: {
        "Papers/Good.md": { content_hash: "abc", generated_at: "x", origin_ids: ["doi:10.1/g"] },
        "Papers/Bad.md": { origin_ids: ["doi:10.1/b"] }, // no content_hash
        "Papers/Worse.md": "not an object",
      },
    });
    const entries = parseVaultState(mixed).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.notePath).toBe("Papers/Good.md");
  });

  it("tolerates entries missing optional fields", () => {
    const sparse = JSON.stringify({
      version: 1,
      note_manifest: { "Papers/X.md": { content_hash: "abc" } },
    });
    const entry = parseVaultState(sparse).entries[0];
    expect(entry?.originIds).toEqual([]);
    expect(entry?.title).toBeUndefined();
  });
});

describe("author entries are not papers (spec §3.2)", () => {
  it("excludes them from paperEntries", () => {
    const papers = paperEntries(parseVaultState(REAL_STATE));
    expect(papers).toHaveLength(1);
    expect(papers[0]?.notePath).toBe("Papers/Attention Is All You Need.md");
  });

  it("never matches a fetched work against an author page", () => {
    const index = new VaultIndex(parseVaultState(REAL_STATE), normalizeTitle);
    expect(index.findByOrigin(["author:ashish vaswani"])).toBeUndefined();
    expect(index.findByTitle(normalizeTitle("Ashish Vaswani"))).toBeUndefined();
  });
});

describe("VaultIndex lookups", () => {
  const index = () => new VaultIndex(parseVaultState(REAL_STATE), normalizeTitle);

  it("matches on any overlapping id", () => {
    expect(index().findByOrigin(["openalex:W2963403868"])?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
    expect(index().findByOrigin(["zotero:ABC123"])?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
    // The realistic case: the plugin holds ids zot2vault never saw, plus one it did.
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

  it("is empty and harmless for an absent state file", () => {
    const index = new VaultIndex(EMPTY_STATE, normalizeTitle);
    expect(index.paperCount).toBe(0);
    expect(index.findByOrigin(["doi:10.1/x"])).toBeUndefined();
    expect(index.noteBaseNames()).toEqual([]);
  });
});
