import { PluginSettingTab, Setting, type App } from "obsidian";
import { DEFAULT_RECENCY_WINDOW_DAYS } from "./core/dates";
import { type FeedConfig } from "./core/feeds";
import {
  SOURCE_LABELS,
  SOURCE_PLACEHOLDERS,
  emptySource,
  needsValue,
  type SourceConfig,
  type SourceKind,
} from "./core/sources";
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
  both: "Both",
  adjacent: "Only papers that cite my library",
  topic: "Only papers matching my topic",
};

export interface LiteratureInboxSettings {
  /** Where arrivals land. Keeping them in one folder is what makes "moving a
   * note out" a usable keep signal. */
  inboxFolder: string;
  /** Where kept papers go — the same folder zot2vault writes, so a kept note
   * gets upgraded in place if that paper later enters Zotero. */
  papersFolder: string;

  /** Every stream that brings in new papers, one row each. */
  sources: SourceConfig[];

  /**
   * The topic used by the *starting graph*, which is a different thing from a
   * topic you follow: one seeds a library in a single run, the other watches
   * a query indefinitely. Kept separate so seeding from one field while
   * following three others is expressible.
   */
  openAlexTopic: string;

  /** Pre-rows settings, read once on load and migrated into `sources`. */
  openAlexEnabled?: boolean;
  arrivalSelection?: ArrivalSelection;
  arxivEnabled?: boolean;
  arxivCategories?: string;
  rssEnabled?: boolean;
  feeds?: FeedConfig[];
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


  /** Where OpenAlex's subject terms go in a generated note, if anywhere. */
  subjectPlacement: "off" | "property" | "tags";
  subjectTopics: boolean;
  subjectKeywords: boolean;
  subjectConcepts: boolean;

  keepWindowDays: number;
  /** Off by default: nothing is ever removed until you say so. */
  pruneEnabled: boolean;

  /**
   * A free OpenAlex API key. Blank by default — never a hardcoded one.
   *
   * Optional, not required: keyless requests still work, on a smaller daily
   * allowance. See docs/openalex-dependency.md.
   */
  openAlexApiKey: string;

  /**
   * Use Crossref alongside OpenAlex.
   *
   * On by default: it is free, unmetered, needs no account, and its metadata
   * is CC0. It answers title lookups (which OpenAlex bills at its highest
   * rate) and supplies reference lists OpenAlex is missing. It cannot do
   * inbound citations, so adjacency selection is unaffected either way.
   */
  crossrefEnabled: boolean;
  /** Optional contact address for Crossref's polite pool: 3 req/s not 1. */
  crossrefMailto: string;
  /** Path to a zot2vault executable the user downloaded themselves. Blank by
   * default; the plugin never ships or fetches a binary. */
  zot2vaultPath: string;

  lastUpdate?: string;
}

export const DEFAULT_SETTINGS: LiteratureInboxSettings = {
  inboxFolder: "Inbox",
  papersFolder: "Papers",
  // One connected stream by default: it needs no typing and every paper it
  // finds is wired to something the user kept.
  sources: [{ kind: "citing", value: "", enabled: true }],
  openAlexTopic: "",
  kernelSize: 100,
  kernelMode: "topic",
  kernelSeeds: "",
  kernelAuthor: "",
  newWindowDays: DEFAULT_RECENCY_WINDOW_DAYS,
  maxArrivalsPerRun: 25,
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
  openAlexApiKey: "",
  crossrefEnabled: true,
  crossrefMailto: "",
  zot2vaultPath: "",
};

/** Split a comma/newline separated setting into clean entries. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** An optional numeric override: blank or nonsense means "inherit". */
function parseOptionalCount(value: string, min: number): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < min) return undefined;
  return parsed;
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

    // Order follows what a user actually does, most-often first: add papers,
    // fetch new ones, then the settings behind each of those, then the rest.
    this.renderStatus(containerEl);
    this.renderStartingGraph(containerEl);
    this.renderEveryday(containerEl);
    this.renderGraphSetup(containerEl);
    this.renderSources(containerEl);
    this.renderArrivals(containerEl);
    this.renderNoteContent(containerEl);
    this.renderFolders(containerEl);
    this.renderCleanup(containerEl);
    this.renderIntegrations(containerEl);
  }

  /** Where things stand, and what is left of today's allowance. */
  private renderStatus(containerEl: HTMLElement): void {
    const status = this.plugin.status();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `${status.keptCount} papers in your library · ${status.inboxCount} in the inbox` +
        (status.lastUpdate ? ` · last updated ${status.lastUpdate}` : " · never updated"),
    });
    this.renderBudget(containerEl);
  }

  /**
   * The two buttons people press repeatedly, in one obvious place.
   *
   * These used to be scattered — "fetch" was stranded at the end of the
   * graph-setup instructions, which is where you look once and never again.
   * Frequency of use is the only sensible ordering principle for a settings
   * page that doubles as a control panel.
   */
  private renderEveryday(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Everyday").setHeading();

    new Setting(containerEl)
      .setName("Fetch new papers")
      .setDesc(
        "Run this whenever you like — nothing fetches on its own. New papers land in " +
          `${this.plugin.settings.inboxFolder}/; keep one by moving its note into ` +
          `${this.plugin.settings.papersFolder}/.`,
      )
      .addButton((button) =>
        button
          .setButtonText("Update inbox")
          .setCta()
          .onClick(() => void this.plugin.updateInbox()),
      );

    new Setting(containerEl)
      .setName("Clean up old arrivals")
      .setDesc(
        "Shows what would go and asks first. Only ever touches notes still in the " +
          "inbox, unedited, and past the keep window — see Cleanup below.",
      )
      .addButton((button) =>
        button.setButtonText("Clean up").onClick(() => void this.plugin.cleanUp()),
      );
  }

  /**
   * How to make Obsidian's graph a triage surface.
   *
   * Instructions rather than automation: graph settings live in Obsidian's own
   * config, and writing that from a plugin is fragile and the kind of thing
   * review questions. A one-time setup the user does themselves is the honest
   * trade — but bookmarking it is what makes it a habit rather than a chore.
   */
  private renderGraphSetup(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Set up the graph (once)").setHeading();
    const graph = containerEl.createEl("div", { cls: "setting-item-description" });
    graph.createEl("p", {
      text:
        "The plugin writes notes; Obsidian draws the graph. Out of the box every note " +
        "in the vault shows up and arrivals look like everything else. Open graph view " +
        "(Ctrl/Cmd+G), then its settings (the slider icon), and:",
    });
    const steps = graph.createEl("ol");
    steps.createEl("li", {
      text:
        `Filters → search: path:${this.plugin.settings.inboxFolder} OR ` +
        `path:${this.plugin.settings.papersFolder}`,
    });
    steps.createEl("li", {
      text:
        `Groups → New group: path:${this.plugin.settings.inboxFolder} in a bright ` +
        `colour, then a second group for path:${this.plugin.settings.papersFolder} in a ` +
        "muted one.",
    });
    steps.createEl("li", {
      text:
        "Bookmark it: with the graph open and configured, run “Bookmarks: bookmark " +
        "current view” from the command palette. This is the step that makes it " +
        "stick — the graph becomes one click from the sidebar instead of a setup " +
        "you redo each time.",
    });
    graph.createEl("p", {
      text:
        "Colour by path rather than by tag: notes carry no inbox/kept tag on purpose, " +
        "because a tag written when the note is generated cannot follow a file you " +
        "later drag into another folder.",
    });
    graph.createEl("p", {
      text:
        "Once you are reading regularly, a third group is worth adding: tag your own " +
        "favourites (#favourite, #to-read, whatever you use) and give that group its " +
        "own colour. Those tags are yours and the plugin never touches them.",
    });
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
      .setName("Add papers to your graph")
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

    // The topic field belongs to the modes that use it, not to the top of the
    // page — it was step 1 of onboarding while doing nothing at all in four of
    // the five modes.
    if (mode === "topic") {
      new Setting(containerEl)
        .setName("Topic")
        .setDesc(
          'A query — "quantum error correction", "machine translation" — or an OpenAlex ' +
            "concept id like C41008148. You get the field's canon: the papers everything " +
            "else cites. Needs no input beyond this, but is not specific to you — if the " +
            "result looks like a stranger's library, try one of the other modes.",
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

    // Hidden in "seeds" mode, where it does nothing: you get exactly the
    // papers you pasted. A control that is present but inert teaches people
    // not to trust the ones next to it.
    if (mode !== "seeds") {
      new Setting(containerEl)
        .setName("How many papers to add")
        .setDesc(
          mode === "snowball" || mode === "library"
            ? "A ceiling on what the expansion adds, beyond the papers you started from."
            : "More papers means a denser core, but a longer first run.",
        )
        .addText((text) =>
          text.setValue(String(this.plugin.settings.kernelSize)).onChange(async (value) => {
            this.plugin.settings.kernelSize = parseCount(value, DEFAULT_SETTINGS.kernelSize);
            await this.plugin.saveSettings();
          }),
        );
    }
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

  /**
   * Every stream in one table.
   *
   * A topic query, "papers citing my library", an arXiv category and a feed
   * URL are all the same kind of thing — something producing candidate papers
   * — so they share a shape: on/off, what to watch, how far back counts as
   * new, and how many per run. Only the first two columns differ by kind.
   */
  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Where new papers come from").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Nothing fetches on its own — these are only consulted when you press Update " +
        "inbox. Leave the window and cap blank to inherit the settings below. When the " +
        "per-run cap bites, rows higher in this list are kept first.",
    });

    const sources = this.plugin.settings.sources;
    if (sources.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No sources yet. Add one below — “Papers citing my library” needs no typing.",
      });
    }

    sources.forEach((source, index) => {
      const row = new Setting(containerEl).setClass("literature-inbox-feed-row");

      row.addToggle((toggle) =>
        toggle
          .setValue(source.enabled)
          .setTooltip("Consult this source on an update")
          .onChange(async (value) => {
            source.enabled = value;
            await this.plugin.saveSettings();
          }),
      );

      row.addDropdown((dropdown) => {
        for (const [kind, label] of Object.entries(SOURCE_LABELS)) dropdown.addOption(kind, label);
        dropdown.setValue(source.kind).onChange(async (value) => {
          source.kind = value as SourceKind;
          if (!needsValue(source.kind)) source.value = "";
          await this.plugin.saveSettings();
          this.display(); // the value box appears or disappears with the kind
        });
      });

      if (needsValue(source.kind)) {
        row.addText((text) =>
          text
            .setPlaceholder(SOURCE_PLACEHOLDERS[source.kind])
            .setValue(source.value)
            .onChange(async (value) => {
              source.value = value.trim();
              await this.plugin.saveSettings();
            }),
        );
      }

      row
        .addText((text) =>
          text
            .setPlaceholder(`${this.plugin.settings.newWindowDays}d`)
            .setValue(source.windowDays === undefined ? "" : String(source.windowDays))
            .onChange(async (value) => {
              source.windowDays = parseOptionalCount(value, 0);
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder(`max ${this.plugin.settings.maxArrivalsPerRun}`)
            .setValue(source.maxPerRun === undefined ? "" : String(source.maxPerRun))
            .onChange(async (value) => {
              source.maxPerRun = parseOptionalCount(value, 1);
              await this.plugin.saveSettings();
            }),
        );

      if (source.kind === "feed" || source.kind === "arxiv") {
        row.addButton((button) =>
          button
            .setButtonText("Test")
            .setTooltip("Fetch this once and report what came back")
            .onClick(() => {
              if (source.kind === "arxiv") void this.plugin.testArxivCategories(source.value);
              else void this.plugin.testFeeds(source.value);
            }),
        );
      }

      row.addButton((button) =>
        button
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.sources.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          }),
      );

      row.setDesc(
        index === 0
          ? "On/off, what kind, what to watch, days back, and a per-run cap."
          : "",
      );
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Add a source").onClick(async () => {
        this.plugin.settings.sources.push(emptySource("topic"));
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "“Papers citing my library” is the one only OpenAlex can answer, and the " +
        "one where every result is guaranteed to connect to something you kept. Topic " +
        "search covers work that has not cited you yet. Feeds and arXiv are fastest to " +
        "publish but carry no reference lists, so those arrive unconnected and are " +
        "wired up on a later run.",
    });
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
   * What a generated note contains beyond the essentials.
   *
   * Deliberately a fixed set of switches rather than a template. The
   * generated-section markers and frontmatter conventions are a contract with
   * zot2vault (`docs/interop-spec.md` §5) — an arbitrary template would break
   * upgrade-in-place and turn a kept note into a competing duplicate.
   */
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
      .setName("Also use Crossref")
      .setDesc(
        "Recommended. Crossref is the registry publishers deposit DOIs with — free, " +
          "no account, no daily limit. It resolves titles that OpenAlex charges its " +
          "highest rate for, and fills in reference lists OpenAlex is missing. It " +
          "cannot provide 'papers citing my library'; only OpenAlex can.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.crossrefEnabled).onChange(async (value) => {
          this.plugin.settings.crossrefEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Email for Crossref (optional)")
      .setDesc(
        "Supplying one triples Crossref's rate limit for you, from 1 to 3 requests a " +
          "second. It is sent only to crossref.org. Unlike OpenAlex, Crossref's polite " +
          "pool is current and does something measurable.",
      )
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.crossrefMailto)
          .onChange(async (value) => {
            this.plugin.settings.crossrefMailto = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("OpenAlex API key (optional)")
      .setDesc(
        "The plugin works without one. A free key from openalex.org raises your daily " +
          "allowance about tenfold, which matters if you build large starting graphs or " +
          "run updates often. It is sent only to openalex.org, and never shared.",
      )
      .addText((text) =>
        text
          .setPlaceholder("leave blank to use the free allowance")
          .setValue(this.plugin.settings.openAlexApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openAlexApiKey = value.trim();
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
