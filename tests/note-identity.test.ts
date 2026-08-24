/**
 * Recovering identity from a note's own frontmatter.
 *
 * This is what makes "keep by moving the note out of Inbox/" work at all:
 * without it, a kept paper is invisible to the next update and gets fetched
 * straight back into the inbox.
 */

import { describe, expect, it } from "vitest";
import { parseNoteIdentity } from "../src/core/note-identity";
import { scanFolderIdentities, VaultIndex } from "../src/core/vault-state";
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

<!-- literature-inbox:generated:start -->
# A Paper About Transformers
<!-- literature-inbox:generated:end -->
`;

/** A note with a `doi` field but no `origin-ids` list — identity has to come
 * from doi + title alone, the case a hand-written or externally-authored
 * note is most likely to land in. */
const doiOnlyNote = `---
title: "Attention Is All You Need"
authors:
  - Ashish Vaswani
year: "2017"
doi: 10.5555/Attention
item-type: journalArticle
---

<!-- literature-inbox:generated:start -->
# Attention Is All You Need
<!-- literature-inbox:generated:end -->
`;

describe("parseNoteIdentity", () => {
  it("reads the origin-ids list this plugin writes", () => {
    const identity = parseNoteIdentity(pluginNote);
    expect(identity?.originIds).toEqual(["doi:10.1234/one", "openalex:W1"]);
    expect(identity?.title).toBe("A Paper About Transformers");
  });

  it("recovers identity from a note that has no origin-ids", () => {
    const identity = parseNoteIdentity(doiOnlyNote);
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
    "Papers/Attention Is All You Need.md": doiOnlyNote,
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

  it("makes kept papers findable, with nothing but the folder itself", async () => {
    const entries = await scanFolderIdentities(folder, list, read, parseNoteIdentity);
    const index = new VaultIndex(entries, normalizeTitle);

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
