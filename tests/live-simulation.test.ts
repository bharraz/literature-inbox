/**
 * A simulated month of use, on real data, across several fields.
 *
 * **Skipped by default** — run with `npm run test:sim`.
 *
 * The single-run harness (live-vault.test.ts) answers "does one update
 * connect?". This answers the questions that only appear over time and only
 * with a user in the loop:
 *
 *   - does running again tomorrow add duplicates?
 *   - once you keep papers, do later arrivals connect to *those*?
 *   - does a paper you kept ever come back?
 *   - does the graph get better or noisier as the library grows?
 *
 * Real data, real plugin, controlled clock. One live fetch per field supplies
 * a month of papers; those are then partitioned by publication date and served
 * back a day at a time, so thirty runs cost two requests rather than sixty and
 * the sequence is reproducible. The path under test is the genuine
 * `updateInbox` — only the network is standing still.
 */

import { describe, expect, it } from "vitest";
import {
  App,
  TFile,
  resetFakeObsidian,
  setRequestResponder,
} from "./fakes/obsidian";
import LiteratureInboxPlugin from "../src/main";
import { OpenAlexClient } from "../src/core/openalex";
import type { Transport, TransportResponse } from "../src/core/http";
import { isoDaysAgo } from "../src/core/dates";
import type { Work } from "../src/core/types";

const LIVE = process.env.LIVE_SIM === "1";
const suite = LIVE ? describe : describe.skip;
const TIMEOUT = 900_000;

/** Fields chosen to be unlike each other: different citation cultures,
 * different publication rhythms, different vocabulary density. */
const FIELDS = (process.env.LIVE_FIELDS ?? [
  "trapped ion quantum computing",
  "machine translation",
  "CRISPR gene editing",
].join("|")).split("|");

const DAYS = Number(process.env.LIVE_DAYS ?? 30);

class NodeTransport implements Transport {
  async get(url: string): Promise<TransportResponse> {
    const response = await fetch(url, {
      headers: { "User-Agent": "literature-inbox-sim/0.1 (contact via GitHub)" },
    });
    return { status: response.status, text: await response.text() };
  }
}

/** Rebuild an OpenAlex page from works we already fetched, so the plugin's
 * own parsing and dedup run against realistic bytes. */
function pageFrom(works: Work[]): string {
  return JSON.stringify({
    results: works.map((work) => ({
      id: `https://openalex.org/${work.key}`,
      title: work.title,
      type: "article",
      publication_date: work.date,
      doi: work.doi ? `https://doi.org/${work.doi}` : null,
      authorships: work.authors.map((a) => ({
        author: { display_name: [a.firstName, a.lastName].filter(Boolean).join(" ") },
      })),
      referenced_works: work.references.map((r) => `https://openalex.org/${r.value}`),
      abstract_inverted_index: null,
      primary_location: { source: { display_name: work.publication ?? null } },
    })),
    meta: { next_cursor: null },
  });
}

interface DayResult {
  day: number;
  arrivals: number;
  connected: number;
  isolated: number;
  duplicates: number;
}

/** Move a note out of the inbox by hand — the keep signal, done the way a
 * user does it (drag), not via the command. */
async function keepByHand(app: App, plugin: LiteratureInboxPlugin, path: string): Promise<void> {
  const target = path.replace(/^Inbox\//, "Papers/");
  await app.fileManager.renameFile(new TFile(path) as never, target);
  void plugin;
}

function inboxNotes(app: App): string[] {
  return [...app.vault.files.keys()].filter(
    (p) => p.startsWith("Inbox/") && !p.endsWith("_Inbox.md"),
  );
}

interface FieldResult {
  field: string;
  kernel: number;
  days: DayResult[];
  keptByHand: number;
  reappeared: string[];
  duplicates: number;
  finalWhyRate: number;
}

async function simulateField(field: string): Promise<FieldResult> {
  const transport = new NodeTransport();
  // Deliberately slower and more patient than the plugin's own default: this
  // harness makes a burst of large queries back to back, which is exactly the
  // shape that earns a 429. Set LIVE_OPENALEX_KEY for a larger allowance.
  const client = new OpenAlexClient(transport, {
    minIntervalMs: 1200,
    maxRetries: 5,
    apiKey: process.env.LIVE_OPENALEX_KEY || undefined,
  });

  // Two live requests per field: the starting graph, and a month of papers.
  const kernelWorks = await client.topWorks(field, 100);
  const monthWorks = await client.worksSince(field, isoDaysAgo(DAYS), 300);

  // Partition the month by publication date, so each simulated day serves the
  // papers that genuinely appeared that day.
  const byDate = new Map<string, Work[]>();
  for (const work of monthWorks) {
    const key = work.date ?? "undated";
    const bucket = byDate.get(key);
    if (bucket) bucket.push(work);
    else byDate.set(key, [work]);
  }
  const dates = [...byDate.keys()].filter((d) => d !== "undated").sort();

  resetFakeObsidian();
  const app = new App();
  const plugin = new LiteratureInboxPlugin(app as never, {} as never);
  await plugin.onload();
  plugin.settings.openAlexTopic = field;
  plugin.settings.kernelSize = 100;
  plugin.settings.maxArrivalsPerRun = 10;
  plugin.settings.arrivalSelection = "topic"; // one query per run, easy to serve
  plugin.settings.newWindowDays = DAYS;

  // Day 0: build the starting graph from the real fetch.
  setRequestResponder(() => ({ status: 200, text: pageFrom(kernelWorks) }));
  await plugin.buildKernel();
  const kernel = [...app.vault.files.keys()].filter((p) => p.startsWith("Papers/")).length;

  const days: DayResult[] = [];
  const keptPaths: string[] = [];
  const reappeared: string[] = [];

  for (const [index, date] of dates.entries()) {
    const todays = byDate.get(date) ?? [];
    setRequestResponder(() => ({ status: 200, text: pageFrom(todays) }));

    const before = new Set(inboxNotes(app));
    await plugin.updateInbox();
    const after = inboxNotes(app);
    const fresh = after.filter((p) => !before.has(p));

    // Anything kept earlier must never come back — the regression that
    // defeated the whole keep model once before.
    for (const path of fresh) {
      const base = path.split("/").pop() as string;
      if (keptPaths.some((kept) => kept.endsWith(base))) reappeared.push(base);
    }

    let connected = 0;
    for (const path of fresh) {
      const text = app.vault.files.get(path) as string;
      if (text.includes("Why you're seeing this")) connected += 1;
    }

    days.push({
      day: index + 1,
      arrivals: fresh.length,
      connected,
      isolated: fresh.length - connected,
      duplicates: 0,
    });

    // Every third day, keep a couple of arrivals the way a user would.
    if (index % 3 === 2) {
      for (const path of after.slice(0, 2)) {
        await keepByHand(app, plugin, path);
        keptPaths.push(path.replace(/^Inbox\//, "Papers/"));
      }
    }
  }

  // Re-run the last day verbatim: a second run the same day must add nothing.
  const lastDate = dates[dates.length - 1];
  setRequestResponder(() => ({ status: 200, text: pageFrom(byDate.get(lastDate as string) ?? []) }));
  const beforeRepeat = inboxNotes(app).length;
  await plugin.updateInbox();
  const duplicates = inboxNotes(app).length - beforeRepeat;

  const finalNotes = inboxNotes(app);
  const withWhy = finalNotes.filter((p) =>
    (app.vault.files.get(p) as string).includes("Why you're seeing this"),
  ).length;

  return {
    field,
    kernel,
    days,
    keptByHand: keptPaths.length,
    reappeared,
    duplicates,
    finalWhyRate: finalNotes.length ? withWhy / finalNotes.length : 0,
  };
}

suite("a simulated month, across fields", () => {
  for (const field of FIELDS) {
    it(
      `holds up over ${DAYS} days: ${field}`,
      async () => {
        const result = await simulateField(field);
        const totalArrivals = result.days.reduce((sum, d) => sum + d.arrivals, 0);
        const totalConnected = result.days.reduce((sum, d) => sum + d.connected, 0);
        const activeDays = result.days.filter((d) => d.arrivals > 0).length;
        const { duplicates } = result;

        console.log(
          [
            ``,
            `=== ${field} ===`,
            `starting graph: ${result.kernel} papers`,
            `simulated days with arrivals: ${activeDays} of ${result.days.length}`,
            `arrivals total: ${totalArrivals}`,
            `connected to a kept paper: ${totalConnected}` +
              ` (${((totalConnected / Math.max(1, totalArrivals)) * 100).toFixed(0)}%)`,
            `kept by hand during the month: ${result.keptByHand}`,
            `kept papers that came back: ${result.reappeared.length}`,
            `duplicates on re-running the same day: ${duplicates}`,
            `why-line rate across the final inbox: ${(result.finalWhyRate * 100).toFixed(0)}%`,
          ].join("\n"),
        );

        // The keep model: a paper moved out by hand must never return.
        expect(result.reappeared).toEqual([]);
        // Re-running the same day is a no-op, not a second copy of everything.
        expect(duplicates).toBe(0);
        // And the month produced something to look at.
        expect(totalArrivals).toBeGreaterThan(0);
      },
      TIMEOUT,
    );
  }
});
