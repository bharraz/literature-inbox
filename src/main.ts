/**
 * Plugin entry point: commands, settings, and plumbing only.
 *
 * All the actual policy lives in `core/`, which imports nothing from Obsidian
 * and is unit-tested. This file's job is to wire the adapters in and put
 * results in front of the user.
 *
 * Everything here is user-initiated. There is no interval, no startup fetch,
 * and no network access on load.
 */

import { Modal, Platform, Plugin, TFile, type App } from "obsidian";
import { ArxivClient } from "./core/arxiv";
import { isoDaysAgo } from "./core/dates";
import { OpenAlexClient, OPENALEX_BASE_URL } from "./core/openalex";
import { PlanRequiredError, RateLimitError } from "./core/http";
import { backfillDois, fetchFeed, newestItem } from "./core/rss";
import {
  arxivCategoryFeedUrl,
  effective,
  looksLikeArxivCategory,
  migrateFeedList,
  withinWindow,
} from "./core/feeds";
import { titlesMatch, normalizeTitle } from "./core/ids";
import {
  EMPTY_STATE,
  STATE_PATH,
  VaultIndex,
  mergeSnapshots,
  parseVaultState,
  scanFolderIdentities,
} from "./core/vault-state";
import { parseNoteIdentity } from "./core/note-identity";
import { runUpdate, writeInboxPage, type InboxRecord, type UpdateReport } from "./core/update";
import { applyPrune, planPrune } from "./core/prune";
import {
  backfillReferences,
  hasGivenUp,
  isDueForBackfill,
  type BackfillCandidate,
} from "./core/backfill";
import {
  emptyBudget,
  gauge,
  recordRequests,
  utcDay,
  type BudgetGauge,
  type BudgetState,
} from "./core/budget";
import { CitationIndex } from "./core/citations";
import { GENERATED_END, appendCitations, type SubjectOptions } from "./core/notes";
import { contentHash } from "./core/hash";
import { runExecutable, type Spawner } from "./core/launcher";
import { runKernel } from "./core/kernel";
import { parseSeedList, seedsFromOriginIds } from "./core/seeds";
import { snowball } from "./core/snowball";
import type { Work } from "./core/types";
import {
  ObsidianTransport,
  ObsidianVaultAdapter,
  moveNote,
  notify,
  trashNote,
} from "./obsidian-adapter";
import {
  DEFAULT_SETTINGS,
  LiteratureInboxSettingTab,
  splitList,
  type LiteratureInboxSettings,
} from "./settings";

interface PersistedData {
  settings: LiteratureInboxSettings;
  inbox: InboxRecord[];
  budget?: BudgetState;
  /** DOI -> OpenAlex id for kept papers, so adjacency stops re-resolving the
   * same library on every run. The mapping never changes. */
  openAlexIdByDoi?: Record<string, string>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * How many existing papers are used as seeds when expanding from the vault's
 * own library. A large library would otherwise issue an enormous expansion,
 * and once the core is dense the marginal seed adds almost nothing.
 */
const LIBRARY_SEED_LIMIT = 50;

/**
 * How many kept papers anchor an adjacency query. Higher than the snowball
 * limit because coverage matters more here — a paper citing *any* of your
 * library is a hit — and the cost is one request per 25 anchors.
 */
const ADJACENCY_ANCHOR_LIMIT = 100;

/** Shown in a note whose references were looked for and never found. */
const UNINDEXED_NOTICE =
  "> **No citation links found.** OpenAlex has not indexed this paper's " +
  "references, so it can't be wired into your graph yet. Checked three times " +
  "over about a month; it won't be checked again.";

/**
 * Turn a fetch failure into something the user can act on.
 *
 * A rate limit is the one failure with an actual remedy — OpenAlex runs a
 * faster "polite pool" for anyone who supplies an email — so say so, rather
 * than showing a raw HTTP 429 and a URL nobody can do anything with.
 */
function describeFetchError(error: unknown, fetched: number, mailto: string): string {
  const gathered = fetched > 0 ? ` Kept the ${fetched} already fetched.` : "";
  if (error instanceof PlanRequiredError) {
    return `OpenAlex needs a paid plan for that query, so it was skipped.${gathered}`;
  }
  if (error instanceof RateLimitError) {
    const hours = error.retryAfterMs ? Math.round(error.retryAfterMs / 3_600_000) : 0;
    if (hours >= 1) {
      // OpenAlex's free tier is a daily spend allowance, not a rate limit.
      return (
        `OpenAlex's free daily budget is used up — it resets at midnight UTC, in about ` +
        `${hours} hour(s).${gathered} Smaller starting graphs and fewer runs per day ` +
        `stretch it further.`
      );
    }
    const advice = mailto.trim()
      ? "Wait a minute and run it again."
      : "Adding your email under Network and integrations puts you in OpenAlex's " +
        "faster pool and makes this far less likely.";
    return `OpenAlex asked us to slow down.${gathered} ${advice}`;
  }
  return `OpenAlex fetch failed: ${String(error)}.${gathered}`;
}

export default class LiteratureInboxPlugin extends Plugin {
  override settings: LiteratureInboxSettings = { ...DEFAULT_SETTINGS };
  private inbox: InboxRecord[] = [];
  private budget: BudgetState = emptyBudget(utcDay());
  private openAlexIdByDoi: Record<string, string> = {};
  private running = false;
  /** The OpenAlex client for the run in progress, if any — see openAlex(). */
  private runClient?: OpenAlexClient;
  /** Papers in the kept folder, refreshed on load and after a kernel run —
   * shown in settings so the plugin's state is legible at a glance. */
  private keptCount = 0;

  override async onload(): Promise<void> {
    await this.loadPersisted();
    // Cheap, local, and no network: just counts what's on disk.
    await this.refreshKeptCount();
    this.addSettingTab(new LiteratureInboxSettingTab(this.app, this));

    // One-click access to the action people run most; everything else lives
    // in the command palette rather than cluttering the ribbon.
    this.addRibbonIcon("library", "Update literature inbox", () => void this.updateInbox());

    this.addCommand({
      id: "update-inbox",
      name: "Update inbox",
      callback: () => void this.updateInbox(),
    });
    this.addCommand({
      id: "build-kernel",
      name: "Add papers to your graph",
      callback: () => void this.buildKernel(),
    });
    this.addCommand({
      id: "keep-paper",
      name: "Keep this paper (move out of the inbox)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const eligible =
          file instanceof TFile && file.path.startsWith(`${this.settings.inboxFolder}/`);
        if (!checking && eligible) void this.keepActiveNote(file);
        return eligible;
      },
    });
    this.addCommand({
      id: "add-by-doi",
      name: "Add a paper by DOI or arXiv id",
      callback: () => new AddByIdModal(this.app, (value) => void this.addById(value)).open(),
    });
    this.addCommand({
      id: "copy-identifier",
      name: "Copy this paper's identifier",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile)) return false;
        if (!checking) void this.copyIdentifier(file);
        return true;
      },
    });
    this.addCommand({
      id: "clean-up-inbox",
      name: "Clean up old arrivals (preview first)",
      callback: () => void this.cleanUp(),
    });
    this.addCommand({
      id: "run-zot2vault",
      name: "Rebuild Zotero notes (runs zot2vault)",
      checkCallback: (checking) => {
        // Desktop only: launching a program needs child_process, which does
        // not exist on mobile. Hidden entirely there rather than failing.
        if (!Platform.isDesktop) return false;
        if (!checking) void this.runZot2vault();
        return true;
      },
    });
  }

  /**
   * Run the user's own zot2vault executable.
   *
   * The plugin never ships or downloads a binary — this runs exactly the path
   * typed into settings, with no shell, and only on desktop. `child_process`
   * is imported lazily so the module is never even touched on mobile.
   */
  async runZot2vault(spawner?: Spawner): Promise<void> {
    if (!Platform.isDesktop) {
      notify("Running zot2vault is only possible on desktop.");
      return;
    }
    const path = this.settings.zot2vaultPath.trim();
    if (!path) {
      notify("Set the path to your zot2vault program in Literature Inbox settings first.");
      return;
    }

    let spawn = spawner;
    if (!spawn) {
      try {
        const childProcess = await import("node:child_process");
        spawn = (command, args) =>
          childProcess.spawn(command, args, { shell: false }) as ReturnType<Spawner>;
      } catch (error) {
        notify(`Could not access the system's process API: ${String(error)}`);
        return;
      }
    }

    notify("Running zot2vault…");
    const result = await runExecutable(path, [], spawn);
    notify(result.message);
  }

  // --- persistence ---------------------------------------------------------

  private async loadPersisted(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    // Feeds used to be one newline-separated string. Convert once, then drop
    // the old key — silently losing someone's feeds on upgrade would be a
    // poor welcome.
    this.settings.feeds = migrateFeedList(this.settings.rssFeeds, this.settings.feeds);
    delete this.settings.rssFeeds;
    this.inbox = Array.isArray(data?.inbox) ? (data?.inbox as InboxRecord[]) : [];
    this.budget = data?.budget ?? emptyBudget(utcDay());
    this.openAlexIdByDoi = data?.openAlexIdByDoi ?? {};
  }

  private async persist(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      inbox: this.inbox,
      budget: this.budget,
      openAlexIdByDoi: this.openAlexIdByDoi,
    } satisfies PersistedData);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  // --- shared helpers ------------------------------------------------------

  private transport() {
    // Every request the plugin makes passes through here, which makes it the
    // only honest place to count them against OpenAlex's daily allowance.
    const inner = new ObsidianTransport();
    return {
      get: async (url: string) => {
        if (url.startsWith(OPENALEX_BASE_URL)) {
          this.budget = recordRequests(this.budget, 1);
        }
        return inner.get(url);
      },
    };
  }

  /** What to draw in the settings gauge. */
  budgetGauge(): BudgetGauge {
    return gauge(this.budget, utcDay());
  }

  /**
   * An OpenAlex client. Pass `onPartial` for long fetches where returning what
   * was gathered beats losing the run — the caller then owns telling the user
   * that the result is incomplete.
   */
  private openAlex(onPartial?: (error: unknown, fetched: number) => void): OpenAlexClient {
    // Reuse the run's client when there is one. A fresh client means a fresh
    // RateLimiter, and a limiter that only paces the calls made through one
    // short-lived instance paces nothing at all — which is how a single update
    // managed to burst past OpenAlex's ceiling and earn a 429.
    if (this.runClient) return this.runClient;
    return new OpenAlexClient(this.transport(), {
      mailto: this.settings.mailto || undefined,
      onPartialFetch: onPartial,
    });
  }

  /**
   * Run one body of work against a single OpenAlex client, so every request it
   * makes shares one rate limiter and one "we have been told to back off"
   * latch.
   */
  private async withSharedClient<T>(
    onPartial: (error: unknown, fetched: number) => void,
    body: () => Promise<T>,
  ): Promise<T> {
    this.runClient = new OpenAlexClient(this.transport(), {
      mailto: this.settings.mailto || undefined,
      onPartialFetch: onPartial,
    });
    try {
      return await body();
    } finally {
      this.runClient = undefined;
    }
  }

  private adapter(): ObsidianVaultAdapter {
    return new ObsidianVaultAdapter(this.app.vault);
  }

  /**
   * What the vault already contains, from two independent sources:
   *
   *  1. zot2vault's manifest, if present — absent is completely normal, since
   *     a vault that has only ever used this plugin has no such file;
   *  2. the papers folder itself, read note by note.
   *
   * (2) is not an optimisation, it's what makes keeping work at all: moving a
   * note out of the inbox is the keep signal, and without scanning the folder
   * the next update would find no record of that paper and fetch it straight
   * back in.
   */
  private async vaultIndex(): Promise<VaultIndex> {
    const adapter = this.adapter();
    const raw = await adapter.read(STATE_PATH);
    const state = raw === undefined ? EMPTY_STATE : parseVaultState(raw);
    const scanned = await scanFolderIdentities(
      this.settings.papersFolder,
      (folder) => adapter.list(folder),
      (path) => adapter.read(path),
      parseNoteIdentity,
    );
    return new VaultIndex(mergeSnapshots(state, scanned), normalizeTitle);
  }

  private updateSettings() {
    return {
      inboxFolder: this.settings.inboxFolder,
      papersFolder: this.settings.papersFolder,
      maxArrivalsPerRun: this.settings.maxArrivalsPerRun,
      subjects: this.subjectOptions(),
      inboxPageEnabled: this.settings.inboxPageEnabled,
    };
  }

  private subjectOptions(): SubjectOptions {
    return {
      placement: this.settings.subjectPlacement,
      topics: this.settings.subjectTopics,
      keywords: this.settings.subjectKeywords,
      concepts: this.settings.subjectConcepts,
    };
  }

  // --- fetching ------------------------------------------------------------

  /**
   * OpenAlex ids for the papers the user keeps, to anchor an adjacency query.
   *
   * `cites:` only accepts OpenAlex ids, so notes carrying only a DOI would
   * otherwise be unable to anchor anything — which would silently exclude an
   * entire zot2vault library. One batched DOI lookup converts them, and is
   * worth the request.
   */
  private async adjacencyAnchors(vault: VaultIndex): Promise<string[]> {
    const { openAlexIds, dois } = seedsFromOriginIds(
      [...vault.entriesForIndex()].map((entry) => entry.originIds),
      ADJACENCY_ANCHOR_LIMIT,
    );
    const anchors = [...openAlexIds];

    // A DOI's OpenAlex id never changes, so resolving the same library note
    // on every single run is pure waste. Cache the mapping and only ask about
    // DOIs we have not seen before.
    const unknown: string[] = [];
    for (const doi of dois) {
      const cached = this.openAlexIdByDoi[doi];
      if (cached) {
        if (!anchors.includes(cached)) anchors.push(cached);
      } else {
        unknown.push(doi);
      }
    }

    if (unknown.length > 0) {
      let learned = false;
      for (const work of await this.openAlex().worksByDois(unknown)) {
        const doi = work.doi;
        for (const id of work.ids) {
          if (id.namespace !== "openalex") continue;
          if (!anchors.includes(id.value)) anchors.push(id.value);
          if (doi && this.openAlexIdByDoi[doi] !== id.value) {
            this.openAlexIdByDoi[doi] = id.value;
            learned = true;
          }
        }
      }
      if (learned) await this.persist();
    }
    return anchors;
  }

  private async fetchAll(report: UpdateReport, vault: VaultIndex): Promise<Work[]> {
    const works: Work[] = [];
    const perSource = this.settings.maxArrivalsPerRun;
    // The user's window back from today, never `topWorks` and never "since you
    // last ran". `topWorks` returns the most-cited papers on the topic —
    // exactly what a kernel run just seeded — so using it here reported
    // "0 new" on every first update, guaranteed. And anchoring on `lastUpdate`
    // narrows the window to nothing on a second run the same day. The window
    // overlaps previous runs on purpose: dedup is exact and cheap, so
    // re-seeing a paper costs nothing and missing one is permanent.
    const since = isoDaysAgo(this.settings.newWindowDays);
    const selection = this.settings.arrivalSelection;

    // Adjacency first, deliberately. When the per-run cap bites, whatever is
    // at the front of this list survives — and a paper that cites your library
    // is a better arrival than one that merely matches your topic string.
    if (this.settings.openAlexEnabled && selection !== "topic") {
      try {
        const anchors = await this.adjacencyAnchors(vault);
        if (anchors.length === 0) {
          report.sourceErrors.push({
            source: "Papers citing your library",
            message:
              `no papers in ${this.settings.papersFolder}/ have an identifier to match ` +
              "against — build a starting graph first",
          });
        } else {
          works.push(...(await this.openAlex().worksCitingSince(anchors, since, perSource)));
        }
      } catch (error) {
        report.sourceErrors.push({
          source: "Papers citing your library",
          message: String(error),
        });
      }
    }

    if (
      this.settings.openAlexEnabled &&
      selection !== "adjacent" &&
      this.settings.openAlexTopic.trim()
    ) {
      try {
        works.push(
          ...(await this.openAlex().worksSince(this.settings.openAlexTopic, since, perSource)),
        );
      } catch (error) {
        report.sourceErrors.push({ source: "OpenAlex topic", message: String(error) });
      }
    }

    // arXiv categories and hand-entered feeds are the same mechanism: a
    // category is just a feed URL the user should not have to know.
    const feedSources: { label: string; url: string; windowDays?: number; cap?: number }[] = [];
    if (this.settings.arxivEnabled) {
      for (const category of splitList(this.settings.arxivCategories)) {
        feedSources.push({ label: `arXiv ${category}`, url: arxivCategoryFeedUrl(category) });
      }
    }
    if (this.settings.rssEnabled) {
      for (const feed of this.settings.feeds) {
        if (!feed.enabled || !feed.url.trim()) continue;
        feedSources.push({
          label: feed.url,
          url: feed.url,
          windowDays: feed.windowDays,
          cap: feed.maxPerRun,
        });
      }
    }

    if (feedSources.length > 0) {
      const feedWorks: Work[] = [];
      for (const source of feedSources) {
        try {
          const items = await fetchFeed(this.transport(), source.url);
          const feedSince = isoDaysAgo(effective(source.windowDays, this.settings.newWindowDays));
          const cap = effective(source.cap, perSource);
          feedWorks.push(...withinWindow(items, feedSince).slice(0, cap));
        } catch (error) {
          report.sourceErrors.push({ source: source.label, message: String(error) });
        }
      }
      // Give feed items a DOI (and a reference list) where we can, so they
      // arrive wired into the graph instead of as isolated dots.
      if (feedWorks.length > 0) {
        try {
          await backfillDois(feedWorks, this.openAlex(), titlesMatch);
        } catch {
          // Backfill is a bonus; shallow arrivals are still arrivals.
        }
      }
      works.push(...feedWorks);
    }
    return works;
  }

  /**
   * Re-ask OpenAlex for references belonging to inbox notes that still have
   * no citation edges, and rewrite those notes if any turn up.
   *
   * Only untouched notes are rewritten: once the user has written on a note,
   * regenerating it would destroy their work, and a missing edge is a far
   * smaller loss. Returns how many notes gained edges.
   */
  private async backfillEdgelessArrivals(): Promise<number> {
    const adapter = this.adapter();
    const candidates: BackfillCandidate[] = [];

    const today = todayIso();
    const due: InboxRecord[] = [];
    for (const record of this.inbox) {
      const content = await adapter.read(record.notePath);
      if (content === undefined) continue;
      if (contentHash(content) !== record.contentHash) continue; // user edited it
      const hasEdges = content.includes("## Citations");
      // Only ask about notes that are actually due. Without this, every
      // isolated arrival was re-queried on every run forever — around 25
      // requests per update against a daily allowance of roughly 100.
      if (!hasEdges && !isDueForBackfill(record, record.arrivedOn, today)) continue;
      if (!hasEdges) due.push(record);
      candidates.push({
        notePath: record.notePath,
        originIds: record.originIds,
        title: record.title,
        hasEdges,
      });
    }
    if (candidates.length === 0) return 0;

    let outcomes;
    try {
      outcomes = await backfillReferences(candidates, this.openAlex(), titlesMatch);
    } catch {
      return 0; // backfill is an improvement on what's there, never a blocker
    }

    // Spend an attempt on everything we asked about, whether or not it
    // resolved — that is what makes the schedule widen rather than repeat.
    const resolvedPaths = new Set(outcomes.map((outcome) => outcome.notePath));
    for (const record of due) {
      record.backfillAttempts = (record.backfillAttempts ?? 0) + 1;
      record.lastBackfillOn = today;
      if (!resolvedPaths.has(record.notePath) && hasGivenUp(record)) {
        await this.markUnindexed(record);
      }
    }
    if (outcomes.length === 0) {
      await this.persist();
      return 0;
    }

    // Resolve the new references against everything the vault knows, so the
    // edges point at real notes rather than dangling.
    const index = new CitationIndex();
    const vault = await this.vaultIndex();
    for (const entry of vault.entriesForIndex()) {
      const base = entry.notePath.split("/").pop();
      if (base?.endsWith(".md")) index.add(entry.originIds, base.slice(0, -3));
    }
    for (const record of this.inbox) {
      const base = record.notePath.split("/").pop();
      if (base?.endsWith(".md")) index.add(record.originIds, base.slice(0, -3));
    }

    let connected = 0;
    for (const outcome of outcomes) {
      const record = this.inbox.find((r) => r.notePath === outcome.notePath);
      if (!record) continue;
      const cites = outcome.references
        .map((reference) => index.lookup(reference))
        .filter((name): name is string => Boolean(name));
      if (cites.length === 0) continue;

      const content = await adapter.read(outcome.notePath);
      if (content === undefined || contentHash(content) !== record.contentHash) continue;

      const updated = appendCitations(content, cites);
      await adapter.write(outcome.notePath, updated);
      record.contentHash = contentHash(updated);
      record.originIds = [...record.originIds, ...outcome.newIds];
      connected += 1;
    }

    if (connected > 0) await this.persist();
    return connected;
  }

  /** Re-read the papers folder. Cheap, local, and no network. */
  private async refreshKeptCount(): Promise<void> {
    this.keptCount = (await this.adapter().list(this.settings.papersFolder)).length;
  }

  /**
   * Say on the note itself that we looked and found nothing.
   *
   * A paper OpenAlex never indexed would otherwise sit as an unexplained
   * isolated dot forever, indistinguishable from one we simply hadn't got to.
   */
  private async markUnindexed(record: InboxRecord): Promise<void> {
    const adapter = this.adapter();
    const content = await adapter.read(record.notePath);
    if (content === undefined) return;
    if (contentHash(content) !== record.contentHash) return; // user edited it
    if (content.includes(UNINDEXED_NOTICE)) return;

    const marker = content.indexOf(GENERATED_END);
    if (marker === -1) return;
    const updated = `${content.slice(0, marker)}${UNINDEXED_NOTICE}

${content.slice(marker)}`;
    await adapter.write(record.notePath, updated);
    record.contentHash = contentHash(updated);
  }

  /** Counts shown at the top of the settings page, so the plugin's state is
   * legible without hunting through folders. */
  status(): { keptCount: number; inboxCount: number; lastUpdate?: string } {
    return {
      keptCount: this.keptCount,
      inboxCount: this.inbox.length,
      lastUpdate: this.settings.lastUpdate,
    };
  }

  // --- commands ------------------------------------------------------------

  /**
   * Seed the papers folder with the most-cited papers on the user's topic.
   *
   * This is the answer to "I installed it and my graph is empty". Without a
   * core for arrivals to attach to, every new paper looks equally unfamiliar
   * and the whole triage-by-looking premise is invisible.
   */
  /**
   * Resolve a pasted list of identifiers into works.
   *
   * DOIs go in one batched request; arXiv ids go one at a time, because the
   * arXiv API has no batch form and asks for a 3s gap. Anything that didn't
   * resolve comes back so the caller can say which — a paper silently absent
   * from your starting graph is worse than a slightly noisier notice.
   */
  private async resolveSeeds(raw: string): Promise<{
    works: Work[];
    missing: string[];
    unrecognised: string[];
  }> {
    const list = parseSeedList(raw);
    const works: Work[] = [];
    const missing: string[] = [];

    if (list.dois.length > 0) {
      const found = await this.openAlex().worksByDois(list.dois);
      works.push(...found);
      const resolved = new Set(
        found.map((work) => work.doi).filter((doi): doi is string => Boolean(doi)),
      );
      for (const doi of list.dois) if (!resolved.has(doi)) missing.push(doi);
    }

    if (list.arxivIds.length > 0) {
      const client = new ArxivClient(this.transport());
      for (const id of list.arxivIds) {
        const work = await client.workById(id);
        if (work) works.push(work);
        else missing.push(id);
      }
    }

    return { works, missing, unrecognised: list.unrecognised };
  }

  /** The papers already in the vault, as seeds to expand from. */
  private async librarySeeds(limit: number): Promise<Work[]> {
    const vault = await this.vaultIndex();
    const { openAlexIds, dois } = seedsFromOriginIds(
      [...vault.entriesForIndex()].map((entry) => entry.originIds),
      limit,
    );
    if (openAlexIds.length === 0 && dois.length === 0) return [];

    const client = this.openAlex();
    const works: Work[] = [];
    // Re-fetched rather than read off disk: the notes carry identity but not
    // reference lists, and references are the entire point of a snowball.
    if (openAlexIds.length > 0) works.push(...(await client.worksByIds(openAlexIds)));
    if (dois.length > 0) works.push(...(await client.worksByDois(dois)));
    return works;
  }

  /**
   * Fetch the works for whichever starting-graph mode is selected.
   *
   * Returns undefined when the mode's input is missing — the caller has
   * already told the user what to fill in, and there is nothing to write.
   */
  private async gatherKernelWorks(): Promise<Work[] | undefined> {
    const size = this.settings.kernelSize;
    const mode = this.settings.kernelMode;

    if (mode === "topic") {
      const topic = this.settings.openAlexTopic.trim();
      if (!topic) {
        notify("Set a topic in Literature Inbox settings first.");
        return undefined;
      }
      notify(`Fetching the ${size} most-cited papers on "${topic}"… this can take a minute.`);
      return this.openAlex().topWorks(topic, size);
    }

    if (mode === "author") {
      const author = this.settings.kernelAuthor.trim();
      if (!author) {
        notify("Enter an author id, ORCID, or name first.");
        return undefined;
      }
      notify(`Fetching up to ${size} papers by ${author}…`);
      return this.openAlex().worksByAuthor(author, size);
    }

    if (mode === "seeds" || mode === "snowball") {
      if (!this.settings.kernelSeeds.trim()) {
        notify("Paste some DOIs or arXiv ids first.");
        return undefined;
      }
      notify("Looking up the papers you listed…");
      const { works, missing, unrecognised } = await this.resolveSeeds(this.settings.kernelSeeds);
      this.reportSeedProblems(missing, unrecognised);
      if (works.length === 0) {
        notify("None of those identifiers resolved to a paper.");
        return undefined;
      }
      if (mode === "seeds") return works;
      return this.expand(works, size);
    }

    // library
    notify("Reading the papers you already have…");
    const seeds = await this.librarySeeds(LIBRARY_SEED_LIMIT);
    if (seeds.length === 0) {
      notify(
        `No papers with a usable identifier in ${this.settings.papersFolder}/ — ` +
          "build a graph another way first.",
      );
      return undefined;
    }
    return this.expand(seeds, size);
  }

  /** Seeds plus their references and citers. */
  private async expand(seeds: Work[], size: number): Promise<Work[]> {
    notify(`Expanding ${seeds.length} paper(s) outward… this can take a minute.`);
    const client = this.openAlex();
    const report = await snowball({
      seeds,
      resolver: {
        worksByIds: (ids) => client.worksByIds(ids),
        worksCiting: (ids, limit) => client.worksCiting(ids, limit),
      },
      limit: size,
      // One notice per phase, so a minute-long expansion doesn't read as a
      // hang. The totals are repeated in the summary, not announced twice.
      onProgress: (phase, found) =>
        notify(
          phase === "references"
            ? `Found ${found} cited paper(s), now looking for citing papers…`
            : `Found ${found} citing paper(s).`,
        ),
    });
    for (const error of report.errors) notify(`Part of the expansion failed — ${error}`);
    return report.works;
  }

  private reportSeedProblems(missing: string[], unrecognised: string[]): void {
    if (unrecognised.length > 0) {
      notify(`Not an identifier, skipped: ${unrecognised.slice(0, 5).join(", ")}`);
    }
    if (missing.length > 0) {
      notify(`Not found in OpenAlex or arXiv: ${missing.slice(0, 5).join(", ")}`);
    }
  }

  async buildKernel(): Promise<void> {
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }

    this.running = true;
    const problems: string[] = [];
    try {
      const works = await this.withSharedClient(
        (error, fetched) => problems.push(describeFetchError(error, fetched, this.settings.mailto)),
        () => this.gatherKernelWorks(),
      );
      for (const problem of problems) notify(problem);
      if (works === undefined) return;
      if (works.length === 0) {
        notify("No papers found. Try a broader query, or a different starting point.");
        return;
      }

      const report = await runKernel({
        works,
        vault: await this.vaultIndex(),
        papersFolder: this.settings.papersFolder,
        adapter: this.adapter(),
        today: todayIso(),
        subjects: this.subjectOptions(),
        onProgress: (written, total) => {
          // Every 25, not every note: a Notice per paper would bury the
          // screen, and silence for a minute reads as a hang.
          if (written % 25 === 0 && written < total) notify(`Writing ${written} of ${total}…`);
        },
      });

      this.keptCount += report.written.length;
      const parts = [`${report.written.length} papers added to ${this.settings.papersFolder}/`];
      if (report.totalEdges) parts.push(`${report.totalEdges} citation links between them`);
      if (report.skipped) parts.push(`${report.skipped} you already had`);
      notify(`Added to your graph: ${parts.join(", ")}.`);
    } catch (error) {
      notify(`Could not add papers: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async updateInbox(): Promise<void> {
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }
    if (
      !this.settings.openAlexEnabled &&
      !this.settings.arxivEnabled &&
      !this.settings.rssEnabled
    ) {
      notify("No sources are enabled — turn one on in Literature Inbox settings.");
      return;
    }

    this.running = true;
    notify("Literature Inbox: fetching…");
    try {
      // One scan of the vault, shared: adjacency selection needs to know what
      // you keep, and so does the dedup pass.
      const vault = await this.vaultIndex();
      const preliminary: UpdateReport = { arrived: [], skipped: [], sourceErrors: [] };
      const fetched = await this.withSharedClient(
        (error, fetched) =>
          preliminary.sourceErrors.push({
            source: "OpenAlex",
            message: describeFetchError(error, fetched, this.settings.mailto),
          }),
        () => this.fetchAll(preliminary, vault),
      );

      const { report, inbox } = await runUpdate({
        fetched,
        vault,
        inbox: this.inbox,
        settings: this.updateSettings(),
        adapter: this.adapter(),
        today: todayIso(),
      });
      report.sourceErrors.push(...preliminary.sourceErrors);

      this.inbox = inbox;
      this.settings.lastUpdate = todayIso();
      await this.persist();

      // arXiv and RSS arrivals land edge-less; OpenAlex usually indexes them
      // within days, so ask again for the ones still isolated.
      const backfilled = await this.backfillEdgelessArrivals();

      const parts = [`${report.arrived.length} new`];
      if (report.skipped.length) parts.push(`${report.skipped.length} already known`);
      if (backfilled) parts.push(`${backfilled} newly connected`);
      if (report.cappedAt) parts.push(`capped at ${report.cappedAt}`);
      if (report.sourceErrors.length) parts.push(`${report.sourceErrors.length} source error(s)`);
      notify(`Literature Inbox: ${parts.join(", ")}.`);

      // A notice can't say *which* papers arrived or how connected they are,
      // and that is the whole triage question. Shown only when there is
      // something to look at or something went wrong — a quiet successful run
      // should stay quiet.
      if (report.arrived.length > 0 || report.sourceErrors.length > 0) {
        new RunReportModal(this.app, report, backfilled).open();
      }
    } catch (error) {
      notify(`Literature Inbox failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Keeping is a file move — the same thing dragging it in the file explorer
   * does. The command exists for convenience, never as the only way. */
  async keepActiveNote(file: TFile): Promise<void> {
    const target = `${this.settings.papersFolder}/${file.name}`;
    const moved = await moveNote(this.app, file.path, target);
    if (!moved) {
      notify("Could not move that note.");
      return;
    }
    this.inbox = this.inbox.filter((record) => record.notePath !== file.path);
    await this.persist();
    await writeInboxPage(this.inbox, this.updateSettings(), this.adapter());
    // Recount rather than increment: papers also arrive in this folder by
    // being dragged there, by zot2vault, or by a kernel run, so a counter
    // nudged only on this path drifts out of step with the folder.
    await this.refreshKeptCount();
    notify(`Kept — moved to ${this.settings.papersFolder}/.`);
  }

  /**
   * Add one or many papers by identifier.
   *
   * Identifier classification goes through `parseSeedList` rather than a
   * `startsWith("10.")` check, which used to send a pasted
   * `https://doi.org/10.…` URL — the thing you actually copy from a browser —
   * to the arXiv client, where it always failed.
   *
   * `target` matters: papers added to build up a library belong in the papers
   * folder, not the inbox. Sending them to the inbox would mean triaging
   * papers you already decided you wanted.
   */
  async addByIds(raw: string, target: "inbox" | "papers" = "inbox"): Promise<void> {
    if (!raw.trim()) {
      notify("Enter a DOI or arXiv id first.");
      return;
    }
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }

    this.running = true;
    try {
      const { works, missing, unrecognised } = await this.resolveSeeds(raw);
      this.reportSeedProblems(missing, unrecognised);
      if (works.length === 0) {
        if (missing.length === 0 && unrecognised.length === 0) notify("Nothing found.");
        return;
      }

      if (target === "papers") {
        const report = await runKernel({
          works,
          vault: await this.vaultIndex(),
          papersFolder: this.settings.papersFolder,
          adapter: this.adapter(),
          today: todayIso(),
        });
        this.keptCount += report.written.length;
        notify(
          `Added ${report.written.length} paper(s) to ${this.settings.papersFolder}/` +
            (report.skipped ? `, ${report.skipped} you already had.` : "."),
        );
        return;
      }

      const { report, inbox } = await runUpdate({
        fetched: works,
        vault: await this.vaultIndex(),
        inbox: this.inbox,
        settings: this.updateSettings(),
        adapter: this.adapter(),
        today: todayIso(),
      });

      // For a single add, "you already have this" is the useful answer and
      // opening the note is the useful action. For a list it would be noise.
      if (works.length === 1 && report.skipped.length > 0) {
        const existing = report.skipped[0]?.existingPath;
        notify(`Already in your vault: ${existing ?? "an existing note"}.`);
        if (existing) {
          const file = this.app.vault.getAbstractFileByPath(existing);
          if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
        }
        return;
      }

      // A manual add is deliberate, so it is exempt from automatic cleanup.
      this.inbox = inbox.map((record) =>
        report.arrived.some((arrival) => arrival.notePath === record.notePath)
          ? { ...record, manual: true }
          : record,
      );
      await this.persist();
      const skipped = report.skipped.length ? `, ${report.skipped.length} already known` : "";
      notify(`Added ${report.arrived.length} paper(s) to ${this.settings.inboxFolder}/${skipped}.`);
    } catch (error) {
      notify(`Could not add: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** The single-paper command form. */
  async addById(rawValue: string): Promise<void> {
    await this.addByIds(rawValue, "inbox");
  }

  async copyIdentifier(file: TFile): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter ?? {};
    const identifier =
      (frontmatter.doi as string | undefined) ??
      (frontmatter.url as string | undefined) ??
      (Array.isArray(frontmatter["origin-ids"])
        ? (frontmatter["origin-ids"][0] as string)
        : undefined);
    if (!identifier) {
      notify("No identifier recorded on this note.");
      return;
    }
    await navigator.clipboard.writeText(identifier);
    notify(`Copied ${identifier} — paste it into Zotero's "Add by identifier".`);
  }

  async cleanUp(): Promise<void> {
    if (!this.settings.pruneEnabled) {
      notify(
        "Cleanup is locked. Unlock it in Literature Inbox settings — nothing is ever " +
          "removed automatically, and you will still be shown the list and asked.",
      );
      return;
    }
    const plan = await planPrune(
      this.inbox,
      this.adapter(),
      this.settings.inboxFolder,
      this.settings.keepWindowDays,
      todayIso(),
    );

    // Records for notes that were kept (moved out) or deleted by hand are
    // dropped from state regardless — tracking them further would be wrong.
    if (plan.forget.length > 0) {
      this.inbox = [...plan.retained, ...plan.prunable].map((c) => c.record);
      await this.persist();
    }

    if (plan.prunable.length === 0) {
      notify("Nothing to clean up — every arrival is recent, edited, or already kept.");
      return;
    }

    new ConfirmPruneModal(this.app, plan.prunable.map((c) => c.record), async () => {
      this.inbox = await applyPrune(plan, (path) => trashNote(this.app, path));
      await this.persist();
      await writeInboxPage(this.inbox, this.updateSettings(), this.adapter());
      notify(`Moved ${plan.prunable.length} untouched arrival(s) to trash.`);
    }).open();
  }

  /**
   * Fetch each configured feed once and report what came back.
   *
   * A feed that is dead, mistyped, or not actually a feed is otherwise
   * indistinguishable from a feed that simply has nothing new — you find out
   * three empty updates later, if at all. Checking at the point of entry is
   * the whole value. Deliberately ignores the RSS toggle: testing a feed
   * before switching the source on is the normal order.
   */
  async testFeeds(onlyUrl?: string): Promise<void> {
    const urls = (onlyUrl ? [onlyUrl] : this.settings.feeds.map((feed) => feed.url))
      .map((url) => url.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      notify("Add at least one feed URL first.");
      return;
    }

    notify(`Testing ${urls.length} feed(s)…`);
    const results: FeedTestResult[] = [];
    for (const url of urls) {
      try {
        // No retries here, unlike a real update: this is a diagnostic, and a
        // user waiting on a button wants the answer now. Backing off three
        // times over a dead URL would sit silent for the better part of a
        // minute across a few feeds.
        const works = await fetchFeed(this.transport(), url, { maxRetries: 0 });
        const newest = newestItem(works);
        results.push({
          url,
          count: works.length,
          newestTitle: newest?.title,
          newestDate: newest?.date,
        });
      } catch (error) {
        results.push({ url, count: 0, error: String(error) });
      }
    }
    new FeedTestModal(this.app, results).open();
  }

  /**
   * Fetch each arXiv category once and report what came back.
   *
   * A misspelled category is not an error at arXiv's end — `quant-ph` works,
   * `quantph` simply returns an empty feed. Without a check that is
   * indistinguishable from a quiet week.
   */
  async testArxivCategories(): Promise<void> {
    const categories = splitList(this.settings.arxivCategories);
    if (categories.length === 0) {
      notify("Enter at least one arXiv category first, e.g. quant-ph.");
      return;
    }

    notify(`Testing ${categories.length} categor(y/ies)…`);
    const results: FeedTestResult[] = [];
    for (const category of categories) {
      if (!looksLikeArxivCategory(category)) {
        results.push({ url: category, count: 0, error: "not an arXiv category name" });
        continue;
      }
      try {
        // Tested through the same path an update uses, so a green test means
        // the update will work — not that some other endpoint answered.
        const works = await fetchFeed(this.transport(), arxivCategoryFeedUrl(category), {
          maxRetries: 0,
        });
        const newest = newestItem(works);
        results.push({
          url: category,
          count: works.length,
          newestTitle: newest?.title,
          newestDate: newest?.date,
        });
      } catch (error) {
        results.push({ url: category, count: 0, error: String(error) });
      }
    }
    new FeedTestModal(this.app, results).open();
  }

  async previewTopic(): Promise<void> {
    const topic = this.settings.openAlexTopic.trim();
    if (!topic) {
      notify("Enter an OpenAlex topic first.");
      return;
    }
    try {
      const works = await this.openAlex().topWorks(topic, 10);
      new PreviewModal(this.app, topic, works).open();
    } catch (error) {
      notify(`Preview failed: ${String(error)}`);
    }
  }
}

/**
 * What a run actually did, in a form you can read.
 *
 * Arrivals are listed most-connected first, because that is the order you want
 * to triage in — a paper wired to five of your papers deserves attention
 * before one wired to none.
 */
class RunReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: UpdateReport,
    private readonly backfilled: number,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Update report");
    const { report } = this;

    if (report.arrived.length === 0) {
      this.contentEl.createEl("p", {
        text:
          report.skipped.length > 0
            ? `Nothing new — all ${report.skipped.length} paper(s) found are already in your vault.`
            : "Nothing new this run.",
      });
    } else {
      this.contentEl.createEl("p", {
        text: `${report.arrived.length} new paper(s), most connected first.`,
      });
      const list = this.contentEl.createEl("ol");
      const sorted = [...report.arrived].sort((a, b) => b.edgeCount - a.edgeCount);
      for (const arrival of sorted.slice(0, 50)) {
        const noun = arrival.edgeCount === 1 ? "link" : "links";
        list.createEl("li", {
          text:
            arrival.edgeCount > 0
              ? `${arrival.title} — ${arrival.edgeCount} ${noun} into your library`
              : `${arrival.title} — no links yet`,
        });
      }
      if (sorted.length > 50) {
        this.contentEl.createEl("p", { text: `…and ${sorted.length - 50} more.` });
      }
    }

    const notes: string[] = [];
    if (report.skipped.length > 0 && report.arrived.length > 0) {
      notes.push(`${report.skipped.length} already in your vault, skipped.`);
    }
    if (this.backfilled > 0) {
      notes.push(`${this.backfilled} earlier arrival(s) gained citation links.`);
    }
    if (report.cappedAt) {
      notes.push(`Capped at ${report.cappedAt} — raise "maximum arrivals per run" for more.`);
    }
    for (const note of notes) {
      this.contentEl.createEl("p", { cls: "setting-item-description", text: note });
    }

    if (report.sourceErrors.length > 0) {
      this.contentEl.createEl("p", { text: "Sources that had trouble:" });
      const errors = this.contentEl.createEl("ul");
      for (const error of report.sourceErrors) {
        errors.createEl("li", { text: `${error.source} — ${error.message}` });
      }
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

interface FeedTestResult {
  url: string;
  count: number;
  newestTitle?: string;
  newestDate?: string;
  error?: string;
}

/** What a feed actually returned, per URL — a count alone doesn't tell you
 * whether you subscribed to the right thing. */
class FeedTestModal extends Modal {
  constructor(app: App, private readonly results: FeedTestResult[]) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Feed test");
    for (const result of this.results) {
      const block = this.contentEl.createDiv();
      block.createEl("p", { text: result.url });
      if (result.error) {
        block.createEl("p", {
          cls: "setting-item-description",
          text: `Could not be read — ${result.error}`,
        });
        continue;
      }
      if (result.count === 0) {
        block.createEl("p", {
          cls: "setting-item-description",
          text: "Reachable, but no items — probably not a feed URL, or an empty feed.",
        });
        continue;
      }
      const dated = result.newestDate ? ` (${result.newestDate})` : "";
      block.createEl("p", {
        cls: "setting-item-description",
        text: `${result.count} item(s). Most recent: ${result.newestTitle ?? "untitled"}${dated}`,
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class AddByIdModal extends Modal {
  private value = "";

  constructor(app: App, private readonly onSubmit: (value: string) => void) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Add a paper");
    const input = this.contentEl.createEl("input", {
      type: "text",
      placeholder: "10.5555/example or 2401.12345",
    });
    input.style.width = "100%";
    input.addEventListener("input", () => { this.value = input.value; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.close();
        this.onSubmit(this.value);
      }
    });
    input.focus();

    const button = this.contentEl.createEl("button", { text: "Add" });
    button.addEventListener("click", () => {
      this.close();
      this.onSubmit(this.value);
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmPruneModal extends Modal {
  constructor(
    app: App,
    private readonly records: InboxRecord[],
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Clean up these arrivals?");
    this.contentEl.createEl("p", {
      text:
        `${this.records.length} arrival(s) are past the keep window and haven't ` +
        "been edited or moved. They'll go to Obsidian's trash, so you can get " +
        "them back.",
    });
    const list = this.contentEl.createEl("ul");
    for (const record of this.records.slice(0, 25)) {
      list.createEl("li", { text: record.title ?? record.notePath });
    }
    if (this.records.length > 25) {
      this.contentEl.createEl("p", { text: `…and ${this.records.length - 25} more.` });
    }

    const buttons = this.contentEl.createDiv();
    const confirm = buttons.createEl("button", { text: "Move to trash" });
    confirm.addClass("mod-warning");
    confirm.addEventListener("click", () => {
      this.close();
      void this.onConfirm();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class PreviewModal extends Modal {
  constructor(app: App, private readonly topic: string, private readonly works: Work[]) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Top results for "${this.topic}"`);
    if (this.works.length === 0) {
      this.contentEl.createEl("p", { text: "No results — try a different query." });
      return;
    }
    this.contentEl.createEl("p", { text: "Does this look like your field?" });
    const list = this.contentEl.createEl("ol");
    for (const work of this.works) {
      list.createEl("li", { text: work.title ?? work.key });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
