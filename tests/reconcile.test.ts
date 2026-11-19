/**
 * The folders are the source of truth; records are only what the plugin
 * remembers about what it wrote. Any note under the inbox is an arrival, any
 * note under the papers folder is kept, and a note that left both was let go.
 */

import { describe, expect, it } from "vitest";
import { reconcileInbox } from "../src/core/reconcile";
import { normalizeTitle } from "../src/core/ids";
import type { InboxRecord } from "../src/core/update";
import { VaultIndex, type NoteEntry } from "../src/core/vault-state";

const today = "2026-07-19";

const record = (notePath: string, ids: string[]): InboxRecord => ({
  notePath,
  originIds: ids,
  title: notePath,
  arrivedOn: "2026-07-01",
  contentHash: "generated",
});

const note = (notePath: string, ids: string[], title?: string): NoteEntry => ({
  notePath,
  originIds: ids,
  title,
});

const kept = (...notes: NoteEntry[]) => new VaultIndex(notes, normalizeTitle);

describe("reconcileInbox", () => {
  it("changes nothing when every record's note is where it was written", () => {
    const records = [record("Inbox/A.md", ["doi:10.1/a"])];
    const result = reconcileInbox(records, [note("Inbox/A.md", ["doi:10.1/a"])], kept(), today);

    expect(result).toEqual({ inbox: records, removedIds: [], changed: false });
  });

  it("follows a note renamed or moved within the inbox, by id", () => {
    // Treating this as a deletion dropped the record — and filed the paper
    // under "removed" while its note sat right there in the inbox.
    const result = reconcileInbox(
      [record("Inbox/A.md", ["doi:10.1/a"])],
      [note("Inbox/Reading/A renamed.md", ["doi:10.1/a"])],
      kept(),
      today,
    );

    expect(result.inbox).toHaveLength(1);
    expect(result.inbox[0]?.notePath).toBe("Inbox/Reading/A renamed.md");
    expect(result.inbox[0]?.contentHash).toBe("generated"); // everything else carried over
    expect(result.removedIds).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it("forgets a kept paper without remembering it as removed", () => {
    const result = reconcileInbox(
      [record("Inbox/A.md", ["doi:10.1/a"])],
      [],
      kept(note("Papers/Sub/A.md", ["doi:10.1/a"])),
      today,
    );

    expect(result.inbox).toEqual([]);
    expect(result.removedIds).toEqual([]);
  });

  it("remembers a deleted arrival, or one moved out of both folders, as removed", () => {
    const result = reconcileInbox(
      [record("Inbox/A.md", ["doi:10.1/a", "openalex:W1"])],
      [],
      kept(),
      today,
    );

    expect(result.inbox).toEqual([]);
    expect(result.removedIds).toEqual(["doi:10.1/a", "openalex:W1"]);
  });

  it("adopts an inbox note it has no record of, as if the user had edited it", () => {
    // Records live in plugin data, which is per-device: a synced vault
    // arrives with its inbox notes but none of their records.
    const result = reconcileInbox(
      [],
      [note("Inbox/From Another Device.md", ["doi:10.1/x"], "From Another Device")],
      kept(),
      today,
    );

    expect(result.inbox).toEqual([
      {
        notePath: "Inbox/From Another Device.md",
        originIds: ["doi:10.1/x"],
        title: "From Another Device",
        arrivedOn: today,
        // Never equal to a real hash, so nothing is ever regenerated over it.
        contentHash: "",
      },
    ]);
    expect(result.changed).toBe(true);
  });

  it("ignores a note in the inbox that carries no paper id", () => {
    const result = reconcileInbox([], [note("Inbox/My own thoughts.md", [], "Thoughts")], kept(), today);
    expect(result).toEqual({ inbox: [], removedIds: [], changed: false });
  });

  it("lets a note be claimed once, by the record still at its path first", () => {
    const records = [
      record("Inbox/Gone.md", ["doi:10.1/a"]),
      record("Inbox/Here.md", ["doi:10.1/a"]),
    ];
    const result = reconcileInbox(records, [note("Inbox/Here.md", ["doi:10.1/a"])], kept(), today);

    expect(result.inbox.map((r) => r.notePath)).toEqual(["Inbox/Here.md"]);
  });
});
