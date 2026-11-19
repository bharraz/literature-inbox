/**
 * Renames are followed as Obsidian reports them, so a renamed folder never
 * reads, on the next run, as every paper in it having been deleted.
 */

import { describe, expect, it } from "vitest";
import { applyRename, renamedPath, type RenameState } from "../src/core/renames";
import type { InboxRecord } from "../src/core/update";

const record = (notePath: string): InboxRecord => ({
  notePath,
  originIds: [`doi:10.1/${notePath}`],
  arrivedOn: "2026-10-01",
  contentHash: "h",
});

const state = (overrides: Partial<RenameState> = {}): RenameState => ({
  inboxFolder: "Inbox",
  papersFolder: "Papers",
  librarySubfolder: "",
  sources: [],
  inbox: [],
  ...overrides,
});

describe("renamedPath", () => {
  it("follows the renamed item itself and anything inside it", () => {
    expect(renamedPath("Inbox", "Inbox", "Arrivals")).toBe("Arrivals");
    expect(renamedPath("Inbox/Sub/A.md", "Inbox", "Arrivals")).toBe("Arrivals/Sub/A.md");
  });

  it("leaves a sibling that merely shares a prefix alone", () => {
    expect(renamedPath("Inbox2/A.md", "Inbox", "Arrivals")).toBeUndefined();
  });
});

describe("applyRename", () => {
  it("moves the inbox setting and every record when the inbox folder is renamed", () => {
    // Before this, the setting kept pointing at "Inbox", and the next run
    // found every arrival gone — and remembered each as deliberately let go.
    const result = applyRename(
      state({ inbox: [record("Inbox/A.md"), record("Inbox/Sub/B.md")] }),
      "Inbox",
      "Arrivals",
    );

    expect(result.changed).toBe(true);
    expect(result.inboxFolder).toBe("Arrivals");
    expect(result.inbox.map((r) => r.notePath)).toEqual(["Arrivals/A.md", "Arrivals/Sub/B.md"]);
  });

  it("is correct from the folder's event alone, and unmoved by the files' events after it", () => {
    const afterFolder = applyRename(state({ inbox: [record("Inbox/A.md")] }), "Inbox", "Arrivals");
    const afterFile = applyRename(afterFolder, "Inbox/A.md", "Arrivals/A.md");

    expect(afterFile.changed).toBe(false);
    expect(afterFile.inbox.map((r) => r.notePath)).toEqual(["Arrivals/A.md"]);
  });

  it("follows the library folder too", () => {
    expect(applyRename(state(), "Papers", "Library").papersFolder).toBe("Library");
  });

  it("keeps a source's folder written the way the user wrote it", () => {
    const sources = [
      { kind: "arxiv" as const, value: "cs.CL", enabled: true, inboxFolder: "ArXiv" },
      { kind: "feed" as const, value: "https://x", enabled: true, inboxFolder: "Inbox/Feeds" },
    ];

    const parentRenamed = applyRename(state({ sources }), "Inbox", "Arrivals");
    expect(parentRenamed.sources.map((s) => s.inboxFolder)).toEqual(["ArXiv", "Arrivals/Feeds"]);

    const subfolderRenamed = applyRename(state({ sources }), "Inbox/ArXiv", "Inbox/Preprints");
    expect(subfolderRenamed.sources.map((s) => s.inboxFolder)).toEqual(["Preprints", "Inbox/Feeds"]);
  });

  it("follows the library subfolder chosen for expansion", () => {
    const chosen = state({ librarySubfolder: "Ions" });
    expect(applyRename(chosen, "Papers", "Library").librarySubfolder).toBe("Ions");
    expect(applyRename(chosen, "Papers/Ions", "Papers/Trapped Ions").librarySubfolder).toBe(
      "Trapped Ions",
    );
    // Moved out of the library entirely: no longer a part of it to expand from.
    expect(applyRename(chosen, "Papers/Ions", "Archive/Ions").librarySubfolder).toBe("");
  });

  it("reports no change for a rename that touches nothing it holds", () => {
    const before = state({ inbox: [record("Inbox/A.md")], librarySubfolder: "Ions" });
    expect(applyRename(before, "Notes/Diary.md", "Notes/Journal.md").changed).toBe(false);
  });
});
