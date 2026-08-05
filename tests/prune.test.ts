import { describe, expect, it } from "vitest";
import { applyPrune, classify, daysBetween, planPrune } from "../src/core/prune";
import { contentHash } from "../src/core/hash";
import type { InboxRecord, VaultAdapter } from "../src/core/update";

class MemoryVault implements VaultAdapter {
  readonly files = new Map<string, string>();
  async read(path: string) { return this.files.get(path); }
  async write(path: string, content: string) { this.files.set(path, content); }
  async exists(path: string) { return this.files.has(path); }
  async ensureFolder(path: string) { void path; }
  async list(folder: string) {
    const prefix = `${folder}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".md"));
  }
}

const TODAY = "2026-07-19";
const GENERATED = "generated note body";

function record(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    notePath: "Inbox/A Paper.md",
    originIds: ["openalex:W1"],
    title: "A Paper",
    arrivedOn: "2026-05-01", // 79 days before TODAY
    contentHash: contentHash(GENERATED),
    ...overrides,
  };
}

describe("daysBetween", () => {
  it("counts whole days", () => {
    expect(daysBetween("2026-07-01", "2026-07-19")).toBe(18);
    expect(daysBetween("2026-07-19", "2026-07-19")).toBe(0);
  });
});

describe("classify", () => {
  it("marks an old, untouched, still-in-inbox note prunable", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Inbox/A Paper.md", GENERATED);
    const result = await classify(record(), adapter, "Inbox", 30, TODAY);
    expect(result.verdict).toBe("prunable");
  });

  it("never prunes a note the user edited", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Inbox/A Paper.md", GENERATED + "\n\nMy own thoughts.");
    const result = await classify(record(), adapter, "Inbox", 30, TODAY);
    expect(result.verdict).toBe("touched");
  });

  it("never prunes inside the keep window", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Inbox/A Paper.md", GENERATED);
    const result = await classify(
      record({ arrivedOn: "2026-07-15" }), adapter, "Inbox", 30, TODAY,
    );
    expect(result.verdict).toBe("too-recent");
  });

  it("treats a note moved out of the inbox as kept", async () => {
    // This is the whole keep mechanism: moving the file *is* the signal.
    const adapter = new MemoryVault();
    adapter.files.set("Papers/A Paper.md", GENERATED);
    const result = await classify(
      record({ notePath: "Papers/A Paper.md" }), adapter, "Inbox", 30, TODAY,
    );
    expect(result.verdict).toBe("kept-moved");
  });

  it("treats a vanished note as gone rather than trying to prune it", async () => {
    const result = await classify(record(), new MemoryVault(), "Inbox", 30, TODAY);
    expect(result.verdict).toBe("gone");
  });

  it("never auto-prunes a manual add", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Inbox/A Paper.md", GENERATED);
    const result = await classify(record({ manual: true }), adapter, "Inbox", 30, TODAY);
    expect(result.verdict).toBe("manual");
  });
});

describe("planPrune / applyPrune", () => {
  it("separates prunable, forgettable and retained records", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Inbox/Old.md", GENERATED);
    adapter.files.set("Inbox/Edited.md", "user wrote here");
    adapter.files.set("Papers/Kept.md", GENERATED);

    const inbox = [
      record({ notePath: "Inbox/Old.md" }),
      record({ notePath: "Inbox/Edited.md" }),
      record({ notePath: "Papers/Kept.md" }),
      record({ notePath: "Inbox/Deleted.md" }),
    ];

    const plan = await planPrune(inbox, adapter, "Inbox", 30, TODAY);

    expect(plan.prunable.map((c) => c.record.notePath)).toEqual(["Inbox/Old.md"]);
    expect(plan.retained.map((c) => c.record.notePath)).toEqual(["Inbox/Edited.md"]);
    expect(plan.forget.map((c) => c.record.notePath).sort()).toEqual([
      "Inbox/Deleted.md", "Papers/Kept.md",
    ]);
  });

  it("removes only prunable notes and keeps the rest tracked", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Inbox/Old.md", GENERATED);
    adapter.files.set("Inbox/Edited.md", "user wrote here");
    const inbox = [
      record({ notePath: "Inbox/Old.md" }),
      record({ notePath: "Inbox/Edited.md" }),
    ];

    const plan = await planPrune(inbox, adapter, "Inbox", 30, TODAY);
    const removed: string[] = [];
    const remaining = await applyPrune(plan, async (path) => { removed.push(path); });

    expect(removed).toEqual(["Inbox/Old.md"]);
    expect(remaining.map((r) => r.notePath)).toEqual(["Inbox/Edited.md"]);
  });

  it("forgets a kept note so a later run cannot recreate it", async () => {
    const adapter = new MemoryVault();
    adapter.files.set("Papers/Kept.md", GENERATED);
    const plan = await planPrune(
      [record({ notePath: "Papers/Kept.md" })], adapter, "Inbox", 30, TODAY,
    );
    const remaining = await applyPrune(plan, async () => {
      throw new Error("must not remove anything");
    });
    expect(remaining).toEqual([]);
  });
});
