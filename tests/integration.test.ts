/**
 * End-to-end tests driving the **real plugin class** through a faked Obsidian
 * API (tests/fakes/obsidian.ts).
 *
 * The `core/` unit tests prove the policy; these prove the *wiring* — onload,
 * command registration, the settings tab actually rendering, the vault
 * adapter creating files in the right place, and the full
 * fetch → dedup → write → keep → clean-up lifecycle. That is the class of bug
 * that only shows up the first time a plugin is loaded, and it's exactly what
 * the unit tests cannot see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  Platform,
  Setting,
  TFile,
  allSettings,
  clearNotices,
  clearRequests,
  notices,
  requestedUrls,
  resetFakeObsidian,
  setRequestResponder,
} from "./fakes/obsidian";
import LiteratureInboxPlugin from "../src/main";

// --- canned API payloads -------------------------------------------------------

function openAlexWork(id: string, title: string, refs: string[] = [], doi?: string) {
  return {
    id: `https://openalex.org/${id}`,
    title,
    type: "article",
    publication_date: "2026-05-01",
    doi: doi ? `https://doi.org/${doi}` : null,
    authorships: [{ author: { display_name: "Ada Lovelace" } }],
    referenced_works: refs.map((r) => `https://openalex.org/${r}`),
    abstract_inverted_index: { An: [0], abstract: [1] },
    primary_location: { source: { display_name: "A Journal" } },
  };
}

function openAlexPage(works: unknown[]) {
  return JSON.stringify({ results: works, meta: { next_cursor: null } });
}

const DEFAULT_RESPONSE = openAlexPage([
  openAlexWork("W1", "A Paper About Transformers", ["W2"], "10.1234/one"),
  openAlexWork("W2", "A Paper About Attention", [], "10.1234/two"),
]);

function respondWith(body: string, status = 200) {
  setRequestResponder(() => ({ status, text: body }));
}

/**
 * A note for a paper the user kept. It carries its own `origin-ids`, which is
 * what lets the plugin recognise it without any zot2vault manifest present.
 */
function keptNoteContent(title: string, originId: string): string {
  return [
    "---",
    `title: ${title}`,
    "origin-ids:",
    `  - ${originId}`,
    "---",
    "",
    "body",
    "",
  ].join("\n");
}

// --- harness -------------------------------------------------------------------

async function bootPlugin(configure?: (plugin: LiteratureInboxPlugin) => void) {
  const app = new App();
  const plugin = new LiteratureInboxPlugin(app as never, {} as never);
  await plugin.onload();
  configure?.(plugin);
  return { app, plugin };
}

function commandIds(plugin: LiteratureInboxPlugin): string[] {
  return (plugin as never as { commands: { id: string }[] }).commands.map((c) => c.id);
}

async function runCommand(plugin: LiteratureInboxPlugin, id: string): Promise<void> {
  const command = (
    plugin as never as {
      commands: { id: string; callback?: () => void; checkCallback?: (c: boolean) => boolean }[];
    }
  ).commands.find((c) => c.id === id);
  if (!command) throw new Error(`no such command: ${id}`);
  if (command.callback) command.callback();
  else command.checkCallback?.(false);
  // Commands kick off async work without awaiting; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function enableOpenAlex(plugin: LiteratureInboxPlugin, topic = "transformers") {
  plugin.settings.openAlexEnabled = true;
  plugin.settings.openAlexTopic = topic;
  plugin.settings.arxivEnabled = false;
  plugin.settings.rssEnabled = false;
}

beforeEach(() => {
  resetFakeObsidian();
});

// --- load ------------------------------------------------------------------------

describe("plugin load", () => {
  it("loads without throwing and registers every command", async () => {
    const { plugin } = await bootPlugin();
    expect(commandIds(plugin)).toEqual([
      "update-inbox",
      "build-kernel",
      "keep-paper",
      "add-by-doi",
      "copy-identifier",
      "clean-up-inbox",
      "run-zot2vault",
    ]);
  });

  it("makes no network request on load", async () => {
    // A responder that throws is installed by default, so any fetch during
    // onload would fail the test loudly.
    await expect(bootPlugin()).resolves.toBeDefined();
  });

  it("starts from defaults when there is no saved data", async () => {
    const { plugin } = await bootPlugin();
    expect(plugin.settings.inboxFolder).toBe("Inbox");
    expect(plugin.settings.pruneEnabled).toBe(false); // cleanup off until asked for
  });

  it("renders the settings tab without throwing", async () => {
    const { plugin } = await bootPlugin();
    const tab = (plugin as never as { settingTab: { display: () => void } }).settingTab;
    expect(() => tab.display()).not.toThrow();
    expect(allSettings.length).toBeGreaterThan(5);
  });

  it("shows the current values in the settings tab", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.openAlexTopic = "quantum error correction";
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();
    const topic = allSettings.find((s: Setting) => s.name.includes("What do you work on"));
    expect(topic?.texts[0]?.value).toBe("quantum error correction");
  });
});

// --- the update run -----------------------------------------------------------------

describe("update inbox", () => {
  it("writes a note per arrival, plus the inbox page", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
    expect(app.vault.files.has("Inbox/A Paper About Attention.md")).toBe(true);
    expect(app.vault.files.has("Inbox/_Inbox.md")).toBe(true);
  });

  it("creates the inbox folder rather than failing to write into it", async () => {
    // The fake Vault refuses to create a file in a missing folder, exactly
    // like the real one — so this proves ensureFolder is actually wired.
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");
    expect(app.vault.folders.has("Inbox")).toBe(true);
  });

  it("writes notes with frontmatter and the shared generated markers", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain("<!-- zot2vault:generated:start -->");
    expect(note).toContain("<!-- zot2vault:generated:end -->");
    expect(note).toContain("doi: 10.1234/one");
    expect(note).toContain("source: openalex");
  });

  it("wires citation edges between arrivals", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    const citing = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(citing).toContain("[[A Paper About Attention]]");
  });

  it("tells the user what happened", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");
    expect(notices.some((n) => n.includes("2 new"))).toBe(true);
  });

  it("does not duplicate anything on a second run", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");
    const afterFirst = new Set(app.vault.files.keys());

    await runCommand(plugin, "update-inbox");

    expect(new Set(app.vault.files.keys())).toEqual(afterFirst);
    expect(notices.some((n) => n.includes("already known"))).toBe(true);
  });

  it("persists its state across a reload", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    // Simulate Obsidian restarting: same saved data, fresh plugin instance.
    const saved = await plugin.loadData();
    const reloaded = new LiteratureInboxPlugin(app as never, {} as never);
    (reloaded as never as { stored: unknown }).stored = saved;
    await reloaded.saveData(saved);
    await reloaded.onload();

    expect(reloaded.settings.openAlexTopic).toBe("transformers");
    expect(reloaded.settings.lastUpdate).toBeTruthy();
  });

  it("skips a paper already present in the vault's papers folder", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    // A zot2vault-generated vault that already contains one of these papers.
    await app.vault.createFolder(".scriptorium");
    app.vault.files.set(
      ".scriptorium/state.json",
      JSON.stringify({
        version: 1,
        note_manifest: {
          "Papers/A Paper About Attention.md": {
            content_hash: "x",
            generated_at: "2026-01-01T00:00:00Z",
            origin_ids: ["doi:10.1234/two"],
            title: "A Paper About Attention",
          },
        },
      }),
    );

    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Attention.md")).toBe(false);
    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
  });

  it("links an arrival to the existing vault note it cites", async () => {
    respondWith(
      openAlexPage([openAlexWork("W1", "A Brand New Arrival", ["W99"], "10.1234/new")]),
    );
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await app.vault.createFolder(".scriptorium");
    app.vault.files.set(
      ".scriptorium/state.json",
      JSON.stringify({
        version: 1,
        note_manifest: {
          "Papers/An Older Known Paper.md": {
            content_hash: "x",
            generated_at: "2026-01-01T00:00:00Z",
            origin_ids: ["openalex:W99"],
            title: "An Older Known Paper",
          },
        },
      }),
    );

    await runCommand(plugin, "update-inbox");

    const note = app.vault.files.get("Inbox/A Brand New Arrival.md") as string;
    expect(note).toContain("[[An Older Known Paper]]");
  });
});

// --- failure handling ---------------------------------------------------------------

describe("degenerate and failure cases", () => {
  it("says so when no sources are enabled, and writes nothing", async () => {
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.openAlexEnabled = false;
      p.settings.arxivEnabled = false;
      p.settings.rssEnabled = false;
    });

    await runCommand(plugin, "update-inbox");

    expect(notices.some((n) => n.toLowerCase().includes("no sources"))).toBe(true);
    expect(app.vault.files.size).toBe(0);
  });

  it("survives a failing API without crashing or losing the run", async () => {
    respondWith("", 500);
    const { plugin } = await bootPlugin(enableOpenAlex);

    // Awaited directly rather than through the command: a 500 is retried with
    // exponential backoff, so the run genuinely takes seconds. Fake timers
    // skip the waiting without pretending the retries didn't happen.
    vi.useFakeTimers();
    const run = plugin.updateInbox();
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    vi.useRealTimers();

    // "No update this run" is the correct outcome, communicated to the user.
    expect(notices.some((n) => n.includes("0 new") || n.includes("error"))).toBe(true);
  });

  it("survives malformed JSON from the API", async () => {
    respondWith("{ this is not json");
    const { plugin } = await bootPlugin(enableOpenAlex);
    await expect(runCommand(plugin, "update-inbox")).resolves.toBeUndefined();
  });

  it("ignores a corrupt state.json instead of refusing to run", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await app.vault.createFolder(".scriptorium");
    app.vault.files.set(".scriptorium/state.json", "{{{ corrupt");

    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
  });
});

// --- keeping ---------------------------------------------------------------------------

describe("keeping a paper", () => {
  it("moves the note out of the inbox", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    app.workspace.activeFile = new TFile("Inbox/A Paper About Transformers.md");
    await runCommand(plugin, "keep-paper");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(false);
    expect(app.vault.files.has("Papers/A Paper About Transformers.md")).toBe(true);
  });

  it("is offered only for notes inside the inbox", async () => {
    const { app, plugin } = await bootPlugin();
    const keep = (
      plugin as never as { commands: { id: string; checkCallback: (c: boolean) => boolean }[] }
    ).commands.find((c) => c.id === "keep-paper");

    app.workspace.activeFile = new TFile("Papers/Something Else.md");
    expect(keep?.checkCallback(true)).toBe(false);

    app.workspace.activeFile = new TFile("Inbox/An Arrival.md");
    expect(keep?.checkCallback(true)).toBe(true);
  });

  it("stops tracking a kept note, so a later run cannot resurrect it", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    app.workspace.activeFile = new TFile("Inbox/A Paper About Transformers.md");
    await runCommand(plugin, "keep-paper");
    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(false);
    expect(app.vault.files.has("Papers/A Paper About Transformers.md")).toBe(true);
  });
});

// --- cleanup ------------------------------------------------------------------------------

describe("cleanup safety", () => {
  it("refuses to do anything while cleanup is disabled", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    await runCommand(plugin, "clean-up-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
    expect(notices.some((n) => n.toLowerCase().includes("cleanup is off"))).toBe(true);
  });

  it("keeps recent arrivals even when cleanup is enabled", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.pruneEnabled = true;
      p.settings.keepWindowDays = 30;
    });
    await runCommand(plugin, "update-inbox");

    await runCommand(plugin, "clean-up-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
    expect(notices.some((n) => n.toLowerCase().includes("nothing to clean"))).toBe(true);
  });

  it("never removes an edited note, even once it is old", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.pruneEnabled = true;
      p.settings.keepWindowDays = 0; // everything is immediately eligible
    });
    await runCommand(plugin, "update-inbox");

    const path = "Inbox/A Paper About Transformers.md";
    app.vault.files.set(path, (app.vault.files.get(path) as string) + "\n\nMy own notes.\n");

    await runCommand(plugin, "clean-up-inbox");

    expect(app.vault.files.has(path)).toBe(true);
  });

  it("asks before removing anything", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.pruneEnabled = true;
      p.settings.keepWindowDays = 0;
    });
    await runCommand(plugin, "update-inbox");

    await runCommand(plugin, "clean-up-inbox");

    // The confirmation modal is open; nothing has been removed yet.
    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
    expect(app.fileManager.trashed).toEqual([]);
  });
});

// --- desktop gating -------------------------------------------------------------------------

describe("building the starting graph", () => {
  /** Three papers where the later two cite the first — a miniature of what a
   * top-cited set looks like: densely inter-citing. */
  const KERNEL_RESPONSE = openAlexPage([
    openAlexWork("W1", "The Foundational Paper", [], "10.1234/foundational"),
    openAlexWork("W2", "A Paper Building On It", ["W1"], "10.1234/second"),
    openAlexWork("W3", "Another Paper Building On It", ["W1"], "10.1234/third"),
  ]);

  it("writes papers into the kept folder, not the inbox", async () => {
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "build-kernel");

    expect(app.vault.files.has("Papers/The Foundational Paper.md")).toBe(true);
    expect(app.vault.files.has("Inbox/The Foundational Paper.md")).toBe(false);
  });

  it("wires the seeded papers to each other", async () => {
    // The point of seeding top-cited work: it arrives as a graph, not a list.
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "build-kernel");

    const citing = app.vault.files.get("Papers/A Paper Building On It.md") as string;
    expect(citing).toContain("[[The Foundational Paper]]");
    // ...and the foundational paper knows what points at it.
    const cited = app.vault.files.get("Papers/The Foundational Paper.md") as string;
    expect(cited).toContain("### Cited by");
    expect(cited).toContain("[[A Paper Building On It]]");
  });

  it("tags seeded papers as kept, never as inbox", async () => {
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "build-kernel");

    const note = app.vault.files.get("Papers/The Foundational Paper.md") as string;
    expect(note).toContain("- kept");
    expect(note).not.toContain("- inbox");
  });

  it("is additive: re-running adds nothing it already has", async () => {
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "build-kernel");
    const afterFirst = new Set(app.vault.files.keys());

    respondWith(KERNEL_RESPONSE);
    await runCommand(plugin, "build-kernel");

    expect(new Set(app.vault.files.keys())).toEqual(afterFirst);
    expect(notices.some((n) => n.includes("you already had"))).toBe(true);
  });

  it("refuses without a topic rather than fetching nothing", async () => {
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.openAlexTopic = "";
    });

    await runCommand(plugin, "build-kernel");

    expect(notices.some((n) => n.includes("topic"))).toBe(true);
    expect(app.vault.files.size).toBe(0);
  });

  it("gives arrivals something to connect to", async () => {
    // The whole reason the kernel exists: without it, the first arrival is an
    // isolated dot and "why you're seeing this" can never fire.
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "build-kernel");

    respondWith(
      openAlexPage([openAlexWork("W9", "A Newly Published Paper", ["W1"], "10.1234/new")]),
    );
    await runCommand(plugin, "update-inbox");

    const arrival = app.vault.files.get("Inbox/A Newly Published Paper.md") as string;
    expect(arrival).toContain("Why you're seeing this");
    expect(arrival).toContain("[[The Foundational Paper]]");
  });

  it("does not re-ask for the top-cited papers on the first update", async () => {
    // The bug this guards: with no `lastUpdate` recorded yet, the update ran
    // `topWorks` — the *same* most-cited query the kernel had just seeded — so
    // every result was skipped as already-in-vault and the run reported
    // "0 new". Guaranteed, on every first update after building a graph.
    respondWith(KERNEL_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "build-kernel");

    clearRequests();
    clearNotices();
    respondWith(
      openAlexPage([openAlexWork("W9", "A Newly Published Paper", ["W1"], "10.1234/new")]),
    );
    await runCommand(plugin, "update-inbox");

    const url = requestedUrls[0] as string;
    expect(url).toContain("from_created_date");
    expect(url).not.toContain("cited_by_count");
    expect(notices.some((n) => n.includes("1 new"))).toBe(true);
  });

  it("asks for the same window regardless of when it last ran", async () => {
    // Anchoring the window on `lastUpdate` narrowed it to nothing on a second
    // run the same day. Overlap is deliberate: dedup is exact, so re-seeing a
    // paper costs nothing while missing one is permanent.
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "update-inbox");
    const first = requestedUrls[0] as string;
    expect(plugin.settings.lastUpdate).toBeTruthy();

    clearRequests();
    respondWith(DEFAULT_RESPONSE);
    await runCommand(plugin, "update-inbox");

    expect(requestedUrls[0]).toBe(first);
  });
});

describe("the plugin's visible surface", () => {
  it("offers a ribbon icon for the action people run most", async () => {
    const { plugin } = await bootPlugin();
    const icons = (plugin as never as { ribbonIcons: { title: string }[] }).ribbonIcons;
    expect(icons).toHaveLength(1);
    expect(icons[0]?.title).toContain("Update");
  });

  it("reports its state for the settings page", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);
    expect(plugin.status().inboxCount).toBe(0);

    await runCommand(plugin, "update-inbox");
    expect(plugin.status().inboxCount).toBe(2);
    expect(plugin.status().lastUpdate).toBeTruthy();
  });

  it("renders every settings section without throwing", async () => {
    const { plugin } = await bootPlugin();
    const tab = (plugin as never as { settingTab: { display: () => void } }).settingTab;
    expect(() => tab.display()).not.toThrow();

    const headings = allSettings.filter((s: Setting) => s.isHeading).map((s: Setting) => s.name);
    expect(headings).toContain("Getting started");
    expect(headings).toContain("Folders");
    expect(headings).toContain("Cleanup");
  });

  it("puts the starting-graph action in front of the user", async () => {
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();
    const kernel = allSettings.find((s: Setting) => s.name.includes("starting graph"));
    expect(kernel?.buttons[0]?.text).toBe("Build starting graph");
  });

  it("wires the settings buttons to real actions", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const update = allSettings.find((s: Setting) => s.name.includes("Fetch new papers"));
    await update?.buttons[0]?.simulateClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
  });
});

describe("why am I seeing this", () => {
  it("names the kept papers an arrival connects to", async () => {
    respondWith(openAlexPage([openAlexWork("W1", "A Brand New Arrival", ["W99"], "10.1234/new")]));
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    // A paper the user kept: it lives in Papers/, not the inbox.
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Paper I Kept.md",
      keptNoteContent("A Paper I Kept", "openalex:W99"),
    );

    await runCommand(plugin, "update-inbox");

    const note = app.vault.files.get("Inbox/A Brand New Arrival.md") as string;
    expect(note).toContain("Why you're seeing this");
    expect(note).toContain("[[A Paper I Kept]]");
  });

  it("stays quiet when an arrival only connects to other arrivals", async () => {
    // Connecting to unread arrivals says nothing about relevance, so claiming
    // it would be noise rather than signal.
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "update-inbox");

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note).toContain("[[A Paper About Attention]]"); // the edge exists
    expect(note).not.toContain("Why you're seeing this"); // but it isn't a signal
  });
});

describe("citation backfill", () => {
  /**
   * Edge-less on the first run; on the second, OpenAlex has indexed the paper
   * and reports its references. The arrival has no DOI (the arXiv case), so
   * backfill reaches it by title lookup — hence the `title.search` branch.
   */
  function stagedResponder(phase: () => number) {
    setRequestResponder((url) => {
      if (phase() === 0) {
        return {
          status: 200,
          text: openAlexPage([openAlexWork("W1", "An Isolated Preprint Paper", [])]),
        };
      }
      if (url.includes("title.search")) {
        return {
          status: 200,
          text: openAlexPage([
            openAlexWork("W1", "An Isolated Preprint Paper", ["W99"], "10.1234/late"),
          ]),
        };
      }
      // Nothing new to fetch on the second run.
      return { status: 200, text: openAlexPage([]) };
    });
  }

  it("connects an arrival that first landed with no references", async () => {
    let phase = 0;
    stagedResponder(() => phase);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Paper I Kept.md",
      keptNoteContent("A Paper I Kept", "openalex:W99"),
    );

    await runCommand(plugin, "update-inbox");
    const first = app.vault.files.get("Inbox/An Isolated Preprint Paper.md") as string;
    expect(first).not.toContain("## Citations");

    phase = 1;
    await runCommand(plugin, "update-inbox");

    const second = app.vault.files.get("Inbox/An Isolated Preprint Paper.md") as string;
    expect(second).toContain("## Citations");
    expect(second).toContain("[[A Paper I Kept]]");
  });

  it("never rewrites a note the user has edited", async () => {
    let phase = 0;
    stagedResponder(() => phase);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    const path = "Inbox/An Isolated Preprint Paper.md";
    const edited = `${app.vault.files.get(path) as string}\n\nMy own notes.\n`;
    app.vault.files.set(path, edited);

    phase = 1;
    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.get(path)).toBe(edited);
  });
});

describe("the zot2vault launcher", () => {
  it("is offered on desktop and hidden on mobile", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.zot2vaultPath = "/bin/zot2vault";
    });
    const command = (
      plugin as never as { commands: { id: string; checkCallback: (c: boolean) => boolean }[] }
    ).commands.find((c) => c.id === "run-zot2vault");

    Platform.isDesktop = true;
    expect(command?.checkCallback(true)).toBe(true);

    Platform.isDesktop = false;
    expect(command?.checkCallback(true)).toBe(false);
  });

  it("refuses to run, and never spawns, when no path is configured", async () => {
    const { plugin } = await bootPlugin();
    let spawned = false;
    await plugin.runZot2vault(() => {
      spawned = true;
      throw new Error("must not spawn");
    });
    expect(spawned).toBe(false);
    expect(notices.some((n) => n.includes("settings"))).toBe(true);
  });

  it("runs exactly the configured path and reports the outcome", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.zot2vaultPath = "/bin/zot2vault";
    });
    let launched: string | undefined;
    await plugin.runZot2vault(((command: string) => {
      launched = command;
      const handlers: Record<string, ((v: unknown) => void)[]> = {};
      queueMicrotask(() => handlers.close?.forEach((h) => h(0)));
      return {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: (event: string, cb: (v: unknown) => void) => {
          (handlers[event] ??= []).push(cb);
        },
      };
    }) as never);

    expect(launched).toBe("/bin/zot2vault");
    expect(notices.some((n) => n.includes("finished"))).toBe(true);
  });
});

describe("mobile compatibility", () => {
  it("loads and updates with desktop features unavailable", async () => {
    Platform.isDesktop = false;
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
  });
});
