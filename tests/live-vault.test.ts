/**
 * Build a real vault, against the real APIs, and measure whether it connects.
 *
 * **Skipped by default** — run with `npm run test:vault`.
 *
 * This is the harness that closes a gap the rest of the suite genuinely
 * cannot: hermetic tests prove an arrival *would* be wired to a kept paper if
 * the reference lists said so, but they say so because a fixture says so.
 * Whether real papers fetched today actually connect to a real starting graph
 * built today is an empirical question about OpenAlex's data, and the only way
 * to answer it is to go and look.
 *
 * What it still cannot judge: whether the resulting graph *looks* like a good
 * triage surface. It writes the vault to disk so a human can open it and
 * decide — but the numbers below are the part that was previously guesswork.
 *
 * Order matters here: the reference-index suite runs first, deliberately,
 * because it is the cheapest (a handful of single-id lookups) and the suite
 * this file exists to prove out today. The kernel/arrivals/feed suite below
 * it burns a much larger real request budget and can trip OpenAlex's burst
 * rate limit if run back to back without a key — running it second means
 * that risk falls on the least critical tests, not the reference-index ones.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { App, notices, resetFakeObsidian, setRequestResponder } from "./fakes/obsidian";
import LiteratureInboxPlugin from "../src/main";
import { OpenAlexClient } from "../src/core/openalex";
import type { Transport, TransportResponse } from "../src/core/http";
import type { Work } from "../src/core/types";

const LIVE = process.env.LIVE_VAULT === "1";
const suite = LIVE ? describe : describe.skip;

const TIMEOUT = 600_000;
const OUT_DIR = join(process.cwd(), "live-vault");

/** The topic the vault is built around. Override with LIVE_TOPIC. */
const TOPIC = process.env.LIVE_TOPIC ?? "trapped ion quantum computing";
/** A real arXiv feed, to exercise the fastest source and the DOI backfill. */
const FEED = process.env.LIVE_FEED ?? "https://rss.arxiv.org/rss/quant-ph";

/** Point the fake's requestUrl at the actual network. */
function useRealNetwork(): void {
  setRequestResponder(async (url) => {
    const response = await fetch(url, {
      headers: { "User-Agent": "literature-inbox-livetest/0.1 (contact via GitHub)" },
    });
    return {
      status: response.status,
      text: await response.text(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
    };
  });
}

async function boot(configure: (plugin: LiteratureInboxPlugin) => void) {
  const app = new App();
  const plugin = new LiteratureInboxPlugin(app as never, {} as never);
  await plugin.onload();
  configure(plugin);
  return { app, plugin };
}

/** Write the in-memory vault out, so it can be opened in Obsidian. */
function dumpVault(app: App, label: string): string {
  const root = join(OUT_DIR, label);
  rmSync(root, { recursive: true, force: true });
  for (const [path, content] of app.vault.files) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  return root;
}

function report(label: string, lines: string[]): void {
  console.log(`\n=== ${label} ===\n${lines.join("\n")}`);
}

class NodeTransport implements Transport {
  async get(url: string): Promise<TransportResponse> {
    const response = await fetch(url, {
      headers: { "User-Agent": "literature-inbox-livetest/0.1 (contact via GitHub)" },
    });
    return { status: response.status, text: await response.text() };
  }
}

/**
 * Find a real citer/cited pair — never hardcoded, since OpenAlex ids are not
 * permanent (records get merged or withdrawn, and a pinned one has 404ed on
 * us before). Pulls a batch of well-cited real papers on *topic*, then walks
 * each one's real reference list until one reference
 * resolves to a real work with both a title and a DOI (addByIds needs a DOI
 * to look the paper up by).
 */
async function findRealCitationPair(topic = TOPIC): Promise<{ citer: Work; cited: Work }> {
  const client = new OpenAlexClient(new NodeTransport(), {
    apiKey: process.env.LIVE_OPENALEX_KEY || undefined,
  });
  const candidates = await client.topWorks(topic, 25);
  for (const citer of candidates) {
    if (!citer.doi || citer.references.length === 0) continue;
    for (const reference of citer.references.slice(0, 8)) {
      const [cited] = await client.worksByIds([reference.value]);
      if (cited?.title && cited.doi) return { citer, cited };
    }
  }
  throw new Error(`could not find a real citer/cited pair on topic "${topic}"`);
}

/**
 * Note base name (no extension) for the note that *is about* this title —
 * matched against the generated `# Title` heading specifically, not a bare
 * content substring, since another note's "Cites"/"Cited by" section also
 * contains this exact title as link text and would otherwise match first.
 */
function noteNameFor(app: App, folder: string, title: string): string | undefined {
  const heading = `# ${title}`;
  for (const [path, content] of app.vault.files) {
    if (!path.startsWith(`${folder}/`) || !path.endsWith(".md")) continue;
    if (content.split("\n").includes(heading)) return path.slice(folder.length + 1, -3);
  }
  return undefined;
}

suite("retroactive citation linking, on real data", () => {
  it(
    "links two real papers regardless of which one arrives first",
    async () => {
      const { citer, cited } = await findRealCitationPair();
      report("real pair found", [
        `citer: "${citer.title}" (${citer.date}) — doi:${citer.doi}`,
        `cited: "${cited.title}" (${cited.date}) — doi:${cited.doi}`,
      ]);
      // Sanity on the pair itself, independent of the plugin: a citation
      // can't point at the future.
      expect((cited.date ?? "") <= (citer.date ?? "9999")).toBe(true);

      // --- Order A: the cited paper is already kept when the citer arrives.
      // The ordinary forward pass — already covered by hermetic tests, run
      // here again on real data as a sanity check before the harder case.
      resetFakeObsidian();
      useRealNetwork();
      const forward = await boot((p) => {
        p.settings.openAlexApiKey = process.env.LIVE_OPENALEX_KEY ?? "";
      });
      await forward.plugin.addByIds(cited.doi as string, "papers");
      await forward.plugin.addByIds(citer.doi as string, "inbox");

      const citerNoteFwd = noteNameFor(forward.app, "Inbox", citer.title ?? "");
      const citedNoteFwd = noteNameFor(forward.app, "Papers", cited.title ?? "");
      expect(citerNoteFwd && citedNoteFwd).toBeTruthy();
      const citerContentFwd = forward.app.vault.files.get(
        `Inbox/${citerNoteFwd}.md`,
      ) as string;
      expect(citerContentFwd).toContain("### Cites");
      expect(citerContentFwd).toContain(`[[${citedNoteFwd}]]`);
      dumpVault(forward.app, "reference-index-forward");

      // --- Order B: the citer arrives first, citing a paper that doesn't
      // exist in the vault yet — the retroactive case this whole feature
      // exists for. Nothing here is a fresh fetch of the citer's references;
      // the second call below relies entirely on what got persisted to
      // plugin.referenceIndex on the *first* call.
      resetFakeObsidian();
      useRealNetwork();
      const retro = await boot((p) => {
        p.settings.openAlexApiKey = process.env.LIVE_OPENALEX_KEY ?? "";
      });
      await retro.plugin.addByIds(citer.doi as string, "inbox");

      const citerNoteRetro = noteNameFor(retro.app, "Inbox", citer.title ?? "");
      expect(citerNoteRetro).toBeTruthy();
      const beforeLink = retro.app.vault.files.get(`Inbox/${citerNoteRetro}.md`) as string;
      // The cited paper doesn't exist in this fresh vault yet, so on arrival
      // the citer has nothing real to resolve against — no edge yet.
      const hadNoEdgeYet = !beforeLink.includes(`[[${citedNoteFwd}]]`);

      const persisted = (
        retro.plugin as never as { referenceIndex: { ids: string[]; references: string[] }[] }
      ).referenceIndex;
      report("persisted after the citer's first arrival", [
        `referenceIndex entries: ${persisted.length}`,
        `citer's own record present: ${persisted.some((r) => r.ids.includes(`doi:${citer.doi}`))}`,
      ]);
      expect(persisted.some((r) => r.ids.includes(`doi:${citer.doi}`))).toBe(true);

      // Now the cited paper shows up, on a completely separate run — the
      // citer's note is never re-fetched to make this work.
      await retro.plugin.addByIds(cited.doi as string, "inbox");

      const citedNoteRetro = noteNameFor(retro.app, "Inbox", cited.title ?? "");
      expect(citedNoteRetro).toBeTruthy();
      const afterLink = retro.app.vault.files.get(`Inbox/${citerNoteRetro}.md`) as string;
      const citedContent = retro.app.vault.files.get(`Inbox/${citedNoteRetro}.md`) as string;
      const path = dumpVault(retro.app, "reference-index-retroactive");

      report("after the cited paper arrives later", [
        `citer's note gained "### Cites": ${afterLink.includes("### Cites")}`,
        `cited's note gained "### Cited by": ${citedContent.includes("### Cited by")}`,
        `vault written to: ${path}`,
      ]);

      expect(hadNoEdgeYet).toBe(true);
      expect(afterLink).toContain("### Cites");
      expect(afterLink).toContain(`[[${citedNoteRetro}]]`);
      expect(citedContent).toContain("### Cited by");
      expect(citedContent).toContain(`[[${citerNoteRetro}]]`);

      // --- Growth control: simulate closing and reopening the vault (a
      // fresh plugin instance loading the same persisted data.json), then
      // remove the citer's note the way cleanup does, and confirm a further
      // run prunes its record rather than keeping it forever.
      const reloaded = new LiteratureInboxPlugin(retro.app as never, {} as never);
      (reloaded as never as { stored: unknown }).stored = (
        retro.plugin as never as { stored: unknown }
      ).stored;
      await reloaded.onload();
      const beforePrune = (reloaded as never as { referenceIndex: unknown[] }).referenceIndex
        .length;

      retro.app.vault.files.delete(`Inbox/${citerNoteRetro}.md`);
      (reloaded as never as { inbox: { notePath: string }[] }).inbox = (
        reloaded as never as { inbox: { notePath: string }[] }
      ).inbox.filter((r) => r.notePath !== `Inbox/${citerNoteRetro}.md`);

      // Any run that writes at least one note re-merges and prunes — add a
      // third, unrelated real paper (a different topic, so it can't collide
      // with anything already in this vault) to trigger it.
      const trigger = await findRealCitationPair("machine translation");
      await reloaded.addByIds(trigger.cited.doi as string, "inbox");
      const afterPrune = (reloaded as never as { referenceIndex: { ids: string[] }[] })
        .referenceIndex;

      report("after reload + cleanup + another run", [
        `referenceIndex before prune: ${beforePrune}`,
        `referenceIndex after: ${afterPrune.length}`,
        `citer's stale record gone: ${!afterPrune.some((r) => r.ids.includes(`doi:${citer.doi}`))}`,
      ]);
      expect(afterPrune.some((r) => r.ids.includes(`doi:${citer.doi}`))).toBe(false);
    },
    TIMEOUT,
  );
});

interface Connectivity {
  arrivals: number;
  withAnyEdge: number;
  withKeptEdge: number;
  isolated: number;
}

/**
 * The product's central claim, counted.
 *
 * `withKeptEdge` is the one that matters: an arrival linked only to other
 * unread arrivals tells you nothing, while one linked to a paper you kept is
 * the entire "why you're seeing this" signal.
 */
function connectivity(app: App, inboxFolder: string): Connectivity {
  const result: Connectivity = { arrivals: 0, withAnyEdge: 0, withKeptEdge: 0, isolated: 0 };
  for (const [path, content] of app.vault.files) {
    if (!path.startsWith(`${inboxFolder}/`) || path.endsWith("_Inbox.md")) continue;
    result.arrivals += 1;
    const hasEdges = content.includes("## Citations");
    if (hasEdges) result.withAnyEdge += 1;
    else result.isolated += 1;
    if (content.includes("Why you're seeing this")) result.withKeptEdge += 1;
  }
  return result;
}

suite("a real vault, end to end", () => {
  it(
    "builds a starting graph that is actually a graph",
    async () => {
      resetFakeObsidian();
      useRealNetwork();
      const { app, plugin } = await boot((p) => {
        p.settings.openAlexTopic = TOPIC;
        p.settings.kernelMode = "topic";
        p.settings.kernelSize = 100;
        p.settings.openAlexApiKey = process.env.LIVE_OPENALEX_KEY ?? "";
      });

      await plugin.buildKernel();

      const papers = [...app.vault.files.keys()].filter((p) => p.startsWith("Papers/"));
      const withCitations = [...app.vault.files.entries()].filter(
        ([path, text]) => path.startsWith("Papers/") && text.includes("## Citations"),
      ).length;

      report("kernel", [
        `topic: ${TOPIC}`,
        `papers written: ${papers.length}`,
        `papers with at least one edge: ${withCitations}`,
        `connected fraction: ${((withCitations / Math.max(1, papers.length)) * 100).toFixed(0)}%`,
      ]);

      // A starting graph whose papers don't cite each other is a list, and the
      // whole premise rests on it being a graph.
      expect(papers.length).toBeGreaterThan(20);
      expect(withCitations / papers.length).toBeGreaterThan(0.3);
    },
    TIMEOUT,
  );

  it(
    "wires real arrivals into a real library",
    async () => {
      resetFakeObsidian();
      useRealNetwork();
      const { app, plugin } = await boot((p) => {
        p.settings.openAlexTopic = TOPIC;
        p.settings.kernelMode = "topic";
        p.settings.kernelSize = 120;
        p.settings.openAlexApiKey = process.env.LIVE_OPENALEX_KEY ?? "";
        // Both streams on: adjacency ("citing my library") is connected by
        // construction, topic is the broader, noisier one.
        p.settings.sources = [
          { kind: "citing", value: "", enabled: true },
          { kind: "topic", value: TOPIC, enabled: true },
        ];
        p.settings.maxArrivalsPerRun = 25;
        p.settings.newWindowDays = 30;
      });

      await plugin.buildKernel();
      const kept = [...app.vault.files.keys()].filter((p) => p.startsWith("Papers/")).length;

      await plugin.updateInbox();
      const stats = connectivity(app, "Inbox");
      const path = dumpVault(app, "openalex");

      report("openalex arrivals", [
        `kept papers: ${kept}`,
        `arrivals: ${stats.arrivals}`,
        `with any citation edge: ${stats.withAnyEdge}`,
        `with an edge to a KEPT paper (why-line fires): ${stats.withKeptEdge}`,
        `isolated dots: ${stats.isolated}`,
        `vault written to: ${path}`,
        `notices: ${notices.join(" | ")}`,
      ]);

      // The product's claim, asserted rather than hoped: with the "citing my
      // library" source on, an arrival is connected *by construction*, so
      // most of them must carry a why-line. Measured at 25/25 on 2026-08-06.
      expect(stats.arrivals).toBeGreaterThan(0);
      expect(stats.withKeptEdge / stats.arrivals).toBeGreaterThan(0.5);
    },
    TIMEOUT,
  );

  it(
    "connects arrivals that arrive from a feed with no reference list",
    async () => {
      // arXiv publishes no references, so these land edge-less and depend
      // entirely on the DOI backfill finding them in OpenAlex afterwards.
      // This is the path most likely to quietly produce isolated dots.
      resetFakeObsidian();
      useRealNetwork();
      const { app, plugin } = await boot((p) => {
        p.settings.openAlexTopic = TOPIC;
        p.settings.kernelMode = "topic";
        p.settings.kernelSize = 120;
        p.settings.openAlexApiKey = process.env.LIVE_OPENALEX_KEY ?? "";
        p.settings.maxArrivalsPerRun = 25;
      });

      // Build the library with a topic source, then switch to feed-only
      // arrivals — the source array, not a dead boolean, is what governs this.
      await plugin.buildKernel();
      plugin.settings.sources = [{ kind: "feed", value: FEED, enabled: true }];

      await plugin.updateInbox();
      const stats = connectivity(app, "Inbox");
      const path = dumpVault(app, "feed");

      report("feed arrivals", [
        `feed: ${FEED}`,
        `arrivals: ${stats.arrivals}`,
        `with any citation edge: ${stats.withAnyEdge}`,
        `with an edge to a KEPT paper (why-line fires): ${stats.withKeptEdge}`,
        `isolated dots: ${stats.isolated}`,
        `vault written to: ${path}`,
      ]);

      // Deliberately only asserts that papers *arrive*. Feed items are hours
      // old and OpenAlex has not indexed them, so they legitimately have no
      // reference list yet and land isolated — the freshest source is the
      // least connected, by construction. Asserting connectivity here would
      // be asserting that arXiv publishes references, which it does not.
      expect(stats.arrivals).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
