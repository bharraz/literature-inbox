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
import { DEFAULT_RECENCY_WINDOW_DAYS, isoDaysAgo } from "./core/dates";
import { OpenAlexClient } from "./core/openalex";
import { backfillDois, fetchFeed } from "./core/rss";
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
import { backfillReferences, type BackfillCandidate } from "./core/backfill";
import { CitationIndex } from "./core/citations";
import { appendCitations } from "./core/notes";
import { contentHash } from "./core/hash";
import { runExecutable, type Spawner } from "./core/launcher";
import { runKernel } from "./core/kernel";
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
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default class LiteratureInboxPlugin extends Plugin {
  override settings: LiteratureInboxSettings = { ...DEFAULT_SETTINGS };
  private inbox: InboxRecord[] = [];
  private running = false;
  /** Papers in the kept folder, refreshed on load and after a kernel run —
   * shown in settings so the plugin's state is legible at a glance. */
  private keptCount = 0;

  override async onload(): Promise<void> {
    await this.loadPersisted();
    // Cheap, local, and no network: just counts what's on disk.
    this.keptCount = (await this.adapter().list(this.settings.papersFolder)).length;
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
      name: "Build starting graph (top-cited papers on your topic)",
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
    this.inbox = Array.isArray(data?.inbox) ? (data?.inbox as InboxRecord[]) : [];
  }

  private async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, inbox: this.inbox } satisfies PersistedData);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  // --- shared helpers ------------------------------------------------------

  private transport() {
    return new ObsidianTransport();
  }

  private openAlex(): OpenAlexClient {
    return new OpenAlexClient(this.transport(), { mailto: this.settings.mailto || undefined });
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
    };
  }

  // --- fetching ------------------------------------------------------------

  private async fetchAll(report: UpdateReport): Promise<Work[]> {
    const works: Work[] = [];
    const perSource = this.settings.maxArrivalsPerRun;

    if (this.settings.openAlexEnabled && this.settings.openAlexTopic.trim()) {
      try {
        // A fixed window back from today, never `topWorks` and never "since you
        // last ran". `topWorks` returns the most-cited papers on the topic —
        // exactly what a kernel run just seeded — so using it here reported
        // "0 new" on every first update, guaranteed. And anchoring on
        // `lastUpdate` narrows the window to nothing on a second run the same
        // day. The window overlaps previous runs on purpose: dedup is exact
        // and cheap, so re-seeing a paper costs nothing and missing one is
        // permanent.
        const since = isoDaysAgo(DEFAULT_RECENCY_WINDOW_DAYS);
        works.push(
          ...(await this.openAlex().worksSince(this.settings.openAlexTopic, since, perSource)),
        );
      } catch (error) {
        report.sourceErrors.push({ source: "OpenAlex", message: String(error) });
      }
    }

    if (this.settings.arxivEnabled) {
      const client = new ArxivClient(this.transport());
      for (const category of splitList(this.settings.arxivCategories)) {
        try {
          works.push(...(await client.categoryFeed(category, perSource)));
        } catch (error) {
          report.sourceErrors.push({ source: `arXiv ${category}`, message: String(error) });
        }
      }
    }

    if (this.settings.rssEnabled) {
      const feedWorks: Work[] = [];
      for (const url of splitList(this.settings.rssFeeds)) {
        try {
          feedWorks.push(...(await fetchFeed(this.transport(), url)));
        } catch (error) {
          report.sourceErrors.push({ source: url, message: String(error) });
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

    for (const record of this.inbox) {
      const content = await adapter.read(record.notePath);
      if (content === undefined) continue;
      if (contentHash(content) !== record.contentHash) continue; // user edited it
      candidates.push({
        notePath: record.notePath,
        originIds: record.originIds,
        title: record.title,
        hasEdges: content.includes("## Citations"),
      });
    }
    if (candidates.length === 0) return 0;

    let outcomes;
    try {
      outcomes = await backfillReferences(candidates, this.openAlex(), titlesMatch);
    } catch {
      return 0; // backfill is an improvement on what's there, never a blocker
    }
    if (outcomes.length === 0) return 0;

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
  async buildKernel(): Promise<void> {
    if (this.running) {
      notify("Literature Inbox is already running.");
      return;
    }
    const topic = this.settings.openAlexTopic.trim();
    if (!topic) {
      notify("Set a topic in Literature Inbox settings first.");
      return;
    }

    this.running = true;
    const size = this.settings.kernelSize;
    notify(`Fetching the ${size} most-cited papers on "${topic}"… this can take a minute.`);
    try {
      const works = await this.openAlex().topWorks(topic, size);
      if (works.length === 0) {
        notify(`No papers found for "${topic}". Try a broader query.`);
        return;
      }

      const report = await runKernel({
        works,
        vault: await this.vaultIndex(),
        papersFolder: this.settings.papersFolder,
        adapter: this.adapter(),
        today: todayIso(),
      });

      this.keptCount += report.written.length;
      const parts = [`${report.written.length} papers added to ${this.settings.papersFolder}/`];
      if (report.totalEdges) parts.push(`${report.totalEdges} citation links between them`);
      if (report.skipped) parts.push(`${report.skipped} you already had`);
      notify(`Starting graph built: ${parts.join(", ")}.`);
    } catch (error) {
      notify(`Could not build the starting graph: ${String(error)}`);
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
      const preliminary: UpdateReport = { arrived: [], skipped: [], sourceErrors: [] };
      const fetched = await this.fetchAll(preliminary);

      const { report, inbox } = await runUpdate({
        fetched,
        vault: await this.vaultIndex(),
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
    notify(`Kept — moved to ${this.settings.papersFolder}/.`);
  }

  async addById(rawValue: string): Promise<void> {
    const value = rawValue.trim();
    if (!value) return;
    try {
      const isArxiv = !value.toLowerCase().startsWith("10.");
      const work = isArxiv
        ? await new ArxivClient(this.transport()).workById(value)
        : await this.openAlex().workByDoi(value);
      if (!work) {
        notify(`Nothing found for ${value}.`);
        return;
      }
      const { report, inbox } = await runUpdate({
        fetched: [work],
        vault: await this.vaultIndex(),
        inbox: this.inbox,
        settings: this.updateSettings(),
        adapter: this.adapter(),
        today: todayIso(),
      });
      if (report.skipped.length > 0) {
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
      notify(`Added ${work.title ?? value}.`);
    } catch (error) {
      notify(`Could not add ${value}: ${String(error)}`);
    }
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
      notify("Cleanup is off. Enable it in Literature Inbox settings first.");
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
