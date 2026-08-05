import { PluginSettingTab, Setting, type App } from "obsidian";
import type LiteratureInboxPlugin from "./main";

export interface LiteratureInboxSettings {
  /** Where arrivals land. Keeping them in one folder is what makes "moving a
   * note out" a usable keep signal. */
  inboxFolder: string;
  /** Where kept papers go — the same folder zot2vault writes, so a kept note
   * gets upgraded in place if that paper later enters Zotero. */
  papersFolder: string;

  openAlexEnabled: boolean;
  openAlexTopic: string;
  arxivEnabled: boolean;
  arxivCategories: string;
  rssEnabled: boolean;
  rssFeeds: string;

  /** How many top-cited papers the kernel run seeds the papers folder with. */
  kernelSize: number;

  maxArrivalsPerRun: number;
  keepWindowDays: number;
  /** Off by default: nothing is ever removed until you say so. */
  pruneEnabled: boolean;

  /** Optional OpenAlex polite-pool address. Blank by default — never a
   * hardcoded developer email. */
  mailto: string;
  /** Path to a zot2vault executable the user downloaded themselves. Blank by
   * default; the plugin never ships or fetches a binary. */
  zot2vaultPath: string;

  lastUpdate?: string;
}

export const DEFAULT_SETTINGS: LiteratureInboxSettings = {
  inboxFolder: "Inbox",
  papersFolder: "Papers",
  openAlexEnabled: true,
  openAlexTopic: "",
  arxivEnabled: false,
  arxivCategories: "",
  rssEnabled: false,
  rssFeeds: "",
  kernelSize: 100,
  maxArrivalsPerRun: 25,
  keepWindowDays: 30,
  pruneEnabled: false,
  mailto: "",
  zot2vaultPath: "",
};

/** Split a comma/newline separated setting into clean entries. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parse a positive integer setting, falling back rather than storing NaN. */
function parseCount(value: string, fallback: number, min = 1): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export class LiteratureInboxSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LiteratureInboxPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderGettingStarted(containerEl);
    this.renderFolders(containerEl);
    this.renderSources(containerEl);
    this.renderArrivals(containerEl);
    this.renderCleanup(containerEl);
    this.renderIntegrations(containerEl);
  }

  /**
   * The top of the settings page is a first-run path, not a preference dump.
   * A new user's real question is "what do I do now", and the honest answer
   * is: name your field, build a starting graph, then update. Ordering the
   * page that way is most of the onboarding.
   */
  private renderGettingStarted(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Getting started").setHeading();

    const status = this.plugin.status();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `${status.keptCount} papers in your library · ${status.inboxCount} in the inbox` +
        (status.lastUpdate ? ` · last updated ${status.lastUpdate}` : " · never updated"),
    });

    new Setting(containerEl)
      .setName("1. What do you work on?")
      .setDesc(
        'A topic query — "quantum error correction", "machine translation" — or an ' +
          "OpenAlex concept id like C41008148. Everything else keys off this.",
      )
      .addText((text) =>
        text
          .setPlaceholder("quantum error correction")
          .setValue(this.plugin.settings.openAlexTopic)
          .onChange(async (value) => {
            this.plugin.settings.openAlexTopic = value;
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Preview")
          .setTooltip("Show the top few papers, to check the query matches your field")
          .onClick(() => void this.plugin.previewTopic()),
      );

    new Setting(containerEl)
      .setName("2. Build your starting graph")
      .setDesc(
        `Fetches the ${this.plugin.settings.kernelSize} most-cited papers on that topic ` +
          `into ${this.plugin.settings.papersFolder}/, wired to each other by citations. ` +
          "New arrivals connect to this core — without it every arrival looks equally " +
          "unfamiliar. Safe to run again later; it skips anything you already have.",
      )
      .addButton((button) =>
        button
          .setButtonText("Build starting graph")
          .setCta()
          .onClick(() => void this.plugin.buildKernel()),
      );

    new Setting(containerEl)
      .setName("Starting graph size")
      .setDesc("More papers means a denser core, but a longer first run.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.kernelSize)).onChange(async (value) => {
          this.plugin.settings.kernelSize = parseCount(value, DEFAULT_SETTINGS.kernelSize);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("3. Fetch new papers")
      .setDesc(
        "Run this whenever you like — there is no background fetching. Keep a paper " +
          `by moving its note out of ${this.plugin.settings.inboxFolder}/ into ` +
          `${this.plugin.settings.papersFolder}/.`,
      )
      .addButton((button) =>
        button.setButtonText("Update inbox now").onClick(() => void this.plugin.updateInbox()),
      );
  }

  private renderFolders(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Folders").setHeading();

    new Setting(containerEl)
      .setName("Inbox folder")
      .setDesc("Where new arrivals are written. Move a note out of here to keep it.")
      .addText((text) =>
        text
          .setPlaceholder("Inbox")
          .setValue(this.plugin.settings.inboxFolder)
          .onChange(async (value) => {
            this.plugin.settings.inboxFolder = value.trim() || DEFAULT_SETTINGS.inboxFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Papers folder")
      .setDesc(
        "Your kept papers, and where the starting graph is built. If you also use " +
          "zot2vault, point this at the same folder it writes to — a kept note is then " +
          "upgraded in place if that paper later enters your Zotero library.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Papers")
          .setValue(this.plugin.settings.papersFolder)
          .onChange(async (value) => {
            this.plugin.settings.papersFolder = value.trim() || DEFAULT_SETTINGS.papersFolder;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Where new papers come from").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Updates only run when you ask for them. Each source is capped per run, so a " +
          "broad query can't flood your vault.",
    });

    new Setting(containerEl)
      .setName("OpenAlex")
      .setDesc(
        "Recent papers on your topic. The best source for citation edges, because " +
          "OpenAlex publishes reference lists.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openAlexEnabled).onChange(async (value) => {
          this.plugin.settings.openAlexEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("arXiv categories")
      .setDesc(
        "The freshest STEM stream — papers appear here days before OpenAlex indexes " +
          "them, so they arrive without citations and get connected on a later run. " +
          "Comma separated, e.g. cs.CL, quant-ph",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.arxivEnabled).onChange(async (value) => {
          this.plugin.settings.arxivEnabled = value;
          await this.plugin.saveSettings();
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder("cs.CL, quant-ph")
          .setValue(this.plugin.settings.arxivCategories)
          .onChange(async (value) => {
            this.plugin.settings.arxivCategories = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("RSS / Atom feeds")
      .setDesc(
        "Journal tables of contents, bioRxiv, Scholar alerts — any feed URL, one per " +
          "line. A DOI is resolved for each item where possible, so feed items still " +
          "get citation edges instead of arriving as isolated dots.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.rssEnabled).onChange(async (value) => {
          this.plugin.settings.rssEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Feed URLs")
      .addTextArea((text) =>
        text
          .setPlaceholder("https://example.org/journal/feed.xml")
          .setValue(this.plugin.settings.rssFeeds)
          .onChange(async (value) => {
            this.plugin.settings.rssFeeds = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderArrivals(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Arrivals").setHeading();

    new Setting(containerEl)
      .setName("Maximum arrivals per run")
      .setDesc("A ceiling on how much any single update can add.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxArrivalsPerRun)).onChange(async (value) => {
          this.plugin.settings.maxArrivalsPerRun = parseCount(
            value,
            DEFAULT_SETTINGS.maxArrivalsPerRun,
          );
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderCleanup(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Cleanup").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Cleanup only ever touches notes that are still in the inbox, still exactly as " +
        "they were generated, and past the keep window. It shows you the list first, " +
        "and moves them to Obsidian's trash rather than deleting them. Anything you " +
        "edited, moved, or wrote yourself is untouchable.",
    });

    new Setting(containerEl)
      .setName("Keep window (days)")
      .setDesc("How long an untouched arrival sits in the inbox before it can be cleaned up.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.keepWindowDays)).onChange(async (value) => {
          this.plugin.settings.keepWindowDays = parseCount(
            value,
            DEFAULT_SETTINGS.keepWindowDays,
            0,
          );
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Allow cleanup")
      .setDesc("When off, nothing is ever removed.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pruneEnabled).onChange(async (value) => {
          this.plugin.settings.pruneEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Clean up now")
      .setDesc("Shows what would be removed and asks before doing anything.")
      .addButton((button) =>
        button.setButtonText("Preview cleanup").onClick(() => void this.plugin.cleanUp()),
      );
  }

  private renderIntegrations(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Network and integrations").setHeading();

    new Setting(containerEl)
      .setName("Email for OpenAlex (optional)")
      .setDesc(
        "OpenAlex needs no account. Supplying an address puts your requests in their " +
          "faster 'polite pool'. It is sent only to openalex.org.",
      )
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.mailto)
          .onChange(async (value) => {
            this.plugin.settings.mailto = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("zot2vault program (optional, desktop only)")
      .setDesc(
        "If you mirror a Zotero library with zot2vault, point this at the program you " +
          "downloaded to rebuild those notes without leaving Obsidian. This plugin " +
          "never downloads or bundles any program; leave blank if you don't use it.",
      )
      .addText((text) =>
        text
          .setPlaceholder("C:\\Tools\\zot2vault.exe")
          .setValue(this.plugin.settings.zot2vaultPath)
          .onChange(async (value) => {
            this.plugin.settings.zot2vaultPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
