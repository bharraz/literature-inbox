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

import {
  MarkdownView,
  Modal,
  Plugin,
  Setting,
  TFile,
  TFolder,
  type App,
  type Menu,
  type TAbstractFile,
  type WorkspaceLeaf,
} from "obsidian";
import { ArxivClient } from "./core/arxiv";
import { isoDaysAgo } from "./core/dates";
import {
  OpenAlexClient,
  OpenAlexKeyError,
  OPENALEX_BASE_URL,
  type TopicTermMatch,
} from "./core/openalex";
import { CrossrefClient } from "./core/crossref";
import { doiResolver, titleResolver } from "./core/resolvers";
import { PlanRequiredError, RateLimitError } from "./core/http";
import { fetchFeed, newestItem } from "./core/rss";
import { arxivCategoryFeedUrl, looksLikeArxivCategory } from "./core/feeds";
import {
  describeSource,
  effective,
  foldersOverlap,
  isUsable,
  migrateSources,
  nestUnder,
  sharedFolder,
  withinWindow,
  type SourceConfig,
} from "./core/sources";
import { titlesMatch, normalizeTitle, idsIntersect, serializeId } from "./core/ids";
import { VaultIndex, scanFolderIdentities } from "./core/vault-state";
import { parseNoteIdentity } from "./core/note-identity";
import { reconcileInbox } from "./core/reconcile";
import { applyRename } from "./core/renames";
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
import { GENERATED_END, mergeCitations } from "./core/notes";
import { contentHash } from "./core/hash";
import {
  estimateConnectivity,
  selectTopicCandidates,
  runKernel,
  type ConnectivityEstimate,
} from "./core/kernel";
import { parseSeedList, seedsFromOriginIds } from "./core/seeds";
import { snowball } from "./core/snowball";
import type { Work, WorkId } from "./core/types";
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

/** Applied only to an open paper's own Markdown view, never to the whole app. */
const COMPACT_PROPERTIES_CLASS = "literature-inbox-paper-properties-compact";
const HIDDEN_PROPERTIES_CLASS = "literature-inbox-paper-properties-hidden";

/** What the expand modal hands back when the user confirms. */
type ExpandRun = (count: number, folder: string) => void;

/** Where a fetched work came from, as far as writing and capping it go. */
interface FetchOrigin {
  label: string;
  /** Distinguishes source rows, even two with the same label. */
  group: string;
  cap: number;
  /** Its relevance rank, for a topic search; 0 for sources ranked by date. */
  order: number;
}

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
 * library is a hit — and the cost is one request per 50 anchors.
 */
const ADJACENCY_ANCHOR_LIMIT = 100;

/**
 * How many candidates a search-backed source fetches for a row capped at
 * *cap*. Only the best *cap* are written; the rest are what lets ranking
 * choose, and what lets the next run reach past papers already seen rather
 * than reporting "0 new" while unseen ones sit one place further down.
 * OpenAlex bills per request, not per result, so the pool is free in credits;
 * the ceiling is download size — about 15 KB a paper, so 50 is under a
 * megabyte on a phone.
 */
function candidatePool(cap: number): number {
  return Math.min(Math.max(cap * 10, 25), 50);
}

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
  if (error instanceof OpenAlexKeyError) {
    return error.reason === "invalid"
      ? "OpenAlex rejected your API key — check it under Network and integrations in " +
          "Literature Inbox settings, or clear it to use the free allowance."
      : `OpenAlex only returns the first 200 results without a free API key.${gathered} ` +
          "Add one under Network and integrations to fetch more.";
  }
  return `OpenAlex fetch failed: ${String(error)}.${gathered}`;
}

/** An error as one line for a notice: OpenAlex's own failures in words the
 * user can act on, anything else as it came. */
function errorText(error: unknown, hasKey: boolean): string {
  const fromOpenAlex =
    error instanceof OpenAlexKeyError ||
    error instanceof RateLimitError ||
    error instanceof PlanRequiredError;
  return fromOpenAlex ? describeFetchError(error, 0, hasKey) : String(error);
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
    this.applyPropertyDisplay();
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
      id: "copy-doi",
      name: "Copy this paper's DOI",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile)) return false;
        const doi = this.doiForFile(file);
        if (!checking && doi) void this.copyDoi(doi);
        return Boolean(doi);
      },
    });
    // Papers and folders inside the library, alone or together: a subfolder
    // is usually a topic the user has been gathering by hand. The results go,
    // by default, into the deepest folder the selection shares, alongside
    // what they grew from.
    const offerExpand = (menu: Menu, items: TAbstractFile[]) => {
      const papers = items.filter(
        (item): item is TFile =>
          item instanceof TFile && item.extension === "md" && this.isInLibrary(item.path),
      );
      const folders = items.filter(
        (item): item is TFolder => item instanceof TFolder && this.isInLibrary(item.path),
      );
      if (papers.length === 0 && folders.length === 0) return;

      const subject = describeSelection(papers.length, folders.map((folder) => folder.path));
      const shared = sharedFolder([
        ...papers.map((paper) => ({ path: paper.path, isFolder: false })),
        ...folders.map((folder) => ({ path: folder.path, isFolder: true })),
      ]);
      const destination = this.isInLibrary(shared) ? shared : this.settings.papersFolder;
      const run: ExpandRun = (count, folder) =>
        void this.expandFromSelection(
          papers.map((paper) => paper.path),
          folders.map((folder) => folder.path),
          { count, folder, subject },
        );
      menu.addItem((item) =>
        item
          .setTitle(`Expand outward from ${subject}…`)
          .setIcon("git-branch-plus")
          .onClick(() =>
            new ExpandOptionsModal(this.app, subject, this.settings.kernelSize, destination, run).open(),
          ),
      );
    };
    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => offerExpand(menu, files)));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => offerExpand(menu, [file])));
    // Classes live on individual Markdown views, rather than <body>, so they
    // cannot affect other notes or the Properties sidebar.
    this.registerEvent(this.app.workspace.on("file-open", () => this.applyPropertyDisplay()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.applyPropertyDisplay()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) void this.applyPropertyDisplayToLeaf(leaf, true);
      }),
    );
    // A just-created note can open before its frontmatter has reached the
    // cache. Re-apply when parsing finishes so it does not stay unstyled.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.applyPropertyDisplay()));

    // Renames are followed as they happen — see `core/renames.ts`. A renamed
    // inbox or library folder must not read, on the next run, as every paper
    // in it having been deleted.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.followRename(oldPath, file.path)),
    );
  }

  override onunload(): void {
    this.clearPropertyDisplayClasses();
  }

  /** Whether *path* is the library folder or inside it. */
  private isInLibrary(path: string): boolean {
    const { papersFolder } = this.settings;
    return path === papersFolder || path.startsWith(`${papersFolder}/`);
  }

  private followRename(from: string, to: string): void {
    const result = applyRename(
      {
        inboxFolder: this.settings.inboxFolder,
        papersFolder: this.settings.papersFolder,
        inbox: this.inbox,
      },
      from,
      to,
    );
    const touchesLibrary = this.isInLibrary(from) || this.isInLibrary(to);
    if (result.changed) {
      this.settings.inboxFolder = result.inboxFolder;
      this.settings.papersFolder = result.papersFolder;
      this.inbox = [...result.inbox];
      this.queuePersist();
    }
    // A paper dragged into or out of the library by hand changes the count
    // shown in settings; recounting is local and cheap.
    if (touchesLibrary || result.changed) void this.refreshKeptCount();
  }

  /**
   * Save once for a burst of changes. Renaming a folder reports the folder and
   * then every file inside it, and each would otherwise rewrite the plugin's
   * whole data file.
   */
  private persistQueued = false;
  private queuePersist(): void {
    if (this.persistQueued) return;
    this.persistQueued = true;
    void Promise.resolve().then(async () => {
      this.persistQueued = false;
      await this.persist();
    });
  }

  // --- persistence ---------------------------------------------------------

  private async loadPersisted(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    const savedSettings: Partial<LiteratureInboxSettings> & { includeAuthors?: boolean } =
      data?.settings ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    if (!Object.prototype.hasOwnProperty.call(savedSettings, "propertyDisplay")) {
      this.settings.propertyDisplay =
        savedSettings.tidyProperties === undefined
          ? DEFAULT_SETTINGS.propertyDisplay
          : savedSettings.tidyProperties
            ? "compact"
            : "all";
    }
    if (!Object.prototype.hasOwnProperty.call(savedSettings, "includeSubjects")) {
      this.settings.includeSubjects = savedSettings.subjectPlacement !== "off";
    }
    const savedKernelMode = (savedSettings as { kernelMode?: string }).kernelMode;
    if (savedKernelMode === "snowball") {
      this.settings.kernelMode = "seeds";
      this.settings.kernelExpandSeeds = true;
    } else if (savedKernelMode !== "topic" && savedKernelMode !== "seeds") {
      this.settings.kernelMode = "topic";
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
      "tidyProperties",
      "readStatusEnabled",
      "kernelAuthor",
      "kernelLibraryFolder",
      "subjectPlacement",
      "subjectTopics",
      "subjectKeywords",
      "subjectConcepts",
      "authorPlacement",
    ] as const) {
      delete (this.settings as unknown as Record<string, unknown>)[key];
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
    this.applyPropertyDisplay();
    await this.persist();
  }

  /** Whether a Markdown view is showing an arrival or kept paper. The folders
   * are the source of truth, so styling must not depend on metadata-cache
   * timing or on a particular property surviving a user's edits. */
  private isPaperView(view: MarkdownView): boolean {
    if (!view.file) return false;
    const path = view.file.path;
    return (
      path.startsWith(`${this.settings.inboxFolder}/`) ||
      path.startsWith(`${this.settings.papersFolder}/`)
    );
  }

  private stylePaperView(view: MarkdownView): void {
    const paper = this.isPaperView(view);
    for (const element of [view.containerEl, view.contentEl]) {
      element.classList.toggle(
        HIDDEN_PROPERTIES_CLASS,
        paper && this.settings.propertyDisplay === "hidden",
      );
      element.classList.toggle(
        COMPACT_PROPERTIES_CLASS,
        paper && this.settings.propertyDisplay === "compact",
      );
    }
  }

  /** Obsidian 1.7.2+ restores tabs as DeferredView instances. Loading every
   * hidden tab would defeat that optimization, so only force resolution for
   * the active leaf; other tabs are styled when they become active. */
  private async applyPropertyDisplayToLeaf(leaf: WorkspaceLeaf, resolve: boolean): Promise<void> {
    if (!(leaf.view instanceof MarkdownView) && resolve && "loadIfDeferred" in leaf) {
      await leaf.loadIfDeferred();
    }
    if (leaf.view instanceof MarkdownView) this.stylePaperView(leaf.view);
  }

  /** Apply the chosen presentation to every open Markdown pane. No global
   * Obsidian setting is changed, and non-paper views lose both classes. */
  private applyPropertyDisplay(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      void this.applyPropertyDisplayToLeaf(leaf, leaf === this.app.workspace.activeLeaf);
    });
  }

  private clearPropertyDisplayClasses(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      for (const element of [view.containerEl, view.contentEl]) {
        element.classList.remove(HIDDEN_PROPERTIES_CLASS, COMPACT_PROPERTIES_CLASS);
      }
    });
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
      notify(`Could not refresh: ${errorText(error, Boolean(this.settings.openAlexApiKey.trim()))}`);
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

  /** Reconcile inbox state with the files before any new papers are added —
   * see `core/reconcile.ts` for what counts as kept, moved, or gone. */
  private async reconcileInboxState(vault: VaultIndex): Promise<void> {
    const adapter = this.adapter();
    const inboxNotes = await scanFolderIdentities(
      this.settings.inboxFolder,
      (folder) => adapter.list(folder),
      (path) => adapter.read(path),
      parseNoteIdentity,
    );
    const result = reconcileInbox(this.inbox, inboxNotes, vault, todayIso());
    if (!result.changed) return;

    this.inbox = result.inbox;
    const remembered = new Set(this.previouslyRemoved);
    for (const id of result.removedIds) {
      if (remembered.has(id)) continue;
      remembered.add(id);
      this.previouslyRemoved.push(id);
    }
    await this.persist();
  }

  /**
   * Refuse to run when the inbox and the papers folder overlap. Every rule in
   * this plugin reads a note's folder as "arrival" or "kept", and a folder
   * inside the other makes a note both — arrivals would anchor searches as if
   * kept, and keeping would mean moving a file to where it already is.
   */
  private foldersAreDistinct(): boolean {
    const { inboxFolder, papersFolder } = this.settings;
    if (!foldersOverlap(inboxFolder, papersFolder)) return true;
    notify(
      `The inbox folder ("${inboxFolder}") and the library directory ("${papersFolder}") ` +
        "overlap. Give them separate folders in Literature Inbox settings first.",
      10000,
    );
    return false;
  }

  private updateSettings() {
    return {
      inboxFolder: this.settings.inboxFolder,
      papersFolder: this.settings.papersFolder,
      maxArrivalsPerRun: this.settings.maxArrivalsPerRun,
      includeSubjects: this.settings.includeSubjects,
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
   * *originOf* is populated as a side effect — one entry per fetched work,
   * recording its source label, the row's cap, and the work's place in that
   * source's ranking for reporting and per-source limits.
   */
  private async fetchAll(
    report: UpdateReport,
    vault: VaultIndex,
    originOf: Map<Work, FetchOrigin>,
  ): Promise<Work[]> {
    const works: Work[] = [];
    const globalCap = this.settings.maxArrivalsPerRun;
    // "New" means the same thing for every source — one global window, not a
    // per-row override nobody needs: the whole point of these results is that
    // they're recent, so the value worth tuning is how far back "recent"
    // reaches, and that's a single number for the whole inbox.
    const since = isoDaysAgo(this.settings.newWindowDays);

    for (const [row, source] of this.settings.sources.entries()) {
      if (!isUsable(source)) continue;
      const cap = effective(source.maxPerRun, globalCap);
      const label = describeSource(source);
      try {
        const fetched = await this.fetchFrom(source, since, cap, vault, report);
        // Only a topic search's order carries information (relevance);
        // feeds and citing papers are better ranked by their dates.
        for (const [position, work] of fetched.entries()) {
          const order = source.kind === "topic" ? position : 0;
          originOf.set(work, { label, group: String(row), cap, order });
        }
        works.push(...fetched);
      } catch (error) {
        report.sourceErrors.push({
          source: label,
          message: errorText(error, Boolean(this.settings.openAlexApiKey.trim())),
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
        return this.openAlex().worksCitingSince(anchors, since, candidatePool(cap));
      }

      case "topic":
        return this.openAlex().worksSince(source.value, since, candidatePool(cap));

      case "arxiv":
      case "feed": {
        // A category is just a feed URL the user should not have to know.
        // Every item in the window goes forward, not the first *cap*: those
        // are usually the ones already added last run, and cutting before
        // dedup reported "0 new" while unseen items sat further down.
        const url =
          source.kind === "arxiv" ? arxivCategoryFeedUrl(source.value) : source.value;
        const items = await fetchFeed(this.transport(), url);
        return withinWindow(items, since);
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
      // Past the watchlist window, nothing is asked about again — exact
      // identifiers included. They are cheap per request, but the inbox only
      // grows, and a paper OpenAlex has had a month to index and still shows
      // no link to anything you keep is not going to change on the next run.
      const expired = hasGivenUp(record.arrivedOn, today);
      if (expired && hasExactIdentifier(record.originIds)) continue;
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
        if (expired) {
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
      this.rememberReferences([...record.originIds, ...outcome.newIds], outcome.references);
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

    // Always: `lastBackfillOn` was stamped above, and an unsaved stamp means
    // asking the same paid question again on the next run today.
    await this.persist();
    return { connected, stillWaiting };
  }

  /**
   * Keep a reference list learned after arrival — an arXiv or feed item that
   * OpenAlex indexed later. The note only shows links that resolved today;
   * this is what lets a paper arriving next month be linked back to it.
   */
  private rememberReferences(ids: readonly string[], references: readonly WorkId[]): void {
    const serialized = references.map(serializeId);
    const existing = this.referenceIndex.find((record) => idsIntersect(record.ids, ids));
    if (!existing) {
      this.referenceIndex.push({ ids: [...new Set(ids)], references: serialized });
    } else if (existing.references.length === 0) {
      existing.references = serialized;
    }
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
      // Only records still inside the inbox: one the user just dragged out is
      // settled by the next run, but has already stopped being an arrival.
      inboxCount: this.inbox.filter((record) =>
        record.notePath.startsWith(`${this.settings.inboxFolder}/`),
      ).length,
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

    if (mode === "seeds") {
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
      return this.settings.kernelExpandSeeds ? this.expand(works, size) : works;
    }
    return undefined;
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

  /**
   * Origin ids read straight off these notes' frontmatter, resolved to full
   * works — re-fetched rather than read off disk, because the notes carry
   * identity but not reference lists, and references are the entire point of
   * a snowball. At most *limit* notes are used; `identified` says how many
   * could have been, so a caller can say when it took only some.
   */
  private async seedsFromNotes(
    paths: readonly string[],
    limit = Number.POSITIVE_INFINITY,
  ): Promise<{ works: Work[]; identified: number }> {
    const adapter = this.adapter();
    const originIdSets: string[][] = [];
    for (const path of paths) {
      const content = await adapter.read(path);
      if (content === undefined) continue;
      const identity = parseNoteIdentity(content);
      if (identity?.originIds.length) originIdSets.push(identity.originIds);
    }
    const { openAlexIds, dois } = seedsFromOriginIds(originIdSets, limit);
    if (openAlexIds.length === 0 && dois.length === 0) {
      return { works: [], identified: originIdSets.length };
    }

    const client = this.openAlex();
    const works: Work[] = [];
    if (openAlexIds.length > 0) works.push(...(await client.worksByIds(openAlexIds)));
    if (dois.length > 0) works.push(...(await client.worksByDois(dois)));
    return { works, identified: originIdSets.length };
  }

  /**
   * Expand outward from every paper in one folder of the library — the
   * right-click "Expand outward from papers in this folder". Results land in
   * that folder unless the user picks another, and a large folder uses a
   * bounded number of seeds.
   */
  async expandFromFolder(folder: string, options?: { count?: number; folder?: string }): Promise<void> {
    if (!this.isInLibrary(folder)) {
      notify(`Only folders inside ${this.settings.papersFolder}/ can be expanded from.`);
      return;
    }
    await this.expandFromSelection([], [folder], {
      count: options?.count,
      folder: options?.folder ?? folder,
      subject: describeSelection(0, [folder]),
    });
  }

  /**
   * Expand outward from whatever was right-clicked: notes, folders, or both.
   * Papers picked one by one are all used; a folder can hold hundreds, so
   * once folders are involved the seeds are capped, with hand-picked papers
   * first so they are never the ones left out.
   */
  async expandFromSelection(
    paperPaths: readonly string[],
    folderPaths: readonly string[],
    options: { count?: number; folder?: string; subject: string },
  ): Promise<void> {
    const adapter = this.adapter();
    const paths = new Set(paperPaths);
    for (const folder of folderPaths) {
      for (const path of await adapter.list(folder)) paths.add(path);
    }
    await this.expandFromPaths([...paths], {
      ...options,
      seedLimit: folderPaths.length > 0 ? LIBRARY_SEED_LIMIT : undefined,
    });
  }

  /**
   * Expand outward from specific papers the user picked in the file explorer.
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
    if (files.length === 0 && !this.running) {
      notify(`Select papers in ${this.settings.papersFolder}/ to expand from.`);
      return;
    }
    await this.expandFromPaths(
      files.map((file) => file.path),
      { ...options, subject: describeSelection(files.length, []) },
    );
  }

  private async expandFromPaths(
    paths: readonly string[],
    options: { count?: number; folder?: string; subject: string; seedLimit?: number },
  ): Promise<void> {
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }
    if (paths.length === 0) {
      notify("Nothing to expand from: no notes were found there.");
      return;
    }
    if (!this.foldersAreDistinct()) return;

    this.running = true;
    this.setStatus(`reading ${options.subject}…`);
    const problems: string[] = [];
    // Always inside the library: a paper written anywhere else is invisible
    // to the next update's dedup, which would fetch it straight back.
    const targetFolder = nestUnder(options.folder ?? "", this.settings.papersFolder);
    try {
      const size = options.count ?? this.settings.kernelSize;
      const pool = await this.withSharedClient(
        (error, fetched) =>
          problems.push(
            describeFetchError(error, fetched, Boolean(this.settings.openAlexApiKey.trim())),
          ),
        async () => {
          const { works: seeds, identified } = await this.seedsFromNotes(paths, options.seedLimit);
          if (seeds.length === 0) return [];
          if (options.seedLimit !== undefined && identified > options.seedLimit) {
            notify(`Expanding from the first ${options.seedLimit} of the ${identified} ${options.subject}.`);
          }
          return this.expand(seeds, topicPoolSize(size));
        },
      );
      for (const problem of problems) notify(problem);
      if (pool.length === 0) {
        notify(`None of the ${options.subject} had a usable identifier.`);
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
        includeSubjects: this.settings.includeSubjects,
        inbox: this.inbox,
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
      notify(`Expanded from ${options.subject}: ${parts.join(", ")}.`);
    } catch (error) {
      notify(`Could not expand: ${errorText(error, Boolean(this.settings.openAlexApiKey.trim()))}`);
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
    if (!this.foldersAreDistinct()) return;

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
      const target = this.settings.papersFolder;
      const report = await runKernel({
        works,
        vault,
        papersFolder: target,
        adapter: this.adapter(),
        today: todayIso(),
        includeSubjects: this.settings.includeSubjects,
        inbox: this.inbox,
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
      const parts = [`${report.written.length} papers added to ${target}/`];
      if (report.totalEdges) parts.push(`${report.totalEdges} citation links between them`);
      if (report.skipped) parts.push(`${report.skipped} you already had`);
      notify(`Added to your graph: ${parts.join(", ")}.`);
    } catch (error) {
      notify(`Could not add papers: ${errorText(error, Boolean(this.settings.openAlexApiKey.trim()))}`);
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

    if (!this.foldersAreDistinct()) return;

    this.running = true;
    notify("Literature Inbox: fetching…");
    this.setStatus("fetching…");
    try {
      // One scan of the vault, shared: adjacency selection needs to know what
      // you keep, and so does the dedup pass.
      const vault = await this.vaultIndex();
      await this.reconcileInboxState(vault);
      const preliminary: UpdateReport = { arrived: [], skipped: [], sourceErrors: [] };
      const originOf = new Map<Work, FetchOrigin>();
      const hasKey = Boolean(this.settings.openAlexApiKey.trim());

      // Fetch and backfill share one client, so one rate limiter paces both
      // and a "stop asking" from OpenAlex during the fetch stops the backfill
      // too, instead of it retrying against a spent allowance.
      const { report, backfilled, stillWaiting } = await this.withSharedClient(
        (error, fetched) => {
          const message = describeFetchError(error, fetched, hasKey);
          if (!preliminary.sourceErrors.some((e) => e.message === message)) {
            preliminary.sourceErrors.push({ source: "OpenAlex", message });
          }
        },
        async () => {
          const fetched = await this.fetchAll(preliminary, vault, originOf);
          const capByRow = new Map([...originOf.values()].map((o) => [o.group, o.cap] as const));
          const run = await runUpdate({
            fetched,
            vault,
            inbox: this.inbox,
            settings: {
              ...this.updateSettings(),
              // Each row's own cap is the limit; the total only has to not bite.
              maxArrivalsPerRun: [...capByRow.values()].reduce((sum, cap) => sum + cap, 0),
            },
            adapter: this.adapter(),
            today: todayIso(),
            previouslyRemoved: this.previouslyRemoved,
            sourceFor: (work) => originOf.get(work)?.label ?? "Unknown source",
            capFor: (work) => {
              const origin = originOf.get(work);
              return { group: origin?.group ?? "", cap: origin?.cap ?? this.settings.maxArrivalsPerRun };
            },
            orderFor: (work) => originOf.get(work)?.order ?? 0,
            referenceIndex: this.referenceIndex,
          });

          this.inbox = run.inbox;
          this.settings.lastUpdate = todayIso();
          await this.mergeReferenceRecords(run.newReferenceRecords, vault);

          // arXiv and RSS arrivals land edge-less; OpenAlex usually indexes
          // them within days, so ask again for the ones still isolated.
          this.setStatus("checking isolated arrivals for new connections…");
          const backfill = await this.backfillEdgelessArrivals();
          return { report: run.report, backfilled: backfill.connected, stillWaiting: backfill.stillWaiting };
        },
      );
      report.sourceErrors.push(...preliminary.sourceErrors);

      const parts = [`${report.arrived.length} new`];
      if (report.skipped.length) parts.push(`${report.skipped.length} already known`);
      if (backfilled) parts.push(`${backfilled} newly connected`);
      if (report.retroConnections) {
        parts.push(`${report.retroConnections} older paper(s) now link to today's arrivals`);
      }
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
      notify(`Literature Inbox failed: ${errorText(error, Boolean(this.settings.openAlexApiKey.trim()))}`);
    } finally {
      this.running = false;
      this.setStatus(undefined);
    }
  }

  /** Keeping is a file move — the same thing dragging it in the file explorer
   * does. The command exists for convenience, never as the only way. */
  async keepActiveNote(file: TFile): Promise<void> {
    // Captured first: Obsidian updates a TFile's path in place when it moves,
    // so after the move `file.path` is already the new one.
    const from = file.path;
    const target = `${this.settings.papersFolder}/${file.name}`;
    // Obsidian refuses to move onto an existing file, and the refusal would
    // otherwise surface as nothing at all — the command just seems to fail.
    if (await this.adapter().exists(target)) {
      notify(
        `${this.settings.papersFolder}/ already has a note called "${file.basename}". ` +
          "Rename one of them, or move this one into a subfolder by hand.",
        10000,
      );
      return;
    }
    let moved: boolean;
    try {
      moved = await moveNote(this.app, file.path, target);
    } catch (error) {
      notify(`Could not move that note: ${String(error)}`);
      return;
    }
    if (!moved) {
      notify("Could not move that note.");
      return;
    }
    this.inbox = this.inbox.filter(
      (record) => record.notePath !== from && record.notePath !== target,
    );
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
    if (!this.foldersAreDistinct()) return;

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
          includeSubjects: this.settings.includeSubjects,
          inbox: this.inbox,
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
      notify(`Could not add: ${errorText(error, Boolean(this.settings.openAlexApiKey.trim()))}`);
    } finally {
      this.running = false;
      this.setStatus(undefined);
    }
  }

  /** The single-paper command form. */
  async addById(rawValue: string): Promise<void> {
    await this.addByIds(rawValue, "inbox");
  }

  private doiForFile(file: TFile): string | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter ?? {};
    const property = typeof frontmatter.doi === "string" ? frontmatter.doi.trim() : "";
    if (property) return property.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    if (!Array.isArray(frontmatter["origin-ids"])) return undefined;
    return (frontmatter["origin-ids"] as unknown[])
      .find((id): id is string => typeof id === "string" && id.startsWith("doi:"))
      ?.slice("doi:".length);
  }

  private async copyDoi(doi: string): Promise<void> {
    await navigator.clipboard.writeText(doi);
    notify(`Copied DOI ${doi}.`);
  }

  /** Validate a feed-like source before it is added to settings. */
  async validateSource(kind: SourceConfig["kind"], value: string): Promise<boolean> {
    if (kind !== "feed" && kind !== "arxiv") return true;
    if (kind === "arxiv" && !looksLikeArxivCategory(value)) {
      notify(`"${value}" is not an arXiv category name.`);
      return false;
    }
    const url = kind === "arxiv" ? arxivCategoryFeedUrl(value) : value;
    notify(`Checking ${kind === "arxiv" ? value : "feed"}…`);
    try {
      const works = await fetchFeed(this.transport(), url, { maxRetries: 0 });
      const newest = newestItem(works);
      const detail = newest?.title ? ` Most recent: ${newest.title}.` : "";
      notify(`Source is reachable (${works.length} item(s)).${detail}`);
      return true;
    } catch (error) {
      notify(`Could not add source: ${String(error)}`);
      return false;
    }
  }

  /** Preview a topic query before building a starting graph from it. */
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
      const matches = await client.topicMatches(topic);
      this.topicPreviewCache = { topic, size, works: pool };
      // Same selection Build would apply, so the preview's connectivity
      // number describes the real outcome, not just the raw top-cited
      // handful.
      const selected = selectTopicCandidates(pool, size);
      const connectivity = estimateConnectivity(selected);
      new PreviewModal(this.app, topic, selected, matches, connectivity).open();
    } catch (error) {
      notify(describeFetchError(error, 0, Boolean(this.settings.openAlexApiKey.trim())));
    }
  }
}

/** What an expansion starts from, as a phrase for menus and notices: "this
 * paper", "3 papers", "papers in Papers/Ions/", "2 papers and 1 folder". */
function describeSelection(paperCount: number, folders: readonly string[]): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (folders.length === 0) return paperCount === 1 ? "this paper" : count(paperCount, "paper");
  if (paperCount === 0) {
    return folders.length === 1 ? `papers in ${folders[0]}/` : `papers in ${count(folders.length, "folder")}`;
  }
  return `${count(paperCount, "paper")} and ${count(folders.length, "folder")}`;
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
    if (report.heldBack && report.arrived.length > 0) {
      notes.push(
        `${report.heldBack} more new paper(s) were over their source's "Papers per run" — ` +
          "the best-connected and most relevant went first. Raise it on a source row to see " +
          "more each update.",
      );
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

/** What a feed actually returned, per URL — a count alone doesn't tell you
 * whether you subscribed to the right thing. */
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
    /** What is being expanded, as a phrase: "3 paper(s)", "papers in X/". */
    private readonly subject: string,
    defaultCount: number,
    defaultFolder: string,
    private readonly onSubmit: ExpandRun,
  ) {
    super(app);
    this.count = defaultCount;
    this.folder = defaultFolder;
  }

  override onOpen(): void {
    this.setTitle(`Expand outward from ${this.subject}`);

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
        "Where the expanded papers are written. A folder name outside your library " +
          "directory is placed inside it, so later updates still recognise these papers.",
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
    private readonly matches: TopicTermMatch[],
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
    // Say how each term was read. A field match is what makes "most cited"
    // mean "most cited in your field", and a wrong one used to be silent.
    const matched = this.matches.filter((m) => m.concept && m.concept.name !== m.term);
    if (matched.length > 0) {
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Matched to OpenAlex fields: " +
          matched.map((m) => `"${m.term}" → ${m.concept?.name}`).join(", ") +
          ".",
      });
    }
    const unresolved = this.matches.filter((m) => !m.concept).map((m) => `"${m.term}"`);
    if (unresolved.length > 0) {
      this.contentEl.createEl("p", {
        text:
          `OpenAlex has no field named ${unresolved.join(", ")}, so that part of the query ` +
          "is searched as an exact phrase in titles and abstracts instead. Papers that use " +
          "the phrase in another sense can appear — check the list below, or try the name " +
          "of the field as OpenAlex spells it.",
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
