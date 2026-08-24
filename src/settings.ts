import { PluginSettingTab, Setting, type App } from "obsidian";
import { ARXIV_CATEGORIES, CUSTOM_ARXIV_CATEGORY, isKnownArxivCategory } from "./core/arxiv-categories";
import { DEFAULT_RECENCY_WINDOW_DAYS } from "./core/dates";
import { type FeedConfig } from "./core/feeds";
import type { AuthorPlacement } from "./core/notes";
import {
  SOURCE_LABELS,
  SOURCE_PLACEHOLDERS,
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
  /** Where kept papers go — the "library directory". */
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
   * What "new" means, in days back from today — one number for every source.
   * The user's definition, not "since you last ran": that returns an empty
   * inbox on day one and on any second run the same day, both of which read
   * as a broken plugin.
   */
  newWindowDays: number;

  maxArrivalsPerRun: number;

  /** Where OpenAlex's subject terms go in a generated note, if anywhere. */
  subjectPlacement: "off" | "property" | "tags";
  subjectTopics: boolean;
  subjectKeywords: boolean;
  subjectConcepts: boolean;

  /** Where author names go in generated notes. */
  authorPlacement: AuthorPlacement;
  /** Legacy setting migrated to authorPlacement on load. */
  includeAuthors?: boolean;

  /**
   * Track a read-status property on each paper note.
   *
   * Off by default: an unused property in every note is clutter, and this only
   * earns its place once you are reading regularly. When on, notes gain
   * `read-status: to-read`, and "What should I read?" skips anything marked
   * read or reference.
   */
  readStatusEnabled: boolean;

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

  lastUpdate?: string;
}

export const DEFAULT_SETTINGS: LiteratureInboxSettings = {
  inboxFolder: "Inbox",
  papersFolder: "Papers",
  // One connected stream by default: it needs no typing and every paper it
  // finds is wired to something the user kept.
  sources: [{ kind: "citing", value: "", enabled: true }],
  openAlexTopic: "",
  kernelSize: 20,
  kernelMode: "topic",
  kernelSeeds: "",
  kernelAuthor: "",
  newWindowDays: DEFAULT_RECENCY_WINDOW_DAYS,
  maxArrivalsPerRun: 3,
  // Terms as a property by default, never as tags: tags show up in the tag
  // pane and the graph, and a vault-wide dump of machine-assigned subject
  // terms is exactly the clutter people rightly fear. Concepts stays off for
  // the same reason — it is the broadest and noisiest of the three.
  subjectPlacement: "property",
  subjectTopics: true,
  subjectKeywords: true,
  subjectConcepts: false,
  authorPlacement: "property",
  readStatusEnabled: false,
  keepWindowDays: 30,
  pruneEnabled: false,
  openAlexApiKey: "",
  crossrefEnabled: true,
  crossrefMailto: "",
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
  /**
   * The row being configured before it's added — kind and value only, no
   * on/off toggle and no remove button, because neither means anything until
   * the row actually exists. Local to the tab, never persisted: it resets to
   * blank the moment "Add source" commits it into `settings.sources`.
   */
  private draftKind: SourceKind = "topic";
  private draftValue = "";

  constructor(app: App, private readonly plugin: LiteratureInboxPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    // Every interaction that changes a setting re-renders the whole page
    // (the simplest way to keep dependent fields honest) — without this, that
    // re-render silently threw the reader back to the top every single time.
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();

    // Order follows what a user actually does, most-often first: add papers,
    // fetch new ones, then the settings behind each of those, then the rest.
    this.renderStatus(containerEl);
    this.renderStartingGraph(containerEl);
    this.renderSources(containerEl);
    this.renderCleanup(containerEl);
    this.renderNoteContent(containerEl);
    this.renderIntegrations(containerEl);

    containerEl.scrollTop = scrollTop;
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
   * OpenAlex's daily allowance, as a bar.
   *
   * Deliberately in requests rather than currency: the allowance is metered,
   * but the user pays nothing, and a dollar figure implies a bill that does
   * not exist. Placed here because the expensive actions — building a graph,
   * snowballing — are two clicks below it.
   */
  private renderBudget(containerEl: HTMLElement): void {
    const budget = this.plugin.budgetGauge();

    new Setting(containerEl)
      .setName("OpenAlex daily allowance")
      .addButton((button) =>
        button
          .setButtonText("Refresh")
          .setTooltip("Ask OpenAlex for today's real figures right now")
          .onClick(async () => {
            button.setDisabled(true);
            await this.plugin.refreshBudget();
            this.display();
          }),
      );

    const wrapper = containerEl.createDiv({ cls: "setting-item-description" });

    // Everything but the fill width lives in styles.css; the width is the one
    // genuinely dynamic value, so it goes through a custom property rather
    // than a hand-built style string.
    const bar = wrapper.createDiv({ cls: "literature-inbox-budget-bar" });
    const level = budget.fraction > 0.9 ? "high" : budget.fraction > 0.6 ? "medium" : "low";
    const fill = bar.createDiv({ cls: "literature-inbox-budget-fill" });
    fill.dataset.level = level;
    fill.style.setProperty("--literature-inbox-budget-fraction", `${Math.round(budget.fraction * 100)}%`);

    wrapper.createEl("p", {
      cls: "setting-item-description",
      text:
        `${budget.label}. ` +
        (budget.fraction > 0.9
          ? "Nearly used up — it resets at midnight UTC."
          : "Resets at midnight UTC."),
    });
  }

  /**
   * The starting graph, in five flavours, plus the library directory itself.
   *
   * Only the input the chosen mode actually needs is shown — five modes with
   * every field visible at once is exactly the settings-page clutter this is
   * meant to avoid. Changing the mode re-renders the tab, which is cheap and
   * keeps the page honest about what it will use.
   */
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
      });

    // The topic field belongs to the modes that use it, not to the top of the
    // page — it was step 1 of onboarding while doing nothing at all in four of
    // the five modes.
    if (mode === "topic") {
      new Setting(containerEl)
        .setName("Topic")
        .setDesc(
          'A query — "quantum error correction", "machine translation" — or an OpenAlex ' +
            "concept id like C41008148. Comma-separate several terms to intersect them — " +
            '"Smart Grid, AI" prioritizes papers at the overlap of both, not either alone. ' +
            "You get the field's canon: the papers everything else cites. Needs no input " +
            "beyond this, but is not specific to you — if the result looks like a stranger's " +
            "library, try one of the other modes.",
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
            "list, or a handful of papers that define what you work on. From Zotero: " +
            "select items, right-click → Create Bibliography from Items → a style that " +
            "includes DOIs (APA works) → Copy to Clipboard, then paste here — no export " +
            "file needed. Full URLs are fine. Anything unrecognised is reported, never " +
            "silently skipped." +
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
          `Takes the papers already in ${this.plugin.settings.papersFolder}/ and pulls in ` +
          "what they cite and what cites them. The most personal starting graph available, " +
          "and it needs no typing. Does nothing if that folder is empty. To dig into a " +
          "handful of specific papers instead of your whole library, select them in the " +
          "file explorer or graph view and use \"Expand outward from these papers\" in the " +
          "right-click menu.",
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

    new Setting(containerEl)
      .setName("Library directory")
      .setDesc(
        "Feel free to make subfolders — everything under this directory is considered " +
          "your library and gets updated with citation links on every inbox update.",
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

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Add papers")
        .setCta()
        .onClick(() => void this.plugin.buildKernel()),
    );
  }

  /** The value control for one source row — a plain text box, except arXiv
   * categories get a dropdown of the real taxonomy with a manual fallback,
   * since the codes are easy to mistype and hard to remember. */
  private renderSourceValue(
    row: Setting,
    kind: SourceKind,
    value: string,
    onChange: (value: string) => Promise<void>,
  ): void {
    if (kind !== "arxiv") {
      row.addText((text) =>
        text
          .setPlaceholder(SOURCE_PLACEHOLDERS[kind])
          .setValue(value)
          .onChange(async (v) => {
            await onChange(v.trim());
          }),
      );
      return;
    }

    const known = isKnownArxivCategory(value);
    row.addDropdown((dropdown) => {
      for (const category of ARXIV_CATEGORIES) dropdown.addOption(category.code, category.label);
      dropdown.addOption(CUSTOM_ARXIV_CATEGORY, "Other (type the code manually)");
      dropdown.setValue(known ? value : CUSTOM_ARXIV_CATEGORY);
      dropdown.onChange(async (v) => {
        await onChange(v === CUSTOM_ARXIV_CATEGORY ? "" : v);
        this.display();
      });
    });
    if (!known) {
      row.addText((text) =>
        text
          .setPlaceholder("e.g. cs.CL")
          .setValue(value)
          .onChange(async (v) => {
            await onChange(v.trim());
          }),
      );
    }
  }

  /**
   * Every stream in one table: "Update your inbox".
   *
   * A topic query, "papers citing my library", an arXiv category and a feed
   * URL are all the same kind of thing — something producing candidate papers
   * — so they share a shape: on/off, what to watch, and a per-run cap. Only
   * the first two columns differ by kind. Fetching lives here too, since this
   * is what fetching actually consults.
   */
  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Update your inbox").setHeading();

    new Setting(containerEl)
      .setName("Fetch new papers")
      .setDesc(
        "Run this whenever you like — nothing fetches on its own. Keep an arrival by " +
          `moving its note into ${this.plugin.settings.papersFolder}/.`,
      )
      .addButton((button) =>
        button
          .setButtonText("Update inbox")
          .setCta()
          .onClick(() => void this.plugin.updateInbox()),
      );

    new Setting(containerEl)
      .setName("Parent inbox folder")
      .setDesc(
        "Every source's own folder below (and this one, when a source leaves it blank) " +
          "nests under this one. Together with the library directory (set above), this is " +
          "the plugin's whole bound — it never reads or writes anywhere else in your vault.",
      )
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
      .setName("How far back counts as new")
      .setDesc(
        "In days. One global window for every source below — recency is the whole reason " +
          "a result belongs in the inbox, so this shouldn't need per-source tuning. Wide " +
          "windows are cheap: exact dedup means re-seeing a paper costs nothing.",
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.newWindowDays)).onChange(async (value) => {
          this.plugin.settings.newWindowDays = parseCount(
            value,
            DEFAULT_SETTINGS.newWindowDays,
            0,
          );
          await this.plugin.saveSettings();
        }),
      );

    const sources = this.plugin.settings.sources;

    if (sources.length > 0) {
      const header = containerEl.createDiv({ cls: "literature-inbox-feed-header" });
      const label = (text: string) => header.createSpan({ text });
      label("Source");
      label("On/off");
      label("Papers per run");
      label("Folder");
      label(""); // remove button's column
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

      // Fixed once added: this is what the row *is*, not a value to edit in
      // place. Wrong kind, wrong row — remove it and add the right one.
      row.setName(SOURCE_LABELS[source.kind]);

      if (needsValue(source.kind)) {
        this.renderSourceValue(row, source.kind, source.value, async (value) => {
          source.value = value;
          await this.plugin.saveSettings();
        });
      }

      row.addText((text) =>
        text
          .setPlaceholder("Number of papers to add per run")
          .setValue(
            source.maxPerRun === undefined
              ? String(this.plugin.settings.maxArrivalsPerRun)
              : String(source.maxPerRun),
          )
          .onChange(async (value) => {
            source.maxPerRun = parseOptionalCount(value, 1);
            await this.plugin.saveSettings();
          }),
      );

      row.addText((text) =>
        text
          .setPlaceholder("Inbox subfolder for this source")
          .setValue(source.inboxFolder?.trim() || this.plugin.settings.inboxFolder)
          .onChange(async (value) => {
            source.inboxFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

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

      void index;
    });

    if (sources.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No sources yet — add one below.",
      });
    }

    // A row being configured, not yet a source: no toggle, no remove button,
    // because neither means anything until "Add source" commits it. Test
    // sits right next to Add — and only here, since a real row is watching
    // something already known to work.
    const draft = new Setting(containerEl).setName("Add a source");

    draft.addDropdown((dropdown) => {
      for (const [kind, label] of Object.entries(SOURCE_LABELS)) dropdown.addOption(kind, label);
      dropdown.setValue(this.draftKind).onChange((value) => {
        this.draftKind = value as SourceKind;
        this.draftValue = "";
        this.display();
      });
    });

    if (needsValue(this.draftKind)) {
      this.renderSourceValue(draft, this.draftKind, this.draftValue, (value) => {
        this.draftValue = value;
        return Promise.resolve();
      });
    }

    if (this.draftKind === "feed" || this.draftKind === "arxiv") {
      draft.addButton((button) =>
        button
          .setButtonText("Test")
          .setTooltip("Fetch this once and report what came back, before adding it")
          .onClick(() => {
            if (this.draftKind === "arxiv") void this.plugin.testArxivCategories(this.draftValue);
            else void this.plugin.testFeeds(this.draftValue);
          }),
      );
    }

    draft.addButton((button) =>
      button
        .setButtonText("Add source")
        .setCta()
        .onClick(async () => {
          const kind = this.draftKind;
          const value = needsValue(kind) ? this.draftValue.trim() : "";
          if (needsValue(kind) && !value) return; // nothing to add yet
          this.plugin.settings.sources.push({ kind, value, enabled: true });
          this.draftKind = "topic";
          this.draftValue = "";
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

  /**
   * What a generated note contains beyond the essentials.
   *
   * Deliberately a fixed set of switches rather than a template — the
   * generated-section markers are an on-disk format (`docs/interop-spec.md`
   * §5), and an arbitrary template would make regenerating a note ambiguous.
   */
  private renderNoteContent(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("What goes in a note").setHeading();
    new Setting(containerEl)
      .setName("Authors")
      .setDesc("Choose whether author names are note properties, plaintext, or omitted.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("property", "As a note property")
          .addOption("plaintext", "As plaintext")
          .addOption("off", "Don't include them")
          .setValue(this.plugin.settings.authorPlacement)
          .onChange(async (value) => {
            this.plugin.settings.authorPlacement = value as AuthorPlacement;
          await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Subject terms")
      .setDesc(
        "OpenAlex labels each paper with subject terms. As a property they are " +
          "searchable and stay out of the way; as tags they appear in the tag pane and " +
          "the graph, which gets noisy fast across a few hundred papers.",
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

    new Setting(containerEl)
      .setName("Track whether you have read a paper")
      .setDesc(
        "Adds a read-status property — to-read, read, or reference — which " +
          '"What should I read?" uses to skip what you are done with. Obsidian has no ' +
          "select property type, so it is a text field, but it autocompletes the values " +
          "it has already seen. Off by default: an unused property in every note is " +
          "clutter.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.readStatusEnabled).onChange(async (value) => {
          this.plugin.settings.readStatusEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

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
    new Setting(containerEl).setName("Clean out your inbox").setHeading();
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
        "is invisible to it. Feel free to move any note to the trash yourself at any time " +
        "— the plugin only ever acts on what's still sitting in the inbox, untouched.",
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
  }
}
