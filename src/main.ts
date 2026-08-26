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

import { Modal, Plugin, Setting, TFile, type App, type TAbstractFile } from "obsidian";
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
  effectiveInboxFolder,
  isUsable,
  migrateSources,
  withinWindow,
  type SourceConfig,
} from "./core/sources";
import { titlesMatch, normalizeTitle, idsIntersect } from "./core/ids";
import { VaultIndex, scanFolderIdentities } from "./core/vault-state";
import { parseNoteIdentity } from "./core/note-identity";
import { runUpdate, type InboxRecord, type ReferenceRecord, type UpdateReport } from "./core/update";
import {
  backfillReferences,
  hasExactIdentifier,
  hasGivenUp,
  isDueForBackfill,
  type BackfillCandidate,
} from "./core/backfill";

/** What one backfill pass accomplished. */
interface BackfillSummary {
  /** How many notes gained citation edges this run. */
  connected: number;
  /** How many arrivals have an exact identifier (so they were asked about
   * this run) but still have nothing back from OpenAlex yet. */
  stillWaiting: number;
}
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
import { GENERATED_END, mergeCitations, type SubjectOptions } from "./core/notes";
import { contentHash } from "./core/hash";
import {
  estimateConnectivity,
  selectTopicCandidates,
  runKernel,
  type ConnectivityEstimate,
} from "./core/kernel";
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
  /**
  * Ids of papers the user deleted from the inbox. Checked on every later
  * source fetch so a deleted paper does not silently reappear.
   */
  previouslyRemoved?: string[];
  /**
   * Every known paper's own reference list, captured once when its note was
   * first written. The only way a paper that arrives *after* something you
   * already kept can still be linked back to it, without re-fetching every
   * kept paper's references on every run — see `core/citations.ts`'s
   * `ReferenceRecord`. Pruned on load to whatever still has a note.
   */
  referenceIndex?: ReferenceRecord[];
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

/** Give connected arrivals a wider recent pool before the global cap selects
 * the papers with the strongest library connections. */
const ADJACENCY_CANDIDATE_MULTIPLIER = 4;
const ADJACENCY_CANDIDATE_LIMIT = 100;

/** Shown in a note whose references were looked for and never found. */
const UNINDEXED_NOTICE =
  "> **No citation links found.** OpenAlex has not indexed this paper's " +
  "references, so it can't be wired into your graph yet. Checked on every " +
  "run for 30 days after it arrived; it won't be checked again.";

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
  /** Never re-add these — see `PersistedData.previouslyRemoved`. */
  private previouslyRemoved: string[] = [];
  /** See `PersistedData.referenceIndex`. */
  private referenceIndex: ReferenceRecord[] = [];
  private running = false;
  /** The OpenAlex client for the run in progress, if any — see openAlex(). */
  private runClient?: OpenAlexClient;
  /**
   * The candidate pool from the last topic preview, reused by Build so
   * clicking Preview then Build doesn't pay for the same fetch twice — the
   * concept resolution and the up-to-200-work pool fetch are the expensive
   * part of a topic build. One-shot: cleared as soon as it's consumed, so a
   * later Build with no fresh Preview always re-fetches rather than risk
   * building from a stale pool.
   */
  private topicPreviewCache?: { topic: string; size: number; works: Work[] };
  /** Papers in the kept folder, refreshed on load and after a kernel run —
   * shown in settings so the plugin's state is legible at a glance. */
  private keptCount = 0;
  /** Persistent status-bar text for the run in progress. A `Notice` fades on
   * its own after a few seconds, so a slow phase between two notices reads as
   * a hang; this stays put until the run clears it. */
  private statusBarItem!: HTMLElement;

  override async onload(): Promise<void> {
    await this.loadPersisted();
    // Cheap, local, and no network: just counts what's on disk.
    await this.refreshKeptCount();
    this.addSettingTab(new LiteratureInboxSettingTab(this.app, this));
    this.statusBarItem = this.addStatusBarItem();

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
    // "Expand from my whole library" (the `library` kernel mode) answers a
    // different question than "I want to dig deeper into *these* specific
    // papers" — the context menu on an actual selection is how you say the
    // second thing, rather than a text box where you'd have to retype titles
    // you can already see and click.
    const papersOnly = (files: TAbstractFile[]) =>
      files.filter(
        (file): file is TFile =>
          file instanceof TFile && file.path.startsWith(`${this.settings.papersFolder}/`),
      );
    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, files) => {
        const selected = papersOnly(files);
        if (selected.length === 0) return;
        menu.addItem((item) =>
          item
            .setTitle(`Expand outward from ${selected.length} paper(s)…`)
            .setIcon("git-branch-plus")
            .onClick(() =>
              new ExpandOptionsModal(
                this.app,
                selected.length,
                this.settings.kernelSize,
                this.settings.papersFolder,
                (count, folder) => void this.expandFromNotes(selected, { count, folder }),
              ).open(),
            ),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const selected = papersOnly([file]);
        if (selected.length === 0) return;
        menu.addItem((item) =>
          item
            .setTitle("Expand outward from this paper…")
            .setIcon("git-branch-plus")
            .onClick(() =>
              new ExpandOptionsModal(
                this.app,
                selected.length,
                this.settings.kernelSize,
                this.settings.papersFolder,
                (count, folder) => void this.expandFromNotes(selected, { count, folder }),
              ).open(),
            ),
        );
      }),
    );
  }

  // --- persistence ---------------------------------------------------------

  private async loadPersisted(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    const savedSettings: Partial<LiteratureInboxSettings> & { includeAuthors?: boolean } =
      data?.settings ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    if (!Object.prototype.hasOwnProperty.call(savedSettings, "authorPlacement")) {
      this.settings.authorPlacement = savedSettings.includeAuthors === false ? "off" : "property";
    }
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
      "includeAuthors",
    ] as const) {
      delete this.settings[key];
    }
    this.inbox = Array.isArray(data?.inbox) ? (data?.inbox as InboxRecord[]) : [];
    this.budget = data?.budget ?? emptyBudget(utcDay());
    this.openAlexIdByDoi = data?.openAlexIdByDoi ?? {};
    this.previouslyRemoved = Array.isArray(data?.previouslyRemoved) ? data.previouslyRemoved : [];
    this.referenceIndex = Array.isArray(data?.referenceIndex) ? data.referenceIndex : [];
  }

  private async persist(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      inbox: this.inbox,
      budget: this.budget,
      openAlexIdByDoi: this.openAlexIdByDoi,
      previouslyRemoved: this.previouslyRemoved,
      referenceIndex: this.referenceIndex,
    } satisfies PersistedData);
  }

  /**
   * Fold newly-written papers' reference lists into the persisted index, and
  * drop any existing record whose paper no longer has a note, so a deleted
  * file does not leave stale state behind with nothing left for it to link.
   */
  private async mergeReferenceRecords(
    fresh: readonly ReferenceRecord[],
    vault: VaultIndex,
  ): Promise<void> {
    const stillPresent = this.referenceIndex.filter(
      (record) =>
        vault.findByOrigin(record.ids) !== undefined ||
        this.inbox.some((entry) => idsIntersect(entry.originIds, record.ids)),
    );
    this.referenceIndex = [...stillPresent, ...fresh];
    await this.persist();
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
   * Ask OpenAlex for today's real figures right now, rather than waiting for
   * them to arrive as a side effect of the next run. One cheap request; the
   * transport wrapper records its `X-RateLimit-*` headers the same as any
   * other.
   */
  async refreshBudget(): Promise<void> {
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }
    try {
      await this.openAlex().ping();
    } catch (error) {
      notify(`Could not refresh: ${String(error)}`);
    }
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

  /** Shows in the status bar for the run in progress; clear with no argument. */
  private setStatus(text?: string): void {
    this.statusBarItem.setText(text ? `⏳ ${text}` : "");
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
   * What the vault already contains, read directly from the papers folder.
   *
   * Moving a note out of the inbox is the keep signal, and without scanning
   * the folder the next update would find no record of that paper and fetch
   * it straight back in — so this isn't an optimisation, it's what makes
   * keeping work at all.
   */
  private async vaultIndex(): Promise<VaultIndex> {
    const adapter = this.adapter();
    const scanned = await scanFolderIdentities(
      this.settings.papersFolder,
      (folder) => adapter.list(folder),
      (path) => adapter.read(path),
      parseNoteIdentity,
    );
    return new VaultIndex(scanned, normalizeTitle);
  }

  /** Reconcile inbox state with the vault before any new papers are added. */
  private async reconcileInboxState(vault: VaultIndex): Promise<void> {
    const inboxPaths = new Set(await this.adapter().list(this.settings.inboxFolder));
    const remaining: InboxRecord[] = [];
    let changed = false;

    for (const record of this.inbox) {
      if (inboxPaths.has(record.notePath)) {
        remaining.push(record);
        continue;
      }

      changed = true;
      // A note moved into Papers/ is kept. A note found nowhere is treated as
      // a deliberate deletion and must not return on a later source fetch.
      if (!vault.findByOrigin(record.originIds)) {
        for (const id of record.originIds) {
          if (!this.previouslyRemoved.includes(id)) this.previouslyRemoved.push(id);
        }
      }
    }

    if (!changed) return;
    this.inbox = remaining;
    await this.persist();
  }

  private updateSettings() {
    return {
      inboxFolder: this.settings.inboxFolder,
      papersFolder: this.settings.papersFolder,
      maxArrivalsPerRun: this.settings.maxArrivalsPerRun,
      authorPlacement: this.settings.authorPlacement,
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
   * otherwise be unable to anchor anything — which would silently exclude
   * every DOI-only paper in the library. One batched DOI lookup converts
   * them, and is worth the request.
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
  /**
   * *folderByWork* and *sourceByWork* are populated as a side effect — one
   * entry per fetched work each, mapping it to its source's effective inbox
   * folder (see `effectiveInboxFolder`) and its human-readable source label —
   * so the caller can hand `runUpdate` a `folderFor` and `sourceFor` that
   * write each arrival to its own source's folder and report where it came
   * from.
   */
  private async fetchAll(
    report: UpdateReport,
    vault: VaultIndex,
    folderByWork: Map<Work, string>,
    sourceByWork: Map<Work, string>,
  ): Promise<Work[]> {
    const works: Work[] = [];
    const globalCap = this.settings.maxArrivalsPerRun;
    // "New" means the same thing for every source — one global window, not a
    // per-row override nobody needs: the whole point of these results is that
    // they're recent, so the value worth tuning is how far back "recent"
    // reaches, and that's a single number for the whole inbox.
    const since = isoDaysAgo(this.settings.newWindowDays);

    for (const source of this.settings.sources) {
      if (!isUsable(source)) continue;
      const cap = effective(source.maxPerRun, globalCap);
      const folder = effectiveInboxFolder(source, this.settings.inboxFolder);
      const label = describeSource(source);
      try {
        const fetched = await this.fetchFrom(source, since, cap, vault, report);
        for (const work of fetched) {
          folderByWork.set(work, folder);
          sourceByWork.set(work, label);
        }
        works.push(...fetched);
      } catch (error) {
        report.sourceErrors.push({
          source: label,
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
        const candidateLimit = Math.min(
          cap * ADJACENCY_CANDIDATE_MULTIPLIER,
          ADJACENCY_CANDIDATE_LIMIT,
        );
        return this.openAlex().worksCitingSince(anchors, since, candidateLimit);
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
  private async backfillEdgelessArrivals(): Promise<BackfillSummary> {
    const adapter = this.adapter();
    const candidates: BackfillCandidate[] = [];

    const today = todayIso();
    const due: InboxRecord[] = [];
    // Arrivals with an exact identifier (a real DOI, or an arXiv id) resolve
    // through one shared batched request regardless of how many there are —
    // see `hasExactIdentifier`'s doc comment — so there's no cost reason to
    // ration them on the widening schedule; only a bare title guess, priced
    // an order of magnitude higher and never batchable, needs that.
    const exactIdCandidates = new Set<string>();
    for (const record of this.inbox) {
      const content = await adapter.read(record.notePath);
      if (content === undefined) continue;
      // An edit elsewhere in the note no longer excludes it: the citations
      // block is additive-only and self-contained, so it's safe to update
      // regardless. (The write path still never lets that edit's tracked
      // hash get laundered into looking untouched again — see below.)
      const hasEdges = content.includes("## Citations");
      const exact = hasExactIdentifier(record.originIds);
      if (exact) exactIdCandidates.add(record.notePath);
      if (!hasEdges && !exact) {
        // A title-only guess past its 30-day watchlist window is marked and
        // left alone here, on whichever run first notices — it needn't have
        // been "due" today to have expired; those are different questions.
        if (hasGivenUp(record.arrivedOn, today)) {
          await this.markUnindexed(record);
          continue;
        }
        // Only ask about notes that are actually due. Without this, every
        // isolated title-only arrival was re-queried on every run, at the
        // expensive per-item rate.
        if (!isDueForBackfill(record, record.arrivedOn, today)) continue;
        due.push(record);
      }
      candidates.push({
        notePath: record.notePath,
        originIds: record.originIds,
        title: record.title,
        hasEdges,
      });
    }
    if (candidates.length === 0) return { connected: 0, stillWaiting: 0 };

    let outcomes;
    try {
      outcomes = await backfillReferences(candidates, this.referenceResolver(), titlesMatch);
    } catch {
      return { connected: 0, stillWaiting: 0 }; // an improvement on what's there, never a blocker
    }

    const resolvedPaths = new Set(outcomes.map((outcome) => outcome.notePath));
    // Record that a title-only note was asked about today, whether or not it
    // resolved. Exact-identifier candidates never touch this: they're cheap
    // enough to just keep asking about forever, with no watchlist to expire.
    for (const record of due) record.lastBackfillOn = today;
    const stillWaiting = [...exactIdCandidates].filter(
      (path) => !resolvedPaths.has(path) && candidates.some((c) => c.notePath === path && !c.hasEdges),
    ).length;
    if (outcomes.length === 0) {
      await this.persist();
      return { connected: 0, stillWaiting };
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
      if (content === undefined) continue;

      // The citations block is safe to add to regardless of whether the rest
      // of the note has been edited — it's additive-only, and never touches
      // anything outside its own markers. But the *tracked* hash must not
      // move unless the note was already untouched: if the user genuinely
      // edited this note, adding a link here must not make it look freshly
      // generated again and newly eligible for automated rewriting.
      const wasUnchanged = contentHash(content) === record.contentHash;
      const updated = mergeCitations(content, cites, []);
      if (updated === content) continue;

      await adapter.write(outcome.notePath, updated);
      if (wasUnchanged) record.contentHash = contentHash(updated);
      record.originIds = [...record.originIds, ...outcome.newIds];
      connected += 1;
    }

    if (connected > 0) await this.persist();
    return { connected, stillWaiting };
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
      // Reuse a matching Preview's pool rather than re-paying for the same
      // fetch — see topicPreviewCache. One-shot: consumed here, so a second
      // Build without a fresh Preview fetches again rather than risk
      // building from a stale pool.
      const cached = this.topicPreviewCache;
      if (cached && cached.topic === topic && cached.size === size) {
        this.topicPreviewCache = undefined;
        return cached.works;
      }

      // Over-fetch: "most cited" alone can surface a mutually disconnected
      // set for a narrow or recent field, so a larger pool is fetched here
      // and runKernel picks the best-connected `size` of them.
      const poolSize = topicPoolSize(size);
      notify(`Fetching candidates for "${topic}"… this can take a minute.`);
      this.setStatus(`fetching candidates for "${topic}"…`);
      return this.openAlex().topWorks(topic, poolSize);
    }

    if (mode === "author") {
      const author = this.settings.kernelAuthor.trim();
      if (!author) {
        notify("Enter an author id, ORCID, or name first.");
        return undefined;
      }
      notify(`Fetching up to ${size} papers by ${author}…`);
      this.setStatus(`fetching up to ${size} papers by ${author}…`);
      return this.openAlex().worksByAuthor(author, size);
    }

    if (mode === "seeds" || mode === "snowball") {
      if (!this.settings.kernelSeeds.trim()) {
        notify("Paste some DOIs or arXiv ids first.");
        return undefined;
      }
      notify("Looking up the papers you listed…");
      this.setStatus("looking up the papers you listed…");
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
    this.setStatus("reading the papers you already have…");
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
    this.setStatus(`expanding ${seeds.length} paper(s) outward…`);
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
      // The status bar mirrors it and, unlike a Notice, stays legible for
      // however long the phase actually takes.
      onProgress: (phase, found) => {
        const message =
          phase === "references"
            ? `Found ${found} cited paper(s), now looking for citing papers…`
            : `Found ${found} citing paper(s).`;
        notify(message);
        this.setStatus(message);
      },
    });
    for (const error of report.errors) notify(`Part of the expansion failed — ${error}`);
    return report.works;
  }

  /** Origin ids read straight off the selected notes' frontmatter, resolved
   * to full works. Unlike `librarySeeds`, this is exactly the files the user
   * picked — no folder-wide scan, no cap. */
  private async seedsFromNotes(files: readonly TFile[]): Promise<Work[]> {
    const adapter = this.adapter();
    const originIdSets: string[][] = [];
    for (const file of files) {
      const content = await adapter.read(file.path);
      if (content === undefined) continue;
      const identity = parseNoteIdentity(content);
      if (identity?.originIds.length) originIdSets.push(identity.originIds);
    }
    const { openAlexIds, dois } = seedsFromOriginIds(originIdSets, originIdSets.length);
    if (openAlexIds.length === 0 && dois.length === 0) return [];

    const client = this.openAlex();
    const works: Work[] = [];
    if (openAlexIds.length > 0) works.push(...(await client.worksByIds(openAlexIds)));
    if (dois.length > 0) works.push(...(await client.worksByDois(dois)));
    return works;
  }

  /**
   * Expand outward from specific papers the user picked (context menu on a
   * file selection), rather than the whole library — "I want to dig deeper
   * into *these*" is a different request than "grow everything I have."
   *
   * Over-fetches a pool beyond `kernelSize` and lets `runKernel`'s balanced
   * selection pick the best `kernelSize` of it — same reasoning as the topic
   * mode's over-fetch (see `topicPoolSize`), except a snowball's own order
   * (seeds, then references, then citers) isn't an impact ranking the way a
   * topic fetch's cited_by_count:desc sort already is, so the pool is
   * re-sorted by real citation count first.
   */
  async expandFromNotes(
    files: readonly TFile[],
    options?: { count?: number; folder?: string },
  ): Promise<void> {
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }
    if (files.length === 0) {
      notify(`Select papers in ${this.settings.papersFolder}/ to expand from.`);
      return;
    }

    this.running = true;
    this.setStatus("reading selected papers…");
    const problems: string[] = [];
    const targetFolder = options?.folder?.trim() || this.settings.papersFolder;
    try {
      const size = options?.count ?? this.settings.kernelSize;
      const pool = await this.withSharedClient(
        (error, fetched) =>
          problems.push(
            describeFetchError(error, fetched, Boolean(this.settings.openAlexApiKey.trim())),
          ),
        async () => {
          const seeds = await this.seedsFromNotes(files);
          if (seeds.length === 0) return [];
          return this.expand(seeds, topicPoolSize(size));
        },
      );
      for (const problem of problems) notify(problem);
      if (pool.length === 0) {
        notify("None of the selected papers had a usable identifier.");
        return;
      }

      const ranked = [...pool].sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0));

      const vault = await this.vaultIndex();
      await this.reconcileInboxState(vault);
      const report = await runKernel({
        works: ranked,
        vault,
        papersFolder: targetFolder,
        adapter: this.adapter(),
        today: todayIso(),
        authorPlacement: this.settings.authorPlacement,
        subjects: this.subjectOptions(),
        readStatus: this.settings.readStatusEnabled ? "to-read" : undefined,
        targetCount: size,
        onProgress: (written, total) => {
          this.setStatus(`writing ${written} of ${total}…`);
          if (written % 25 === 0 && written < total) notify(`Writing ${written} of ${total}…`);
        },
      });
      await this.mergeReferenceRecords(report.newReferenceRecords, vault);

      this.keptCount += report.written.length;
      const parts = [`${report.written.length} papers added to ${targetFolder}/`];
      if (report.totalEdges) parts.push(`${report.totalEdges} citation links between them`);
      if (report.skipped) parts.push(`${report.skipped} you already had`);
      notify(`Expanded from ${files.length} selected paper(s): ${parts.join(", ")}.`);
    } catch (error) {
      notify(`Could not expand: ${String(error)}`);
    } finally {
      this.running = false;
      this.setStatus(undefined);
    }
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
    this.setStatus("starting…");
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

      const vault = await this.vaultIndex();
      await this.reconcileInboxState(vault);
      const report = await runKernel({
        works,
        vault,
        papersFolder: this.settings.papersFolder,
        adapter: this.adapter(),
        today: todayIso(),
        authorPlacement: this.settings.authorPlacement,
        subjects: this.subjectOptions(),
        readStatus: this.settings.readStatusEnabled ? "to-read" : undefined,
        // Only topic mode over-fetches a pool bigger than what it wants
        // written; every other mode already fetched exactly its input.
        targetCount: this.settings.kernelMode === "topic" ? this.settings.kernelSize : undefined,
        onProgress: (written, total) => {
          // The status bar updates every note — cheap, and unlike a Notice it
          // doesn't fade, so it's always current. A Notice still fires only
          // every 25, or a paper's worth of them would bury the screen.
          this.setStatus(`writing ${written} of ${total}…`);
          if (written % 25 === 0 && written < total) notify(`Writing ${written} of ${total}…`);
        },
      });
      await this.mergeReferenceRecords(report.newReferenceRecords, vault);

      this.keptCount += report.written.length;
      const parts = [`${report.written.length} papers added to ${this.settings.papersFolder}/`];
      if (report.totalEdges) parts.push(`${report.totalEdges} citation links between them`);
      if (report.skipped) parts.push(`${report.skipped} you already had`);
      notify(`Added to your graph: ${parts.join(", ")}.`);
    } catch (error) {
      notify(`Could not add papers: ${String(error)}`);
    } finally {
      this.running = false;
      this.setStatus(undefined);
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
    this.setStatus("fetching…");
    try {
      // One scan of the vault, shared: adjacency selection needs to know what
      // you keep, and so does the dedup pass.
      const vault = await this.vaultIndex();
      await this.reconcileInboxState(vault);
      const preliminary: UpdateReport = { arrived: [], skipped: [], sourceErrors: [] };
      const folderByWork = new Map<Work, string>();
      const sourceByWork = new Map<Work, string>();
      const fetched = await this.withSharedClient(
        (error, fetched) =>
          preliminary.sourceErrors.push({
            source: "OpenAlex",
            message: describeFetchError(error, fetched, Boolean(this.settings.openAlexApiKey.trim())),
          }),
        () => this.fetchAll(preliminary, vault, folderByWork, sourceByWork),
      );

      const { report, inbox, newReferenceRecords } = await runUpdate({
        fetched,
        vault,
        inbox: this.inbox,
        settings: this.updateSettings(),
        adapter: this.adapter(),
        today: todayIso(),
        previouslyRemoved: this.previouslyRemoved,
        folderFor: (work) => folderByWork.get(work) ?? this.settings.inboxFolder,
        sourceFor: (work) => sourceByWork.get(work) ?? "Unknown source",
        referenceIndex: this.referenceIndex,
      });
      report.sourceErrors.push(...preliminary.sourceErrors);

      this.inbox = inbox;
      this.settings.lastUpdate = todayIso();
      await this.mergeReferenceRecords(newReferenceRecords, vault);

      // arXiv and RSS arrivals land edge-less; OpenAlex usually indexes them
      // within days, so ask again for the ones still isolated.
      this.setStatus("checking isolated arrivals for new connections…");
      const { connected: backfilled, stillWaiting } = await this.backfillEdgelessArrivals();

      const parts = [`${report.arrived.length} new`];
      if (report.skipped.length) parts.push(`${report.skipped.length} already known`);
      if (backfilled) parts.push(`${backfilled} newly connected`);
      if (report.retroConnections) {
        parts.push(`${report.retroConnections} older paper(s) now link to today's arrivals`);
      }
      if (report.cappedAt) parts.push(`capped at ${report.cappedAt}`);
      if (report.sourceErrors.length) parts.push(`${report.sourceErrors.length} source error(s)`);
      notify(`Literature Inbox: ${parts.join(", ")}.`);
      // Told separately from the main summary — it's "still working on it",
      // not a problem, and burying it in the comma-list above would read as
      // one more failure among several rather than the reassurance it is.
      if (stillWaiting > 0) {
        notify(
          `${stillWaiting} arrival(s) not yet indexed by OpenAlex — checked again every run ` +
            "until they connect.",
        );
      }

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
      this.setStatus(undefined);
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
    // being dragged there by hand or by a kernel run, so a counter nudged
    // only on this path drifts out of step with the folder.
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
    this.setStatus("looking up what you pasted…");
    try {
      const { works, missing, unrecognised } = await this.resolveSeeds(raw);
      this.reportSeedProblems(missing, unrecognised);
      if (works.length === 0) {
        if (missing.length === 0 && unrecognised.length === 0) notify("Nothing found.");
        return;
      }

      if (target === "papers") {
        const vault = await this.vaultIndex();
        await this.reconcileInboxState(vault);
        const report = await runKernel({
          works,
          vault,
          papersFolder: this.settings.papersFolder,
          adapter: this.adapter(),
          today: todayIso(),
          authorPlacement: this.settings.authorPlacement,
          subjects: this.subjectOptions(),
          readStatus: this.settings.readStatusEnabled ? "to-read" : undefined,
        });
        await this.mergeReferenceRecords(report.newReferenceRecords, vault);
        this.keptCount += report.written.length;
        notify(
          `Added ${report.written.length} paper(s) to ${this.settings.papersFolder}/` +
            (report.skipped ? `, ${report.skipped} you already had.` : "."),
        );
        return;
      }

      const vault = await this.vaultIndex();
      await this.reconcileInboxState(vault);
      const { report, inbox, newReferenceRecords } = await runUpdate({
        fetched: works,
        vault,
        inbox: this.inbox,
        settings: this.updateSettings(),
        adapter: this.adapter(),
        today: todayIso(),
        referenceIndex: this.referenceIndex,
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

      this.inbox = inbox;
      await this.mergeReferenceRecords(newReferenceRecords, vault);
      const skipped = report.skipped.length ? `, ${report.skipped.length} already known` : "";
      notify(`Added ${report.arrived.length} paper(s) to ${this.settings.inboxFolder}/${skipped}.`);
    } catch (error) {
      notify(`Could not add: ${String(error)}`);
    } finally {
      this.running = false;
      this.setStatus(undefined);
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
      // arXiv skips Saturday and Sunday: a valid category legitimately shows
      // zero items on those days, which otherwise looks identical to a typo.
      emptyHint: "arXiv doesn't publish new listings on Saturdays or Sundays — a category that is otherwise correct can show zero items on those days.",
    }));
    await this.reportSources(targets);
  }

  /** Fetch each target once and show what it returned. */
  private async reportSources(
    targets: { label: string; url?: string; emptyHint?: string }[],
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
          emptyHint: target.emptyHint,
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
  * count as touched and keeps the note in the graph. That is the
   * point: saying you have read something is engagement, and a paper you
  * engaged with should stay in the graph. Deleting a paper you are actually
  * done with stays a manual act.
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
      const client = this.openAlex();
      const size = this.settings.kernelSize;
      // Sequential, not parallel: both calls resolve the same topic's
      // concept id, and the client memoizes that per topic — running them
      // one after another means the second reuses the first's cached
      // resolution instead of doubling the request burst against a client
      // that has no daily budget problem but can still trip a short-window
      // rate limit on a fast double-fire.
      const pool = await client.topWorks(topic, topicPoolSize(size));
      const unresolved = await client.unresolvedTopics(topic);
      this.topicPreviewCache = { topic, size, works: pool };
      // Same selection Build would apply, so the preview's connectivity
      // number describes the real outcome, not just the raw top-cited
      // handful.
      const selected = selectTopicCandidates(pool, size);
      const connectivity = estimateConnectivity(selected);
      new PreviewModal(this.app, topic, selected, unresolved, connectivity).open();
    } catch (error) {
      notify(describeFetchError(error, 0, Boolean(this.settings.openAlexApiKey.trim())));
    }
  }
}

/** How many candidates to over-fetch so connectivity-based selection has a
 * real pool to pick a well-connected `target` out of. */
function topicPoolSize(target: number): number {
  return Math.min(Math.max(target * 5, target + 40), 200);
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
    this.setTitle("Update report");
    const { report } = this;
    const previouslyRemoved = report.skipped.filter((s) => s.reason === "previously-removed");

    if (report.arrived.length === 0) {
      this.contentEl.createEl("p", {
        text:
          report.skipped.length === 0
            ? "Nothing new this run."
            : previouslyRemoved.length === report.skipped.length
              ? `Nothing new — every paper found is one you removed before.`
              : `Nothing new — all ${report.skipped.length} paper(s) found are already in your ` +
                "vault or ones you removed before.",
      });
    } else {
      this.contentEl.createEl("p", {
        text: `${report.arrived.length} new paper(s), most connected first.`,
      });
      // A per-source count, so "3 new" doesn't hide that all 3 came from one
      // row while the other four sources found nothing — worth knowing
      // before deciding a source is dead versus just quiet this run.
      const perSource = new Map<string, number>();
      for (const arrival of report.arrived) {
        const label = arrival.source ?? "Unknown source";
        perSource.set(label, (perSource.get(label) ?? 0) + 1);
      }
      if (perSource.size > 1) {
        const bySource = this.contentEl.createEl("ul");
        for (const [label, count] of perSource) {
          bySource.createEl("li", { text: `${label}: ${count}` });
        }
      }
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
    const otherSkips = report.skipped.length - previouslyRemoved.length;
    if (otherSkips > 0 && report.arrived.length > 0) {
      notes.push(`${otherSkips} already in your vault, skipped.`);
    }
    if (previouslyRemoved.length > 0) {
      notes.push(
        `${previouslyRemoved.length} not re-added — you removed ${previouslyRemoved.length === 1 ? "it" : "them"} before.`,
      );
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
    this.setTitle("What should I read?");
    this.contentEl.createDiv({
      cls: "literature-inbox-suggestion-title",
      text: this.choice.title,
    });
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
  emptyHint?: string;
}

/** What a feed actually returned, per URL — a count alone doesn't tell you
 * whether you subscribed to the right thing. */
class FeedTestModal extends Modal {
  constructor(app: App, private readonly results: FeedTestResult[]) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Feed test");
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
          text:
            result.emptyHint ??
            "Reachable, but no items — probably not a feed URL, or an empty feed.",
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
    this.setTitle("Add a paper");
    const input = this.contentEl.createEl("input", {
      type: "text",
      cls: "literature-inbox-id-input",
      placeholder: "10.5555/example or 2401.12345",
    });
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

/** Count + destination folder for an "expand from selected papers" run — the
 * two things worth asking about before spending a fetch, since they change
 * where the result lands and how big it is. */
class ExpandOptionsModal extends Modal {
  private count: number;
  private folder: string;

  constructor(
    app: App,
    private readonly selectionSize: number,
    defaultCount: number,
    defaultFolder: string,
    private readonly onSubmit: (count: number, folder: string) => void,
  ) {
    super(app);
    this.count = defaultCount;
    this.folder = defaultFolder;
  }

  override onOpen(): void {
    this.setTitle(
      `Expand outward from ${this.selectionSize} paper(s)`,
    );

    new Setting(this.contentEl)
      .setName("How many papers to add")
      .setDesc("A ceiling on what the expansion adds, beyond the papers you selected.")
      .addText((text) =>
        text.setValue(String(this.count)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 1) this.count = parsed;
        }),
      );

    new Setting(this.contentEl)
      .setName("Add to folder")
      .setDesc(
        "Where the expanded papers are written. Feel free to use a subfolder — " +
          "anything under your library directory is still scanned normally.",
      )
      .addText((text) =>
        text.setValue(this.folder).onChange((value) => {
          this.folder = value;
        }),
      );

    const buttonRow = new Setting(this.contentEl);
    buttonRow.addButton((button) =>
      button
        .setButtonText("Expand")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit(this.count, this.folder);
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class PreviewModal extends Modal {
  constructor(
    app: App,
    private readonly topic: string,
    private readonly works: Work[],
    private readonly unresolvedTopics: string[],
    private readonly connectivity: ConnectivityEstimate,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`Top results for "${this.topic}"`);
    if (this.works.length === 0) {
      this.contentEl.createEl("p", { text: "No results — try a different query." });
      return;
    }
    if (this.unresolvedTopics.length > 0) {
      const terms = this.unresolvedTopics.map((t) => `"${t}"`).join(", ");
      this.contentEl.createEl("p", {
        text:
          `OpenAlex has no field matching ${terms} — that part of the query falls back ` +
          "to unscoped full-text search sorted by citation count, so it can surface " +
          "unrelated highly-cited papers. Try a more common phrasing, or add spaces " +
          "between words (e.g. \"Smart Grid\" instead of \"SmartGrid\").",
        cls: "literature-inbox-warning",
      });
    }
    const { connected, total, edges } = this.connectivity;
    this.contentEl.createEl("p", {
      text:
        `${connected} of ${total} cite or are cited by another paper in this set ` +
        `(${edges} link${edges === 1 ? "" : "s"}) — the rest would land as isolated dots. ` +
        (connected === 0
          ? "This query may be too narrow or too recent for a connected starting graph."
          : ""),
    });
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
