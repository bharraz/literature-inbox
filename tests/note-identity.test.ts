/**
 * Recovering identity from a note's own frontmatter.
 *
 * This is what makes "keep by moving the note out of Inbox/" work in a vault
 * that has never seen zot2vault: without it, a kept paper is invisible to the
 * next update and gets fetched straight back into the inbox.
 */

import { describe, expect, it } from "vitest";
import { parseNoteIdentity } from "../src/core/note-identity";
import { mergeSnapshots, scanFolderIdentities, VaultIndex, EMPTY_STATE } from "../src/core/vault-state";
import { normalizeTitle } from "../src/core/ids";

const pluginNote = `---
title: A Paper About Transformers
authors:
  - Ada Lovelace
year: "2026"
doi: 10.1234/one
item-type: journalArticle
source: openalex
origin-ids:
  - doi:10.1234/one
  - openalex:W1
tags:
  - inbox
---

<!-- zot2vault:generated:start -->
# A Paper About Transformers
<!-- zot2vault:generated:end -->
`;

/** zot2vault writes no origin-ids; identity has to come from doi + title. */
const zot2vaultNote = `---
title: "Attention Is All You Need"
authors:
  - Ashish Vaswani
year: "2017"
doi: 10.5555/Attention
item-type: journalArticle
work-key: ABC123
---

<!-- zot2vault:generated:start -->
# Attention Is All You Need
<!-- zot2vault:generated:end -->
`;

describe("parseNoteIdentity", () => {
  it("reads the origin-ids list this plugin writes", () => {
    const identity = parseNoteIdentity(pluginNote);
    expect(identity?.originIds).toEqual(["doi:10.1234/one", "openalex:W1"]);
    expect(identity?.title).toBe("A Paper About Transformers");
  });

  it("recovers identity from a zot2vault note that has no origin-ids", () => {
    const identity = parseNoteIdentity(zot2vaultNote);
    // Frontmatter preserves the DOI's source casing; the origin id is lowercased.
    expect(identity?.originIds).toEqual(["doi:10.5555/attention"]);
    expect(identity?.title).toBe("Attention Is All You Need");
  });

  it("does not mistake a list item from another key for an origin id", () => {
    const identity = parseNoteIdentity(pluginNote);
    expect(identity?.originIds).not.toContain("Ada Lovelace");
    expect(identity?.originIds).not.toContain("inbox");
  });

  it("returns undefined for a note with no frontmatter", () => {
    expect(parseNoteIdentity("# Just a heading\n\nSome prose.")).toBeUndefined();
  });

  it("returns undefined for an unterminated frontmatter block", () => {
    expect(parseNoteIdentity("---\ntitle: Broken\n")).toBeUndefined();
  });

  it("returns undefined when frontmatter carries no identity at all", () => {
    expect(parseNoteIdentity("---\ntags:\n  - note\n---\n\nbody")).toBeUndefined();
  });

  it("survives a hand-edited note without throwing", () => {
    expect(() =>
      parseNoteIdentity("---\n:::garbage:::\n- stray\n---\nbody"),
    ).not.toThrow();
  });
});

describe("scanFolderIdentities", () => {
  const folder = "Papers";
  const files: Record<string, string> = {
    "Papers/A Paper About Transformers.md": pluginNote,
    "Papers/Attention Is All You Need.md": zot2vaultNote,
    "Papers/Hand Written Note.md": "# My own thoughts\n\nNot a paper.",
  };
  const list = async () => Object.keys(files);
  const read = async (path: string) => files[path];

  it("recovers an entry per identifiable note", async () => {
    const entries = await scanFolderIdentities(folder, list, read, parseNoteIdentity);
    expect(entries.map((e) => e.notePath).sort()).toEqual([
      "Papers/A Paper About Transformers.md",
      "Papers/Attention Is All You Need.md",
    ]);
  });

  it("ignores notes the user wrote themselves", async () => {
    const entries = await scanFolderIdentities(folder, list, read, parseNoteIdentity);
    expect(entries.some((e) => e.notePath.includes("Hand Written"))).toBe(false);
  });

  it("returns nothing when the folder does not exist", async () => {
    const entries = await scanFolderIdentities(
      folder,
      async () => { throw new Error("ENOENT"); },
      read,
      parseNoteIdentity,
    );
    expect(entries).toEqual([]);
  });

  it("skips an unreadable note instead of failing the scan", async () => {
    const entries = await scanFolderIdentities(
      folder,
      async () => ["Papers/Good.md", "Papers/Locked.md"],
      async (path) => {
        if (path.includes("Locked")) throw new Error("EACCES");
        return pluginNote;
      },
      parseNoteIdentity,
    );
    expect(entries).toHaveLength(1);
  });

  it("makes kept papers findable, with no manifest present at all", async () => {
    const entries = await scanFolderIdentities(folder, list, read, parseNoteIdentity);
    const index = new VaultIndex(mergeSnapshots(EMPTY_STATE, entries), normalizeTitle);

    // The exact regression: a paper kept by moving its note must be
    // recognised on the next update rather than fetched again.
    expect(index.findByOrigin(["openalex:W1"])?.notePath).toBe(
      "Papers/A Paper About Transformers.md",
    );
    expect(index.findByOrigin(["doi:10.5555/attention"])?.notePath).toBe(
      "Papers/Attention Is All You Need.md",
    );
  });
});

describe("mergeSnapshots", () => {
  const scanned = [
    { notePath: "Papers/X.md", contentHash: "", generatedAt: "", originIds: ["doi:10.1/x"] },
  ];

  it("keeps manifest entries authoritative for a path present in both", () => {
    const state = {
      present: true,
      version: 1,
      entries: [
        {
          notePath: "Papers/X.md",
          contentHash: "real-hash",
          generatedAt: "2026-01-01T00:00:00Z",
          originIds: ["doi:10.1/x", "zotero:ABC"],
          title: "X",
        },
      ],
    };
    const merged = mergeSnapshots(state, scanned);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]?.contentHash).toBe("real-hash");
  });

  it("adds scanned entries the manifest doesn't know about", () => {
    const merged = mergeSnapshots(EMPTY_STATE, scanned);
    expect(merged.entries).toHaveLength(1);
    expect(merged.present).toBe(true);
  });
});
