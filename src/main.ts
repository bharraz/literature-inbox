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
import { CrossrefClient } from "./core/crossref";
import { doiResolver, titleResolver } from "./core/resolvers";
import { PlanRequiredError, RateLimitError } from "./core/http";
import { fetchFeed, newestItem } from "./core/rss";
import { arxivCategoryFeedUrl, looksLikeArxivCategory } from "./core/feeds";
import {
  describeSource,
  effective,
  isUsable,
  migrateSources,
  withinWindow,
  type SourceConfig,
} from "./core/sources";
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
import { runUpdate, type InboxRecord, type UpdateReport } from "./core/update";
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
  recordReported,
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
import {
  explain,
  readStatusOf,
  suggest,
  withReadStatus,
  type Candidate,
  type ReadStatus,
} from "./core/suggest";
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
 * A spent allowance is the one failure with an actual remedy — a free API key
 * raises it roughly tenfold — so say so, rather than showing a raw HTTP 429
 * and a URL nobody can do anything with.
 */
function describeFetchError(error: unknown, fetched: number, hasKey: boolean): string {
  const gathered = fetched > 0 ? ` Kept the ${fetched} already fetched.` : "";
  if (error instanceof PlanRequiredError) {
    return `OpenAlex needs a paid plan for that query, so it was skipped.${gathered}`;
  }
  if (error instanceof RateLimitError) {
    const hours = error.retryAfterMs ? Math.round(error.retryAfterMs / 3_600_000) : 0;
    if (hours >= 1) {
      // OpenAlex's free tier is a daily spend allowance, not a rate limit.
      return (
        `OpenAlex's daily allowance is used up — it resets at midnight UTC, in about ` +
        `${hours} hour(s).${gathered}` +
        (hasKey ? "" : " A free API key raises it tenfold — see Network and integrations.")
      );
    }
    const advice = hasKey
      ? "Wait a minute and run it again."
      : "A free OpenAlex API key raises the daily allowance tenfold — see " +
        "Network and integrations.";
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
      id: "suggest-paper",
      name: "What should I read?",
      callback: () => void this.suggestPaper(),
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
    // Sources used to be three different shapes: a toggle plus a text box for
    // OpenAlex, a comma-separated string for arXiv, and rows only for feeds.
    // Convert once, then drop the old keys — silently losing someone's
    // configured sources on upgrade would be a poor welcome.
    this.settings.sources = migrateSources(this.settings, this.settings.sources);
    for (const key of [
      "openAlexEnabled",
      "arrivalSelection",
      "arxivEnabled",
      "arxivCategories",
      "rssEnabled",
      "feeds",
      "rssFeeds",
    ] as const) {
      delete this.settings[key];
    }
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
        const response = await inner.get(url);
        if (url.startsWith(OPENALEX_BASE_URL)) {
          this.budget = recordRequests(this.budget, 1);
          if (response.rateLimit) {
            // OpenAlex reports the real figures on every response, so the
            // gauge is measured rather than guessed.
            this.budget = recordReported(this.budget, response.rateLimit);
          }
        }
        return response;
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
      apiKey: this.settings.openAlexApiKey || undefined,
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
      apiKey: this.settings.openAlexApiKey || undefined,
      onPartialFetch: onPartial,
    });
    try {
      return await body();
    } finally {
      this.runClient = undefined;
    }
  }

  /** Crossref, when the user has it on. Free and unmetered — see
   * docs/openalex-dependency.md §0. */
  private crossref(): CrossrefClient | undefined {
    if (!this.settings.crossrefEnabled) return undefined;
    return new CrossrefClient(this.transport(), {
      mailto: this.settings.crossrefMailto || undefined,
    });
  }

  /**
   * The lookup used by backfill, drawing on both sources.
   *
   * Titles ask Crossref first (free, where OpenAlex charges its highest rate);
   * references ask OpenAlex first (inline and fully id-resolvable, where
   * Crossref only has what publishers deposited).
   */
  private referenceResolver() {
    const openAlex = this.openAlex();
    const crossref = this.crossref();
    return {
      ...doiResolver(openAlex, crossref),
      ...titleResolver(crossref, openAlex),
    };
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
      readStatus: this.settings.readStatusEnabled ? "to-read" : undefined,
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

  /**
   * Consult every enabled source, in the order the user listed them.
   *
   * Order is load-bearing: when `maxArrivalsPerRun` bites, whatever is at the
   * front of this list survives, so a row the user put first genuinely wins.
   * The default first row is "papers citing my library", whose results are
   * connected by construction.
   */
  private async fetchAll(report: UpdateReport, vault: VaultIndex): Promise<Work[]> {
    const works: Work[] = [];
    const globalCap = this.settings.maxArrivalsPerRun;

    for (const source of this.settings.sources) {
      if (!isUsable(source)) continue;
      const since = isoDaysAgo(effective(source.windowDays, this.settings.newWindowDays));
      const cap = effective(source.maxPerRun, globalCap);
      try {
        works.push(...(await this.fetchFrom(source, since, cap, vault, report)));
      } catch (error) {
        report.sourceErrors.push({
          source: describeSource(source),
          message: String(error),
        });
      }
    }
    return works;
  }

  /** One source row's worth of candidate papers. */
  private async fetchFrom(
    source: SourceConfig,
    since: string,
    cap: number,
    vault: VaultIndex,
    report: UpdateReport,
  ): Promise<Work[]> {
    switch (source.kind) {
      case "citing": {
        const anchors = await this.adjacencyAnchors(vault);
        if (anchors.length === 0) {
          report.sourceErrors.push({
            source: describeSource(source),
            message:
              `no papers in ${this.settings.papersFolder}/ carry an identifier to match ` +
              "against — add some papers to your graph first",
          });
          return [];
        }
        return this.openAlex().worksCitingSince(anchors, since, cap);
      }

      case "topic":
        return this.openAlex().worksSince(source.value, since, cap);

      case "arxiv":
      case "feed": {
        // A category is just a feed URL the user should not have to know.
        const url =
          source.kind === "arxiv" ? arxivCategoryFeedUrl(source.value) : source.value;
        const items = await fetchFeed(this.transport(), url);
        return withinWindow(items, since).slice(0, cap);
      }
    }
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
      outcomes = await backfillReferences(candidates, this.referenceResolver(), titlesMatch);
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
      // Through the composed resolver, not OpenAlex directly: pasting DOIs is
      // the main way to build a personal graph, and it should not stop working
      // because OpenAlex's daily allowance is spent. Crossref answers the same
      // question for free.
      const found = await doiResolver(this.openAlex(), this.crossref()).worksByDois(list.dois);
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
        (error, fetched) => problems.push(describeFetchError(error, fetched, Boolean(this.settings.openAlexApiKey.trim()))),
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
        readStatus: this.settings.readStatusEnabled ? "to-read" : undefined,
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
    if (!this.settings.sources.some(isUsable)) {
      notify("No sources are switched on — add one in Literature Inbox settings.");
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
            message: describeFetchError(error, fetched, Boolean(this.settings.openAlexApiKey.trim())),
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
      notify(`Moved ${plan.prunable.length} untouched arrival(s) to trash.`);
    }).open();
  }

  /**
   * Fetch a source once and report what came back.
   *
   * A feed or category that is dead, mistyped, or not actually a feed is
   * otherwise indistinguishable from one that simply has nothing new — you
   * find out three empty updates later, if at all. Deliberately ignores the
   * row's on/off switch: testing before switching a source on is the normal
   * order.
   */
  async testFeeds(onlyUrl?: string): Promise<void> {
    const urls = (
      onlyUrl
        ? [onlyUrl]
        : this.settings.sources
            .filter((source) => source.kind === "feed")
            .map((source) => source.value)
    )
      .map((url) => url.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      notify("Add a feed URL first.");
      return;
    }
    await this.reportSources(urls.map((url) => ({ label: url, url })));
  }

  /**
   * Fetch each arXiv category once and report what came back.
   *
   * A misspelled category is not an error at arXiv's end — `quant-ph` works,
   * `quantph` simply returns an empty feed. Without a check that is
   * indistinguishable from a quiet week.
   */
  async testArxivCategories(onlyCategory?: string): Promise<void> {
    const categories = (
      onlyCategory
        ? [onlyCategory]
        : this.settings.sources
            .filter((source) => source.kind === "arxiv")
            .map((source) => source.value)
    )
      .map((category) => category.trim())
      .filter(Boolean);
    if (categories.length === 0) {
      notify("Enter an arXiv category first, e.g. quant-ph.");
      return;
    }

    const targets = categories.map((category) => ({
      label: category,
      url: looksLikeArxivCategory(category) ? arxivCategoryFeedUrl(category) : undefined,
    }));
    await this.reportSources(targets);
  }

  /** Fetch each target once and show what it returned. */
  private async reportSources(
    targets: { label: string; url?: string }[],
  ): Promise<void> {
    notify(`Testing ${targets.length} source(s)…`);
    const results: FeedTestResult[] = [];
    for (const target of targets) {
      if (!target.url) {
        results.push({ url: target.label, count: 0, error: "not an arXiv category name" });
        continue;
      }
      try {
        // No retries: this is a diagnostic, and a user waiting on a button
        // wants the answer now rather than three backoffs later.
        const works = await fetchFeed(this.transport(), target.url, { maxRetries: 0 });
        const newest = newestItem(works);
        results.push({
          url: target.label,
          count: works.length,
          newestTitle: newest?.title,
          newestDate: newest?.date,
        });
      } catch (error) {
        results.push({ url: target.label, count: 0, error: String(error) });
      }
    }
    new FeedTestModal(this.app, results).open();
  }

  /**
   * Offer one paper to read, from the inbox and the library together.
   *
   * The graph answers "what deserves attention" once you are already looking
   * at it. This is for the other mood — ten minutes, no browsing, just give me
   * something. Weighted toward well-connected papers rather than uniformly
   * random, because that is the same judgement the graph makes visually.
   */
  async suggestPaper(): Promise<void> {
    const adapter = this.adapter();
    const candidates: Candidate[] = [];

    for (const folder of [this.settings.inboxFolder, this.settings.papersFolder]) {
      const inInbox = folder === this.settings.inboxFolder;
      for (const path of await adapter.list(folder)) {
        const content = await adapter.read(path);
        if (content === undefined) continue;
        const identity = parseNoteIdentity(content);
        // Only papers: a note the user wrote themselves has no identity and is
        // none of this command's business.
        if (!identity?.originIds.length && !identity?.title) continue;
        const record = this.inbox.find((entry) => entry.notePath === path);
        candidates.push({
          notePath: path,
          title: identity.title ?? path.split("/").pop()?.replace(/\.md$/, "") ?? path,
          edgeCount: record?.edgeCount ?? countCitationLinks(content),
          status: readStatusOf(content),
          inInbox,
        });
      }
    }

    const choice = suggest(candidates);
    if (!choice) {
      notify(
        candidates.length === 0
          ? "No papers yet — add some to your graph first."
          : "Nothing left to suggest: everything is marked read or reference.",
      );
      return;
    }

    new SuggestionModal(
      this.app,
      choice,
      () => void this.suggestPaper(),
      this.settings.readStatusEnabled
        ? (status) => void this.setReadStatus(choice.notePath, status)
        : undefined,
    ).open();
  }

  /**
   * Write a read status onto a note.
   *
   * The recorded hash is deliberately **not** updated, which makes the note
   * count as touched and takes it out of cleanup's reach for good. That is the
   * point: saying you have read something is engagement, and a paper you
   * engaged with should stay in the graph. Cleanup exists to clear out
   * arrivals you never looked at, not ones you triaged. Deleting a paper you
   * are actually done with stays a manual act.
   */
  async setReadStatus(notePath: string, status: ReadStatus): Promise<void> {
    const adapter = this.adapter();
    const content = await adapter.read(notePath);
    if (content === undefined) return;
    const updated = withReadStatus(content, status);
    if (updated === content) return;

    await adapter.write(notePath, updated);
    notify(`Marked as ${status}. It will stay in your graph.`);
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

/** Citation links already written into a note, for papers with no record. */
function countCitationLinks(content: string): number {
  const section = content.split("## Citations")[1];
  return section ? (section.match(/^- \[\[/gm) ?? []).length : 0;
}

/** One paper, offered. */
class SuggestionModal extends Modal {
  constructor(
    app: App,
    private readonly choice: Candidate,
    private readonly again: () => void,
    private readonly mark?: (status: ReadStatus) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("What should I read?");
    this.contentEl.createEl("h3", { text: this.choice.title });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: explain(this.choice),
    });

    const buttons = this.contentEl.createDiv();
    const open = buttons.createEl("button", { text: "Open it" });
    open.addClass("mod-cta");
    open.addEventListener("click", () => {
      const file = this.app.vault.getAbstractFileByPath(this.choice.notePath);
      this.close();
      if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    });

    const another = buttons.createEl("button", { text: "Something else" });
    another.addEventListener("click", () => {
      this.close();
      this.again();
    });

    if (this.mark) {
      // Only offered when the user turned read-status on; otherwise these
      // would write a property they never asked for.
      for (const status of ["read", "reference"] as const) {
        const button = buttons.createEl("button", {
          text: status === "read" ? "Already read" : "Reference only",
        });
        button.addEventListener("click", () => {
          this.close();
          this.mark?.(status);
        });
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
