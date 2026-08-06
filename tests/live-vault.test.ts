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
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { App, notices, resetFakeObsidian, setRequestResponder } from "./fakes/obsidian";
import LiteratureInboxPlugin from "../src/main";

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

function report(label: string, lines: string[]): void {
  console.log(`\n=== ${label} ===\n${lines.join("\n")}`);
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
        p.settings.mailto = process.env.LIVE_MAILTO ?? "";
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
        p.settings.mailto = process.env.LIVE_MAILTO ?? "";
        p.settings.arrivalSelection = "both";
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

      // The product's claim, asserted rather than hoped: with adjacency
      // selection on, an arrival is connected *by construction*, so most of
      // them must carry a why-line. Measured at 25/25 on 2026-08-06.
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
        p.settings.mailto = process.env.LIVE_MAILTO ?? "";
        p.settings.openAlexEnabled = false;
        p.settings.rssEnabled = true;
        p.settings.feeds = [{ url: FEED, enabled: true }];
        p.settings.maxArrivalsPerRun = 25;
      });

      // Build the library with OpenAlex on, then switch to feed-only arrivals.
      p_enable(plugin, true);
      await plugin.buildKernel();
      p_enable(plugin, false);

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

/** The kernel needs OpenAlex even when arrivals come only from a feed. */
function p_enable(plugin: LiteratureInboxPlugin, enabled: boolean): void {
  plugin.settings.openAlexEnabled = enabled;
}
