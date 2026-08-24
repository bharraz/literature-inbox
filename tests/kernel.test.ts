import { describe, expect, it } from "vitest";
import {
  estimateConnectivity,
  selectTopicCandidates,
  runKernel,
  type KernelRunInput,
} from "../src/core/kernel";
import { makeId } from "../src/core/ids";
import { emptyWork, type Work, type WorkId } from "../src/core/types";
import { VaultIndex } from "../src/core/vault-state";
import { normalizeTitle } from "../src/core/ids";
import type { VaultAdapter } from "../src/core/update";

class MemoryVault implements VaultAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  async read(path: string) {
    return this.files.get(path);
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async ensureFolder(path: string) {
    this.folders.add(path);
  }
  async list(folder: string) {
    const prefix = `${folder}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".md"));
  }
}

function paper(key: string, title: string, refs: string[] = []): Work {
  const work = emptyWork(key);
  work.title = title;
  work.ids = [makeId("openalex", key)];
  work.references = refs.map((r): WorkId => makeId("openalex", r));
  return work;
}

const emptyVault = new VaultIndex([], normalizeTitle);

describe("selectTopicCandidates — balance impact anchors with connectivity fill", () => {
  it("always keeps the top-ranked candidate even if it turns out disconnected", () => {
    // W1 is the most-cited (rank 0) but shares no edge with anything else in
    // the pool — a pure-connectivity sort would drop it, which is exactly
    // the "obscure but interlinked beats the actual classic" failure mode.
    const w1 = paper("W1", "The Classic");
    const w2 = paper("W2", "A Pair", ["W3"]);
    const w3 = paper("W3", "Its Citer");
    const selected = selectTopicCandidates([w1, w2, w3], 2);
    expect(selected.map((w) => w.key)).toContain("W1");
  });

  it("fills remaining slots by connecting to what's already selected, not by rank alone", () => {
    // W1 (anchor) cites W3. W4 is isolated. W5 cites W3. Rank order puts W4
    // ahead of W5, but W5 is the one that actually connects to the anchor.
    const w1 = paper("W1", "Anchor", ["W3"]);
    const w2 = paper("W2", "Second Anchor");
    const w3 = paper("W3", "Cited By Anchor");
    const w4 = paper("W4", "Isolated Filler");
    const w5 = paper("W5", "Also Cites W3", ["W3"]);
    const selected = selectTopicCandidates([w1, w2, w3, w4, w5], 4);
    expect(selected.map((w) => w.key).sort()).toEqual(["W1", "W2", "W3", "W5"]);
  });
});

describe("estimateConnectivity", () => {
  it("counts connected works and distinct edges, not directed pairs twice", () => {
    const a = paper("A", "A", ["B"]);
    const b = paper("B", "B");
    const c = paper("C", "C");
    expect(estimateConnectivity([a, b, c])).toEqual({ connected: 2, total: 3, edges: 1 });
  });

  it("reports zero connectivity for a fully disjoint set", () => {
    const works = [paper("A", "A"), paper("B", "B"), paper("C", "C")];
    expect(estimateConnectivity(works)).toEqual({ connected: 0, total: 3, edges: 0 });
  });
});

describe("runKernel targetCount — balanced trimming", () => {
  it("keeps the top-ranked anchor even if isolated, and fills the rest by connectivity", async () => {
    const works = [
      paper("W1", "Top-Ranked Anchor"), // rank 0, isolated — kept as an anchor regardless.
      paper("W2", "Second Anchor", ["W3"]), // rank 1, also an anchor — and connected.
      paper("W3", "Connects To Anchor"), // fill slot: connects to W2.
      paper("W4", "Isolated Extra"), // loses the fill slot to W3.
    ];
    const vault = new MemoryVault();
    const input: KernelRunInput = {
      works,
      vault: emptyVault,
      papersFolder: "Papers",
      adapter: vault,
      today: "2026-08-24",
      targetCount: 3,
    };

    const report = await runKernel(input);

    expect(report.written.map((w) => w.title).sort()).toEqual([
      "Connects To Anchor",
      "Second Anchor",
      "Top-Ranked Anchor",
    ]);
    expect(report.totalEdges).toBe(1);
  });

  it("never links a written note to a candidate that lost the connectivity cut", async () => {
    // W3 cites both W4 (which will be written) and W5 (which will not, since
    // targetCount keeps only the two most-connected). The dropped edge must
    // not appear as a link to a note that was never created.
    const works = [
      paper("W3", "Hub", ["W4", "W5"]),
      paper("W4", "Kept Target"),
      paper("W5", "Cut Target"),
      paper("W1", "Filler"),
    ];
    const vault = new MemoryVault();
    const report = await runKernel({
      works,
      vault: emptyVault,
      papersFolder: "Papers",
      adapter: vault,
      today: "2026-08-24",
      targetCount: 2,
    });

    expect(report.written.map((w) => w.title).sort()).toEqual(["Hub", "Kept Target"]);
    const hubContent = vault.files.get("Papers/Hub.md") ?? "";
    expect(hubContent).toContain("Kept Target");
    expect(hubContent).not.toContain("Cut Target");
  });

  it("leaves behavior unchanged when there is no targetCount", async () => {
    const works = [paper("W1", "One"), paper("W2", "Two")];
    const vault = new MemoryVault();
    const report = await runKernel({
      works,
      vault: emptyVault,
      papersFolder: "Papers",
      adapter: vault,
      today: "2026-08-24",
    });
    expect(report.written).toHaveLength(2);
  });
});
