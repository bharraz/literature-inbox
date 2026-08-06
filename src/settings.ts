import { PluginSettingTab, Setting, type App } from "obsidian";
import { DEFAULT_RECENCY_WINDOW_DAYS } from "./core/dates";
import { emptyFeed, type FeedConfig } from "./core/feeds";
import type LiteratureInboxPlugin from "./main";

/**
 * Ways to build the starting graph. Ordered as the dropdown shows them:
 * cheapest input first, most personal last.
 */
export type KernelMode = "topic" | "seeds" | "snowball" | "author" | "library";

export const KERNEL_MODE_LABELS: Record<KernelMode, string> = {
  topic: "Top-cited papers on a topic",
  seeds: "A list of papers I paste",
  snowball: "Papers I paste, plus connected citations",
  author: "Everything by one author",
  library: "Expand outward from papers I already have",
};

/** Which question an update asks OpenAlex. */
export type ArrivalSelection = "both" | "adjacent" | "topic";

export const ARRIVAL_SELECTION_LABELS: Record<ArrivalSelection, string> = {
  both: "Both (recommended)",
  adjacent: "Papers citing my library",
  topic: "Papers matching my topic",
};

export interface LiteratureInboxSettings {
  /** Where arrivals land. Keeping them in one folder is what makes "moving a
   * note out" a usable keep signal. */
  inboxFolder: string;
  /** Where kept papers go — the same folder zot2vault writes, so a kept note
   * gets upgraded in place if that paper later enters Zotero. */
  papersFolder: string;

  openAlexEnabled: boolean;
  openAlexTopic: string;
  /**
   * How OpenAlex arrivals are chosen. `adjacent` asks what recently cited the
   * papers you keep, so every arrival is connected by construction; `topic`
   * matches a query and hopes an edge exists.
   */
  arrivalSelection: ArrivalSelection;
  arxivEnabled: boolean;
  arxivCategories: string;
  rssEnabled: boolean;
  /** One row per feed, each able to override the global window and cap. */
  feeds: FeedConfig[];
  /** Pre-rows format, read once on load and migrated into `feeds`. */
  rssFeeds?: string;

  /** How many top-cited papers the kernel run seeds the papers folder with. */
  kernelSize: number;

  /**
   * How the starting graph gets built. `topic` needs no input and gives you
   * the field's canon; the others start from papers or people the user names
   * and give them their own neighbourhood instead.
   */
  kernelMode: KernelMode;
  /** Pasted DOIs / arXiv ids, for the `seeds` and `snowball` modes. */
  kernelSeeds: string;
  /** OpenAlex author id, ORCID, or name, for the `author` mode. */
  kernelAuthor: string;

  /**
   * What "new" means, in days back from today. The user's definition, not
   * "since you last ran" — that returns an empty inbox on day one and on any
   * second run the same day, both of which read as a broken plugin.
   */
  newWindowDays: number;

  maxArrivalsPerRun: number;

  /**
   * Whether to write `_Inbox.md`.
   *
   * Off by default, because it actively harms the thing it sits next to: the
   * page wikilinks every arrival, so in the graph it becomes a hub node that
   * wires all arrivals to each other and pulls them into a star around a file
   * that means nothing. That competes with the citation edges the whole plugin
   * exists to show. The inbox folder, sorted by date, is already the list.
   */
  inboxPageEnabled: boolean;

  /** Where OpenAlex's subject terms go in a generated note, if anywhere. */
  subjectPlacement: "off" | "property" | "tags";
  subjectTopics: boolean;
  subjectKeywords: boolean;
  subjectConcepts: boolean;

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
  arrivalSelection: "both",
  arxivEnabled: false,
  arxivCategories: "",
  rssEnabled: false,
  feeds: [],
  kernelSize: 100,
  kernelMode: "topic",
  kernelSeeds: "",
  kernelAuthor: "",
  newWindowDays: DEFAULT_RECENCY_WINDOW_DAYS,
  maxArrivalsPerRun: 25,
  inboxPageEnabled: false,
  // Terms as a property by default, never as tags: tags show up in the tag
  // pane and the graph, and a vault-wide dump of machine-assigned subject
  // terms is exactly the clutter people rightly fear. Concepts stays off for
  // the same reason — it is the broadest and noisiest of the three.
  subjectPlacement: "property",
  subjectTopics: true,
  subjectKeywords: true,
  subjectConcepts: false,
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
  /** Scratch state for the bulk-add box: deliberately not persisted. */
  private manualAdd = "";
  private manualAddTarget: "inbox" | "papers" = "papers";

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
    this.renderInboxPageSetting(containerEl);
    this.renderNoteContent(containerEl);
    this.renderAddByHand(containerEl);
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

    this.renderBudget(containerEl);

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

    this.renderStartingGraph(containerEl);

    new Setting(containerEl).setName("3. Set up the graph (once, 30 seconds)").setHeading();
    const graph = containerEl.createEl("div", { cls: "setting-item-description" });
    graph.createEl("p", {
      text:
        "The plugin writes notes; Obsidian draws the graph. Out of the box every note in " +
        "the vault shows up and arrivals look like everything else. In graph view, open " +
        "its settings (the slider icon) and:",
    });
    const steps = graph.createEl("ol");
    steps.createEl("li", {
      text:
        `Filters → search: path:${this.plugin.settings.inboxFolder} OR ` +
        `path:${this.plugin.settings.papersFolder}`,
    });
    steps.createEl("li", {
      text:
        `Groups → New group: path:${this.plugin.settings.inboxFolder} in a bright colour, ` +
        `then a second group for path:${this.plugin.settings.papersFolder} in a muted one.`,
    });
    graph.createEl("p", {
      text:
        "New papers are then the bright dots and your library is the background they wire " +
        "into. Colour by path rather than by tag: notes carry no inbox/kept tag on " +
        "purpose, because a tag written when the note is generated cannot follow a file " +
        "you later drag into another folder.",
    });
    graph.createEl("p", {
      text:
        "Once you are reading regularly, a third group is worth adding: tag your own " +
        "favourites (#favourite, #to-read, whatever you use) and give that group its own " +
        "colour. Those tags are yours, they follow the note anywhere, and the plugin " +
        "never touches them.",
    });

    new Setting(containerEl)
      .setName("4. Fetch new papers")
      .setDesc(
        "Run this whenever you like — there is no background fetching. Keep a paper " +
          `by moving its note out of ${this.plugin.settings.inboxFolder}/ into ` +
          `${this.plugin.settings.papersFolder}/.`,
      )
      .addButton((button) =>
        button.setButtonText("Update inbox now").onClick(() => void this.plugin.updateInbox()),
      );
  }

  /**
   * The starting graph, in five flavours.
   *
   * Only the input the chosen mode actually needs is shown — five modes with
   * every field visible at once is exactly the settings-page clutter this is
   * meant to avoid. Changing the mode re-renders the tab, which is cheap and
   * keeps the page honest about what it will use.
   */
  /**
   * OpenAlex's daily allowance, as a bar.
   *
   * Deliberately in requests rather than currency: the allowance is metered,
   * but the user pays nothing, and a dollar figure implies a bill that does
   * not exist. Placed here because the expensive actions — building a graph,
   * snowballing — are two clicks below it.
   */
  private renderBudget(containerEl: HTMLElement): void {
    const budget = this.plugin.budgetGauge();
    const wrapper = containerEl.createDiv({ cls: "setting-item-description" });

    const bar = wrapper.createDiv();
    bar.style.height = "6px";
    bar.style.borderRadius = "3px";
    bar.style.background = "var(--background-modifier-border)";
    bar.style.overflow = "hidden";
    bar.style.margin = "4px 0";

    const fill = bar.createDiv();
    fill.style.height = "100%";
    fill.style.width = `${Math.round(budget.fraction * 100)}%`;
    fill.style.background =
      budget.fraction > 0.9
        ? "var(--text-error)"
        : budget.fraction > 0.6
          ? "var(--text-warning)"
          : "var(--interactive-accent)";

    wrapper.createEl("p", {
      cls: "setting-item-description",
      text:
        `OpenAlex daily allowance: ${budget.label}. ` +
        (budget.fraction > 0.9
          ? "Nearly used up — it resets at midnight UTC."
          : "Resets at midnight UTC."),
    });
  }

  private renderStartingGraph(containerEl: HTMLElement): void {
    const mode = this.plugin.settings.kernelMode;

    new Setting(containerEl)
      .setName("2. Add papers to your graph")
      .setDesc(
        `Writes papers into ${this.plugin.settings.papersFolder}/, wired to each other by ` +
          "citations. New arrivals connect to this core — without it every arrival looks " +
          "equally unfamiliar. Safe to run again later; it skips anything you already have.",
      )
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(KERNEL_MODE_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(mode).onChange(async (value) => {
          this.plugin.settings.kernelMode = value as KernelMode;
          await this.plugin.saveSettings();
          this.display(); // show the input this mode needs, hide the rest
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Add papers")
          .setCta()
          .onClick(() => void this.plugin.buildKernel()),
      );

    if (mode === "topic") {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          `Uses the topic above. You get the field's canon — the papers everything else ` +
          "cites — which needs no input but is not specific to you. If your graph looks " +
          "like a stranger's, try one of the other modes.",
      });
    }

    if (mode === "seeds" || mode === "snowball") {
      new Setting(containerEl)
        .setName("Papers to start from")
        .setDesc(
          "DOIs or arXiv ids, one per line — paste a bibliography, your own reference " +
            "list, or a handful of papers that define what you work on. Full URLs are " +
            "fine. Anything unrecognised is reported, never silently skipped." +
            (mode === "snowball"
              ? " Each one is expanded with what it cites and what cites it, so a few " +
                "papers become a neighbourhood."
              : ""),
        )
        .addTextArea((text) =>
          text
            .setPlaceholder("10.1103/PhysRevA.101.032330\n2401.12345")
            .setValue(this.plugin.settings.kernelSeeds)
            .onChange(async (value) => {
              this.plugin.settings.kernelSeeds = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    if (mode === "author") {
      new Setting(containerEl)
        .setName("Author")
        .setDesc(
          "An OpenAlex author id (A5023888391) or an ORCID is exact. A plain name is a " +
            "search, so it can merge two people who share one — check the result.",
        )
        .addText((text) =>
          text
            .setPlaceholder("0000-0002-1825-0097")
            .setValue(this.plugin.settings.kernelAuthor)
            .onChange(async (value) => {
              this.plugin.settings.kernelAuthor = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    if (mode === "library") {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          `Takes the papers already in ${this.plugin.settings.papersFolder}/ — whether you ` +
          "kept them here or zot2vault wrote them — and pulls in what they cite and what " +
          "cites them. The most personal starting graph available, and it needs no typing. " +
          "Does nothing if that folder is empty.",
      });
    }

    new Setting(containerEl)
      .setName("How many papers to add")
      .setDesc(
        mode === "seeds"
          ? "Ignored in this mode: you get exactly the papers you pasted."
          : "More papers means a denser core, but a longer first run.",
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.kernelSize)).onChange(async (value) => {
          this.plugin.settings.kernelSize = parseCount(value, DEFAULT_SETTINGS.kernelSize);
          await this.plugin.saveSettings();
        }),
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
      .setName("What counts as new")
      .setDesc(
        "How many days back an update looks. Counted from when a paper was indexed, " +
          "not when it was published — indexing lags publication by weeks, and a " +
          "window on publication date silently skips anything indexed late. Runs " +
          "overlap on purpose; papers you already have are recognised and skipped.",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_RECENCY_WINDOW_DAYS))
          .setValue(String(this.plugin.settings.newWindowDays))
          .onChange(async (value) => {
            this.plugin.settings.newWindowDays = parseCount(
              value,
              DEFAULT_SETTINGS.newWindowDays,
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Which papers OpenAlex should look for")
      .setDesc(
        '"Papers citing my library" asks what has recently cited the papers in ' +
          `${this.plugin.settings.papersFolder}/ — so every arrival is connected to ` +
          "something you kept, rather than merely matching a query. It needs a starting " +
          "graph to work from. Topic search covers the rest of the field, including work " +
          "that has not cited you yet. Both is usually right; when the per-run cap bites, " +
          "citing papers are kept first.",
      )
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(ARRIVAL_SELECTION_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.arrivalSelection).onChange(async (value) => {
          this.plugin.settings.arrivalSelection = value as ArrivalSelection;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("OpenAlex")
      .setDesc(
        "The best source for citation edges, because OpenAlex publishes reference " +
          "lists. Turning this off disables both selections above.",
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
      )
      .addButton((button) =>
        button
          .setButtonText("Test categories")
          .setTooltip("Fetch each category once — a misspelled one returns nothing, silently")
          .onClick(() => void this.plugin.testArxivCategories()),
      );

    new Setting(containerEl)
      .setName("RSS / Atom feeds — the fastest source")
      .setDesc(
        "Recommended. Journal tables of contents, bioRxiv, Scholar alerts — any feed " +
          "URL, one per line. Feeds carry a paper the day it appears, well before " +
          "OpenAlex indexes it, so this is the quickest way to a non-empty inbox. A " +
          "DOI is resolved for each item where possible, so feed items still get " +
          "citation edges instead of arriving as isolated dots.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.rssEnabled).onChange(async (value) => {
          this.plugin.settings.rssEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    this.renderFeedRows(containerEl);
  }

  /**
   * One row per feed, rather than one textarea of URLs.
   *
   * Feeds are genuinely heterogeneous — a weekly journal table of contents and
   * a daily preprint firehose want different windows and different caps — so
   * the per-feed overrides have somewhere to live. Both are blank by default
   * and inherit the global settings, so a user who doesn't care sees only a
   * URL box and never fills anything else in.
   */
  private renderFeedRows(containerEl: HTMLElement): void {
    const feeds = this.plugin.settings.feeds;

    if (feeds.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No feeds yet. Add one below — a journal's table of contents is a good start.",
      });
    }

    feeds.forEach((feed, index) => {
      const row = new Setting(containerEl)
        .setName(`Feed ${index + 1}`)
        .addToggle((toggle) =>
          toggle
            .setValue(feed.enabled)
            .setTooltip("Fetch this feed on an update")
            .onChange(async (value) => {
              feed.enabled = value;
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder("https://example.org/journal/feed.xml")
            .setValue(feed.url)
            .onChange(async (value) => {
              feed.url = value.trim();
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder(`${this.plugin.settings.newWindowDays}d`)
            .setValue(feed.windowDays === undefined ? "" : String(feed.windowDays))
            .onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              feed.windowDays =
                value.trim() === "" || !Number.isFinite(parsed) || parsed < 0
                  ? undefined
                  : parsed;
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder(`max ${this.plugin.settings.maxArrivalsPerRun}`)
            .setValue(feed.maxPerRun === undefined ? "" : String(feed.maxPerRun))
            .onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              feed.maxPerRun =
                value.trim() === "" || !Number.isFinite(parsed) || parsed < 1
                  ? undefined
                  : parsed;
              await this.plugin.saveSettings();
            }),
        );

      row
        .addButton((button) =>
          button
            .setButtonText("Test")
            .setTooltip("Fetch this feed once and report what came back")
            .onClick(() => void this.plugin.testFeeds(feed.url)),
        )
        .addButton((button) =>
          button
            .setButtonText("Remove")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.feeds.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            }),
        );

      row.setDesc(
        index === 0
          ? "URL, then how many days back count as new for this feed, then its cap " +
              "per run. Leave the last two blank to inherit the global settings."
          : "",
      );
    });

    new Setting(containerEl)
      .addButton((button) =>
        button.setButtonText("Add feed").onClick(async () => {
          this.plugin.settings.feeds.push(emptyFeed());
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Test all")
          .setTooltip("Fetch every feed once — a dead feed is otherwise indistinguishable " +
            "from a quiet one")
          .onClick(() => void this.plugin.testFeeds()),
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

  /**
   * Adding papers by hand, in bulk.
   *
   * The same control the command palette offers, except it takes a list and
   * lets you say where the papers land. Not persisted between sessions: this
   * is a scratch input, and saving it would mean the plugin quietly kept a
   * list you pasted once.
   */
  private renderAddByHand(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Add papers by hand").setHeading();

    new Setting(containerEl)
      .setName("DOIs or arXiv ids")
      .setDesc(
        "One per line. Full URLs are fine. Papers added this way are never touched by " +
          "cleanup — you asked for them on purpose.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("10.1103/PhysRevA.101.032330\nhttps://arxiv.org/abs/2401.12345")
          .setValue(this.manualAdd)
          .onChange((value) => {
            this.manualAdd = value;
          }),
      );

    new Setting(containerEl)
      .setName("Add them to")
      .setDesc(
        `${this.plugin.settings.papersFolder}/ for papers you already know you want — ` +
          `${this.plugin.settings.inboxFolder}/ if you still want to triage them.`,
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("papers", `${this.plugin.settings.papersFolder}/ (keep straight away)`)
          .addOption("inbox", `${this.plugin.settings.inboxFolder}/ (triage first)`)
          .setValue(this.manualAddTarget)
          .onChange((value) => {
            this.manualAddTarget = value === "inbox" ? "inbox" : "papers";
          });
      })
      .addButton((button) =>
        button
          .setButtonText("Add")
          .onClick(() => void this.plugin.addByIds(this.manualAdd, this.manualAddTarget)),
      );
  }

  /**
   * What a generated note contains beyond the essentials.
   *
   * Deliberately a fixed set of switches rather than a template. The
   * generated-section markers and frontmatter conventions are a contract with
   * zot2vault (`docs/interop-spec.md` §5) — an arbitrary template would break
   * upgrade-in-place and turn a kept note into a competing duplicate.
   */
  private renderInboxPageSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Write an _Inbox.md index page")
      .setDesc(
        "Off by default, and worth leaving off. The page links every arrival, which " +
          "makes it a hub node in the graph — arrivals cluster around that file instead " +
          "of around the papers they cite, which is the opposite of the point. Your " +
          "inbox folder sorted by date is already the list.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.inboxPageEnabled).onChange(async (value) => {
          this.plugin.settings.inboxPageEnabled = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderNoteContent(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("What goes in a note").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Authors are always recorded as a note property, never as tags — author tags " +
        "clutter a vault badly and add nothing to the graph.",
    });

    new Setting(containerEl)
      .setName("Subject terms")
      .setDesc(
        "OpenAlex labels each paper with subject terms. As a property they are " +
          "searchable and stay out of the way; as tags they appear in the tag pane and " +
          "the graph, which gets noisy fast across a few hundred papers. If you also " +
          "use zot2vault, note that these terms are dropped when a kept note is later " +
          "upgraded from your Zotero library.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("property", "As a note property")
          .addOption("tags", "As tags")
          .addOption("off", "Don't include them")
          .setValue(this.plugin.settings.subjectPlacement)
          .onChange(async (value) => {
            this.plugin.settings.subjectPlacement = value as "off" | "property" | "tags";
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.subjectPlacement === "off") return;

    const vocabularies: [keyof LiteratureInboxSettings, string, string][] = [
      ["subjectTopics", "Topics", "A small curated set — the most useful of the three."],
      ["subjectKeywords", "Keywords", "Close to what an author would write themselves."],
      [
        "subjectConcepts",
        "Concepts",
        "A large machine-assigned hierarchy. Goes broad fast — expect terms like " +
          '"Physics" alongside the specific ones.',
      ],
    ];
    for (const [key, name, description] of vocabularies) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(description)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings[key] as boolean).onChange(async (value) => {
            (this.plugin.settings[key] as boolean) = value;
            await this.plugin.saveSettings();
          }),
        );
    }
  }

  private renderCleanup(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Cleanup — manual only").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Nothing is ever removed automatically. There is no timer and no background " +
        "task: cleanup runs only when you press the button below, and even then it " +
        "shows you the list and asks first.",
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "It can only touch a note that is still in the inbox folder, still byte-for-byte " +
        "what was generated, and past the keep window — and it moves notes to Obsidian's " +
        "trash rather than deleting them. Anything you edited, moved, or wrote yourself " +
        "is invisible to it.",
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
      .setName("Unlock the cleanup button")
      .setDesc(
        "Off by default. This does not schedule anything — it only lets the button " +
          "below do its work. While it is off, cleanup refuses to run at all.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pruneEnabled).onChange(async (value) => {
          this.plugin.settings.pruneEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Clean up now")
      .setDesc(
        "Runs once, right now. Shows what would be removed and asks before doing " +
          "anything. This is the only thing that ever removes a note.",
      )
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
