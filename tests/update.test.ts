import { describe, expect, it } from "vitest";
import { findExisting, runUpdate, type InboxRecord, type VaultAdapter } from "../src/core/update";
import { VaultIndex, type NoteEntry } from "../src/core/vault-state";
import { normalizeTitle } from "../src/core/ids";
import { emptyWork, type Work } from "../src/core/types";

class MemoryVault implements VaultAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();

  async read(path: string) { return this.files.get(path); }
  async write(path: string, content: string) { this.files.set(path, content); }
  async exists(path: string) { return this.files.has(path); }
  async ensureFolder(path: string) { this.folders.add(path); }
  async list(folder: string) {
    const prefix = `${folder}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".md"));
  }
}

const settings = { inboxFolder: "Inbox", papersFolder: "Papers", maxArrivalsPerRun: 50 };

interface RawEntry {
  origin_ids?: string[];
  title?: string;
  // Accepted and ignored — leftover from when this shape came from a JSON
  // manifest. Kept so the call sites below don't need editing.
  content_hash?: string;
  generated_at?: string;
}

// Kept in the shape of a real note scan — {path: {origin_ids, title}} — so
// every test below reads like "here's what's in the vault" regardless of
// how that got recovered.
const vaultWith = (notes: Record<string, RawEntry>) => {
  const entries: NoteEntry[] = Object.entries(notes).map(([notePath, entry]) => ({
    notePath,
    originIds: entry.origin_ids ?? [],
    title: entry.title,
  }));
  return new VaultIndex(entries, normalizeTitle);
};

const emptyVault = () => vaultWith({});

function paper(key: string, title: string, extra: Partial<Work> = {}): Work {
  const work = emptyWork(key);
  work.title = title;
  work.ids = [{ namespace: "openalex", value: key }];
  return Object.assign(work, extra);
}

describe("findExisting — never inbox what the vault already has (spec §7.1)", () => {
  const vault = vaultWith({
    "Papers/Attention Is All You Need.md": {
      content_hash: "abc",
      generated_at: "2026-01-01T00:00:00Z",
      origin_ids: ["doi:10.5555/attention", "zotero:ABC"],
      title: "Attention Is All You Need",
    },
  });

  it("matches an existing paper by a shared id", () => {
    const work = paper("W1", "Attention Is All You Need");
    work.doi = "10.5555/Attention";
    expect(findExisting(work, vault, [])).toEqual({
      reason: "already-in-vault",
      existingPath: "Papers/Attention Is All You Need.md",
    });
  });

  it("matches by distinctive title when no id overlaps", () => {
    // The DOI-less case: nothing fetched can share `zotero:ABC`.
    const work = paper("W1", "attention is all-you need!");
    expect(findExisting(work, vault, [])?.reason).toBe("already-in-vault");
  });

  it("does not match an unrelated paper", () => {
    expect(findExisting(paper("W2", "A Completely Different Paper"), vault, [])).toBeUndefined();
  });

  it("refuses to match on a generic title", () => {
    const generic = vaultWith({
      "Papers/Introduction.md": {
        content_hash: "abc", generated_at: "x", origin_ids: ["zotero:Z"], title: "Introduction",
      },
    });
    // Two unrelated papers both called "Introduction" must not merge.
    expect(findExisting(paper("W3", "Introduction"), generic, [])).toBeUndefined();
  });

  it("matches something already in the inbox", () => {
    const inbox: InboxRecord[] = [{
      notePath: "Inbox/Some Paper.md",
      originIds: ["openalex:W9"],
      title: "Some Paper Title Here",
      arrivedOn: "2026-07-01",
      contentHash: "h",
    }];
    const work = paper("W9", "Some Paper Title Here");
    expect(findExisting(work, emptyVault(), inbox)?.reason).toBe("already-in-inbox");
  });

  it("refuses to re-add a paper that was added and later cleaned up", () => {
    // Cleanup drops the note *and* its tracked record, so without this check
    // there is nothing left anywhere to say "you already saw this and let it
    // go" — the same real, still-matching paper would just reappear.
    const work = paper("W9", "A Paper You Let Lapse");
    work.doi = "10.1/lapsed";
    expect(findExisting(work, emptyVault(), [], ["doi:10.1/lapsed"])?.reason).toBe(
      "previously-removed",
    );
  });

  it("does not confuse an unrelated paper for a previously-removed one", () => {
    const work = paper("W9", "An Unrelated Paper");
    expect(findExisting(work, emptyVault(), [], ["doi:10.1/something-else"])).toBeUndefined();
  });
});

describe("runUpdate", () => {
  const today = "2026-07-19";

  it("writes a note per arrival, and nothing else", async () => {
    const adapter = new MemoryVault();
    const { report, inbox } = await runUpdate({
      fetched: [paper("W1", "First Arrival Paper"), paper("W2", "Second Arrival Paper")],
      vault: emptyVault(), inbox: [], settings, adapter, today,
    });

    expect(report.arrived).toHaveLength(2);
    expect(adapter.files.has("Inbox/First Arrival Paper.md")).toBe(true);
    // No index page: it would link every arrival and become a hub node that
    // clusters them around itself instead of around the papers they cite.
    expect(adapter.files.size).toBe(2);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]?.arrivedOn).toBe(today);
  });

  it("writes each arrival to folderFor's answer, when supplied", async () => {
    const adapter = new MemoryVault();
    const arxivPaper = paper("W1", "From ArXiv");
    const topicPaper = paper("W2", "From Topic");
    await runUpdate({
      fetched: [arxivPaper, topicPaper],
      vault: emptyVault(),
      inbox: [],
      settings,
      adapter,
      today,
      folderFor: (work) => (work === arxivPaper ? "Inbox/ArXiv" : "Inbox"),
    });

    expect(adapter.files.has("Inbox/ArXiv/From ArXiv.md")).toBe(true);
    expect(adapter.files.has("Inbox/From Topic.md")).toBe(true);
    expect(adapter.folders.has("Inbox/ArXiv")).toBe(true);
  });

  it("falls back to settings.inboxFolder when folderFor is omitted", async () => {
    const adapter = new MemoryVault();
    await runUpdate({
      fetched: [paper("W1", "Plain Arrival")],
      vault: emptyVault(),
      inbox: [],
      settings,
      adapter,
      today,
    });

    expect(adapter.files.has("Inbox/Plain Arrival.md")).toBe(true);
  });

  it("skips and reports a paper already in the vault rather than duplicating it", async () => {
    const adapter = new MemoryVault();
    const vault = vaultWith({
      "Papers/Known Paper Title.md": {
        content_hash: "abc", generated_at: "x",
        origin_ids: ["openalex:W1"], title: "Known Paper Title",
      },
    });
    const { report } = await runUpdate({
      fetched: [paper("W1", "Known Paper Title")],
      vault, inbox: [], settings, adapter, today,
    });

    expect(report.arrived).toHaveLength(0);
    expect(report.skipped).toEqual([
      { title: "Known Paper Title", reason: "already-in-vault",
        existingPath: "Papers/Known Paper Title.md" },
    ]);
    expect(adapter.files.has("Inbox/Known Paper Title.md")).toBe(false);
  });

  it("never lets an inbox note collide with a Papers/ note name", async () => {
    const adapter = new MemoryVault();
    const vault = vaultWith({
      "Papers/Shared Name Paper.md": {
        content_hash: "abc", generated_at: "x",
        origin_ids: ["zotero:OTHER"], title: "Some Other Title Entirely",
      },
    });
    // Same *filename*, different paper (different ids and title).
    const work = paper("W5", "Shared Name Paper");
    const { report } = await runUpdate({
      fetched: [work], vault, inbox: [], settings, adapter, today,
    });

    expect(report.arrived).toHaveLength(1);
    expect(report.arrived[0]?.notePath).not.toBe("Inbox/Shared Name Paper.md");
    expect(adapter.files.has("Inbox/Shared Name Paper.md")).toBe(false);
  });

  it("wires citation edges between arrivals", async () => {
    const adapter = new MemoryVault();
    const citing = paper("W1", "The Citing Paper Here");
    citing.references = [{ namespace: "openalex", value: "W2" }];
    const cited = paper("W2", "The Cited Paper Here");

    const { report } = await runUpdate({
      fetched: [citing, cited], vault: emptyVault(), inbox: [], settings, adapter, today,
    });

    expect(report.arrived.find((a) => a.title === "The Citing Paper Here")?.edgeCount).toBe(1);
    const note = adapter.files.get("Inbox/The Citing Paper Here.md") as string;
    expect(note).toContain("[[The Cited Paper Here]]");
  });

  it("links an arrival to a paper already in the vault", async () => {
    const adapter = new MemoryVault();
    const vault = vaultWith({
      "Papers/Existing Vault Paper.md": {
        content_hash: "abc", generated_at: "x",
        origin_ids: ["openalex:W99"], title: "Existing Vault Paper",
      },
    });
    const arrival = paper("W1", "A Brand New Arrival");
    arrival.references = [{ namespace: "openalex", value: "W99" }];

    await runUpdate({ fetched: [arrival], vault, inbox: [], settings, adapter, today });

    const note = adapter.files.get("Inbox/A Brand New Arrival.md") as string;
    expect(note).toContain("[[Existing Vault Paper]]");
  });

  it("caps arrivals per run so a misconfigured source can't flood the vault", async () => {
    const adapter = new MemoryVault();
    const fetched = Array.from({ length: 10 }, (_, i) => paper(`W${i}`, `Paper Number ${i} Here`));
    const { report } = await runUpdate({
      fetched, vault: emptyVault(), inbox: [], settings: { ...settings, maxArrivalsPerRun: 3 },
      adapter, today,
    });

    expect(report.arrived).toHaveLength(3);
    expect(report.cappedAt).toBe(3);
  });

  it("collapses the same paper appearing twice in one batch", async () => {
    const adapter = new MemoryVault();
    const { report } = await runUpdate({
      fetched: [paper("W1", "Duplicated Paper Title"), paper("W1", "Duplicated Paper Title")],
      vault: emptyVault(), inbox: [], settings, adapter, today,
    });

    expect(report.arrived).toHaveLength(1);
    expect(report.skipped[0]?.reason).toBe("duplicate-in-batch");
  });

  it("keeps the better-connected candidate when the cap bites, regardless of fetch order", async () => {
    const adapter = new MemoryVault();
    const vault = vaultWith({
      "Papers/Kept Paper.md": {
        content_hash: "abc", generated_at: "x",
        origin_ids: ["openalex:W99"], title: "Kept Paper",
      },
    });
    const unconnected = paper("W1", "Unconnected Candidate");
    const connected = paper("W2", "Connected Candidate");
    connected.references = [{ namespace: "openalex", value: "W99" }];

    // The unconnected one is listed first — order must not be what decides.
    const { report } = await runUpdate({
      fetched: [unconnected, connected], vault, inbox: [],
      settings: { ...settings, maxArrivalsPerRun: 1 }, adapter, today,
    });

    expect(report.arrived).toHaveLength(1);
    expect(report.arrived[0]?.title).toBe("Connected Candidate");
    expect(report.cappedAt).toBe(1);
  });

  it("breaks a connectivity tie by recency, newest first", async () => {
    const adapter = new MemoryVault();
    const older = paper("W1", "Older Equally Connected Paper", { date: "2020-01-01" });
    const newer = paper("W2", "Newer Equally Connected Paper", { date: "2026-01-01" });

    const { report } = await runUpdate({
      fetched: [older, newer], vault: emptyVault(), inbox: [],
      settings: { ...settings, maxArrivalsPerRun: 1 }, adapter, today,
    });

    expect(report.arrived[0]?.title).toBe("Newer Equally Connected Paper");
  });

  it("records every origin id on the arrival, for later dedup", async () => {
    const adapter = new MemoryVault();
    const work = paper("W1", "A Paper With Several Ids");
    work.doi = "10.1/x";
    const { inbox } = await runUpdate({
      fetched: [work], vault: emptyVault(), inbox: [], settings, adapter, today,
    });
    expect(inbox[0]?.originIds).toEqual(["doi:10.1/x", "openalex:W1"]);
  });
});
