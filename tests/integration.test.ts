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
  clearSettings,
  notices,
  requestedUrls,
  resetFakeObsidian,
  setRequestResponder,
} from "./fakes/obsidian";
import LiteratureInboxPlugin from "../src/main";
import { isoDaysAgo } from "../src/core/dates";

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
 * what lets the plugin recognise it just by scanning the folder.
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

/**
 * Commands (and settings-page buttons) kick off async work without awaiting.
 * Waiting a fixed couple of ticks used to be enough; now that one rate
 * limiter paces a whole run — and a topic search costs two requests, not one,
 * since resolving the topic to a concept id comes first — a multi-request
 * action genuinely takes time, so wait on the plugin's own busy flag instead
 * of guessing.
 */
async function waitForIdle(plugin: LiteratureInboxPlugin): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = plugin as never as { running: boolean };
  const deadline = Date.now() + 10_000;
  while (state.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  await waitForIdle(plugin);
}

/**
 * Pretend *days* have passed since each inbox note arrived and was last
 * checked, so a scheduled retry becomes due without waiting for the clock.
 */
function ageBackfillState(plugin: LiteratureInboxPlugin, days: number): void {
  const shift = (iso: string | undefined) => {
    const base = iso ? Date.parse(`${iso}T00:00:00Z`) : Date.now();
    return new Date(base - days * 86_400_000).toISOString().slice(0, 10);
  };
  for (const record of (plugin as never as { inbox: Record<string, unknown>[] }).inbox) {
    record.arrivedOn = shift(record.arrivedOn as string | undefined);
    if (record.lastBackfillOn) record.lastBackfillOn = shift(record.lastBackfillOn as string);
  }
}

/** One topic source row, which is the simplest deterministic configuration. */
function enableOpenAlex(plugin: LiteratureInboxPlugin, topic = "transformers") {
  plugin.settings.sources = [{ kind: "topic", value: topic, enabled: true }];
  plugin.settings.openAlexTopic = topic;
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
      "suggest-paper",
      "copy-identifier",
      "clean-up-inbox",
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
    // The topic box lives inside the topic mode now, not at the top of the
    // page — it did nothing in four of the five starting-graph modes.
    const { plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "topic";
      p.settings.openAlexTopic = "quantum error correction";
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();
    const topic = allSettings.find((s: Setting) => s.name === "Topic");
    expect(topic?.texts[0]?.value).toBe("quantum error correction");
  });

  it("hides the topic box in modes that do not use it", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "seeds";
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();
    expect(allSettings.some((s: Setting) => s.name === "Topic")).toBe(false);
    // ...and so is the size box, which that mode ignores entirely.
    expect(allSettings.some((s: Setting) => s.name.includes("How many papers"))).toBe(false);
  });

  it("puts the everyday actions where their settings live", async () => {
    // Fetch lives with the sources it consults; clean-up lives with the
    // cleanup settings it depends on — not stranded in setup instructions.
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();
    const fetch = allSettings.find((s: Setting) => s.name === "Fetch new papers");
    const clean = allSettings.find((s: Setting) => s.name === "Clean up now");
    expect(fetch?.buttons[0]?.text).toBe("Update inbox");
    expect(clean?.buttons[0]?.text).toBe("Preview cleanup");
  });
});

// --- the update run -----------------------------------------------------------------

describe("update inbox", () => {
  it("writes a note per arrival", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
    expect(app.vault.files.has("Inbox/A Paper About Attention.md")).toBe(true);
  });

  it("writes no index page, so nothing becomes a graph hub", async () => {
    // An index linking every arrival would be a hub node in the graph, pulling
    // arrivals into a star around a file that means nothing and competing with
    // the citation edges that are the entire point. The folder is the list.
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await runCommand(plugin, "update-inbox");

    expect([...app.vault.files.keys()].some((p) => p.includes("_Inbox"))).toBe(false);
  });

  it("creates the inbox folder rather than failing to write into it", async () => {
    // The fake Vault refuses to create a file in a missing folder, exactly
    // like the real one — so this proves ensureFolder is actually wired.
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");
    expect(app.vault.folders.has("Inbox")).toBe(true);
  });

  it("writes notes with frontmatter and the generated markers", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain("<!-- literature-inbox:generated:start -->");
    expect(note).toContain("<!-- literature-inbox:generated:end -->");
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
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Paper About Attention.md",
      keptNoteContent("A Paper About Attention", "doi:10.1234/two"),
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
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/An Older Known Paper.md",
      keptNoteContent("An Older Known Paper", "openalex:W99"),
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
      p.settings.sources = [];
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

  it("ignores an unparseable note in the papers folder instead of refusing to run", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await app.vault.createFolder("Papers");
    await app.vault.create("Papers/Corrupt Frontmatter.md", "---\n:::garbage:::\n---\nbody");

    await runCommand(plugin, "update-inbox");

    expect(app.vault.files.has("Inbox/A Paper About Transformers.md")).toBe(true);
  });
});

// --- keeping ---------------------------------------------------------------------------

describe("what should I read?", () => {
  it("suggests a paper from the inbox", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);
    await plugin.updateInbox();

    await plugin.suggestPaper();

    // The modal names a real arrival rather than failing quietly.
    expect(notices.some((n) => n.includes("No papers yet"))).toBe(false);
  });

  it("says so when there is nothing to suggest", async () => {
    const { plugin } = await bootPlugin();
    await plugin.suggestPaper();
    expect(notices.some((n) => n.includes("No papers yet"))).toBe(true);
  });

  it("ignores notes the user wrote themselves", async () => {
    // A prose note has no identity and is none of this command's business.
    const { app, plugin } = await bootPlugin();
    await app.vault.createFolder("Papers");
    await app.vault.create("Papers/My Thoughts.md", "# My Thoughts\n\nprose\n");

    await plugin.suggestPaper();

    expect(notices.some((n) => n.includes("No papers yet"))).toBe(true);
  });

  it("skips papers already marked read", async () => {
    const { app, plugin } = await bootPlugin();
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Read Paper.md",
"---\ntitle: A Read Paper\norigin-ids:\n  - doi:10.1/x\nread-status: read\n---\n\nbody\n",
    );

    await plugin.suggestPaper();

    expect(notices.some((n) => n.includes("marked read or reference"))).toBe(true);
  });

  it("puts a paper you marked read beyond cleanup's reach", async () => {
    // Saying you have read something is engagement, and cleanup is only for
    // arrivals nobody looked at. Leaving the recorded hash stale is what makes
    // the note count as touched, which is exactly the guard we want here.
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.readStatusEnabled = true;
    });
    await plugin.updateInbox();

    const path = "Inbox/A Paper About Transformers.md";
    await plugin.setReadStatus(path, "read");

    const content = app.vault.files.get(path) as string;
    expect(content).toContain("read-status: read");

    // Cleanup now sees a note that no longer matches what it generated.
    const { contentHash } = await import("../src/core/hash");
    const record = (plugin as never as { inbox: { notePath: string; contentHash: string }[] }).inbox
      .find((r) => r.notePath === path);
    expect(record?.contentHash).not.toBe(contentHash(content));

    plugin.settings.pruneEnabled = true;
    plugin.settings.keepWindowDays = 0;
    await plugin.cleanUp();
    expect(app.vault.files.has(path)).toBe(true);
  });

  it("writes no read-status property unless the feature is on", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await plugin.updateInbox();

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note).not.toContain("read-status");
  });

  it("seeds the property when the feature is on", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.readStatusEnabled = true;
    });
    await plugin.updateInbox();

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note).toContain("read-status: to-read");
  });
});

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
    // And says why, including that nothing happens automatically — the point
    // people most often misread about this setting.
    const refusal = notices.find((n) => n.toLowerCase().includes("cleanup is locked"));
    expect(refusal).toBeDefined();
    expect(refusal?.toLowerCase()).toContain("automatically");
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

  it("writes no kept/inbox tag, leaving the folder as the only signal", async () => {
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "build-kernel");

    const note = app.vault.files.get("Papers/The Foundational Paper.md") as string;
    // No kept/inbox tag on any generated note. The tag could only describe
    // where a note was *written*, and a paper kept by dragging the file would
    // keep saying `inbox` forever. The folder answers the question instead.
    expect(note).not.toContain("tags:");
    expect(note).not.toContain("- kept");
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

  it("reuses a matching preview's pool instead of fetching it again for Build", async () => {
    respondWith(KERNEL_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);

    await plugin.previewTopic();
    expect(requestedUrls.length).toBeGreaterThan(0);

    clearRequests();
    await runCommand(plugin, "build-kernel");

    expect(requestedUrls).toHaveLength(0);
    expect(app.vault.files.has("Papers/The Foundational Paper.md")).toBe(true);
  });

  it("fetches fresh when Build's topic differs from what was previewed", async () => {
    respondWith(KERNEL_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);

    await plugin.previewTopic();
    clearRequests();

    plugin.settings.openAlexTopic = "a different topic";
    respondWith(KERNEL_RESPONSE);
    await runCommand(plugin, "build-kernel");

    expect(requestedUrls.length).toBeGreaterThan(0);
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

    // The topic is first resolved to a concept id (a separate, cheap
    // request), so find the actual works query rather than assuming index 0.
    const url = requestedUrls.find((u) => u.includes("/works?")) as string;
    expect(url).toContain("from_publication_date");
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
    const first = requestedUrls.find((u) => u.includes("/works?")) as string;
    expect(plugin.settings.lastUpdate).toBeTruthy();

    clearRequests();
    respondWith(DEFAULT_RESPONSE);
    await runCommand(plugin, "update-inbox");

    expect(requestedUrls.find((u) => u.includes("/works?"))).toBe(first);
  });
});

describe("starting-graph modes", () => {
  it("builds from a pasted list, writing exactly those papers to the kept folder", async () => {
    respondWith(
      openAlexPage([
        openAlexWork("W1", "A Paper I Chose", [], "10.1234/one"),
        openAlexWork("W2", "Another Paper I Chose", ["W1"], "10.1234/two"),
      ]),
    );
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "seeds";
      p.settings.kernelSeeds = "10.1234/one\nhttps://doi.org/10.1234/two";
      // Isolated to OpenAlex, so this measures batching rather than the
      // Crossref fallback (which fires for any record lacking references).
      p.settings.crossrefEnabled = false;
    });

    await plugin.buildKernel();

    expect(app.vault.files.has("Papers/A Paper I Chose.md")).toBe(true);
    expect(app.vault.files.has("Papers/Another Paper I Chose.md")).toBe(true);
    expect(app.vault.files.has("Inbox/A Paper I Chose.md")).toBe(false);
    // One batched lookup, not one request per DOI.
    expect(requestedUrls).toHaveLength(1);
  });

  it("says which pasted identifiers it could not use", async () => {
    respondWith(openAlexPage([openAlexWork("W1", "A Real Paper", [], "10.1234/one")]));
    const { plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "seeds";
      p.settings.kernelSeeds = "10.1234/one\n10.1234/missing\nbanana";
    });

    await plugin.buildKernel();

    expect(notices.some((n) => n.includes("banana"))).toBe(true);
    expect(notices.some((n) => n.includes("10.1234/missing"))).toBe(true);
  });

  it("refuses each mode without its input, rather than fetching nothing", async () => {
    for (const [mode, field] of [
      ["seeds", "DOIs"],
      ["author", "author"],
    ] as const) {
      clearNotices();
      const { app, plugin } = await bootPlugin((p) => {
        p.settings.kernelMode = mode;
      });
      await plugin.buildKernel();
      expect(notices.join(" ").toLowerCase()).toContain(field.toLowerCase());
      expect(app.vault.files.size).toBe(0);
    }
  });

  it("snowballs a seed into its references and citers", async () => {
    // Seed cites W10; W20 cites the seed. Both directions must land.
    let call = 0;
    setRequestResponder(() => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          text: openAlexPage([openAlexWork("W1", "My Seed Paper", ["W10"], "10.1234/seed")]),
        };
      }
      if (call === 2) {
        return { status: 200, text: openAlexPage([openAlexWork("W10", "A Paper It Cites")]) };
      }
      return { status: 200, text: openAlexPage([openAlexWork("W20", "A Paper Citing It", ["W1"])]) };
    });

    const { app, plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "snowball";
      p.settings.kernelSeeds = "10.1234/seed";
      p.settings.kernelSize = 10;
    });

    await plugin.buildKernel();

    expect(app.vault.files.has("Papers/My Seed Paper.md")).toBe(true);
    expect(app.vault.files.has("Papers/A Paper It Cites.md")).toBe(true);
    expect(app.vault.files.has("Papers/A Paper Citing It.md")).toBe(true);
  });

  it("builds from one author", async () => {
    respondWith(openAlexPage([openAlexWork("W1", "Something She Wrote", [], "10.1234/one")]));
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "author";
      p.settings.kernelAuthor = "A5023888391";
    });

    await plugin.buildKernel();

    expect(app.vault.files.has("Papers/Something She Wrote.md")).toBe(true);
    expect(requestedUrls[0]).toContain("authorships.author.id");
  });

  it("expands outward from papers already in the vault", async () => {
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "library";
      p.settings.kernelSize = 10;
    });
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/An Existing Paper.md",
      keptNoteContent("An Existing Paper", "openalex:W1"),
    );

    let call = 0;
    setRequestResponder(() => {
      call += 1;
      // 1: resolve the library seed; 2: its references; 3: its citers.
      if (call === 1) {
        return {
          status: 200,
          text: openAlexPage([openAlexWork("W1", "An Existing Paper", ["W10"])]),
        };
      }
      if (call === 2) {
        return { status: 200, text: openAlexPage([openAlexWork("W10", "A Foundational Paper")]) };
      }
      return { status: 200, text: openAlexPage([openAlexWork("W20", "A Recent Follow-Up", ["W1"])]) };
    });

    await plugin.buildKernel();

    expect(app.vault.files.has("Papers/A Foundational Paper.md")).toBe(true);
    expect(app.vault.files.has("Papers/A Recent Follow-Up.md")).toBe(true);
    // The paper it started from is not duplicated.
    expect(app.vault.files.has("Papers/An Existing Paper 2.md")).toBe(false);
  });

  it("says so when the library is empty rather than building nothing quietly", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.kernelMode = "library";
    });

    await plugin.buildKernel();

    expect(notices.some((n) => n.includes("No papers with a usable identifier"))).toBe(true);
  });
});

describe("expanding from a specific selection (context menu)", () => {
  it("offers the menu item only for a selection that includes a kept paper", async () => {
    const { app, plugin } = await bootPlugin();
    await app.vault.createFolder("Papers");
    const paper = await app.vault.create(
      "Papers/An Existing Paper.md",
      keptNoteContent("An Existing Paper", "openalex:W1"),
    );
    await app.vault.createFolder("Inbox");
    const arrival = await app.vault.create(
      "Inbox/An Arrival.md",
      keptNoteContent("An Arrival", "openalex:W9"),
    );

    const onPaper = app.workspace.triggerFilesMenu([paper]);
    expect(onPaper.items.some((i) => i.title.includes("Expand outward"))).toBe(true);

    const onArrivalOnly = app.workspace.triggerFilesMenu([arrival]);
    expect(onArrivalOnly.items.some((i) => i.title.includes("Expand outward"))).toBe(false);

    void plugin; // menu registration happens in onload(), already exercised above
  });

  it("expands outward from just the selected papers, not the whole library", async () => {
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.kernelSize = 10;
    });
    await app.vault.createFolder("Papers");
    const selected = await app.vault.create(
      "Papers/Selected Paper.md",
      keptNoteContent("Selected Paper", "openalex:W1"),
    );
    // Present in the library but NOT selected — must play no part in the
    // expansion, unlike the "library" kernel mode which would include it.
    await app.vault.create(
      "Papers/Unrelated Kept Paper.md",
      keptNoteContent("Unrelated Kept Paper", "openalex:W99"),
    );

    let call = 0;
    setRequestResponder(() => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          text: openAlexPage([openAlexWork("W1", "Selected Paper", ["W10"])]),
        };
      }
      if (call === 2) {
        return { status: 200, text: openAlexPage([openAlexWork("W10", "A Reference")]) };
      }
      return { status: 200, text: openAlexPage([openAlexWork("W20", "A Citer", ["W1"])]) };
    });

    // The context menu opens a modal to confirm count/folder before running —
    // covered separately — so the expansion itself is driven directly here,
    // exactly as the modal's submit handler would call it.
    await plugin.expandFromNotes([selected as never]);

    expect(app.vault.files.has("Papers/A Reference.md")).toBe(true);
    expect(app.vault.files.has("Papers/A Citer.md")).toBe(true);
    void plugin;
  });

  it("writes to a custom folder and count when the modal's choices override the defaults", async () => {
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.kernelSize = 10;
    });
    await app.vault.createFolder("Papers");
    const selected = await app.vault.create(
      "Papers/Selected Paper.md",
      keptNoteContent("Selected Paper", "openalex:W1"),
    );

    let call = 0;
    setRequestResponder(() => {
      call += 1;
      if (call === 1) {
        return { status: 200, text: openAlexPage([openAlexWork("W1", "Selected Paper", ["W10"])]) };
      }
      if (call === 2) {
        return { status: 200, text: openAlexPage([openAlexWork("W10", "A Reference")]) };
      }
      return { status: 200, text: openAlexPage([]) };
    });

    await plugin.expandFromNotes([selected as never], { count: 1, folder: "Papers/Trapped Ions" });

    expect(app.vault.files.has("Papers/Trapped Ions/A Reference.md")).toBe(true);
    expect(app.vault.files.has("Papers/A Reference.md")).toBe(false);
  });

  it("says so when nothing in the selection is a usable paper", async () => {
    const { app, plugin } = await bootPlugin();
    await app.vault.createFolder("Inbox");
    const arrival = await app.vault.create(
      "Inbox/An Arrival.md",
      keptNoteContent("An Arrival", "openalex:W9"),
    );

    await plugin.expandFromNotes([]);
    expect(notices.some((n) => n.toLowerCase().includes("select papers"))).toBe(true);

    void arrival;
  });
});

describe("adding papers by hand", () => {
  it("accepts the DOI URL you copy from a browser", async () => {
    // Regression: the old routing sent anything not starting with "10." to the
    // arXiv client, so a doi.org URL could only ever fail.
    respondWith(openAlexPage([openAlexWork("W1", "A Paper By URL", [], "10.1234/one")]));
    const { app, plugin } = await bootPlugin();

    await plugin.addByIds("https://doi.org/10.1234/one", "papers");

    expect(app.vault.files.has("Papers/A Paper By URL.md")).toBe(true);
    expect(requestedUrls[0]).toContain("doi%3A10.1234%2Fone");
  });

  it("adds a list straight to the kept folder", async () => {
    respondWith(
      openAlexPage([
        openAlexWork("W1", "First Paper", [], "10.1234/one"),
        openAlexWork("W2", "Second Paper", [], "10.1234/two"),
      ]),
    );
    const { app, plugin } = await bootPlugin();

    await plugin.addByIds("10.1234/one\n10.1234/two", "papers");

    expect(app.vault.files.has("Papers/First Paper.md")).toBe(true);
    expect(app.vault.files.has("Papers/Second Paper.md")).toBe(true);
    expect(plugin.status().inboxCount).toBe(0);
  });

  it("adds to the inbox when asked, exempt from cleanup", async () => {
    respondWith(openAlexPage([openAlexWork("W1", "A Triage Paper", [], "10.1234/one")]));
    const { app, plugin } = await bootPlugin();

    await plugin.addByIds("10.1234/one", "inbox");

    expect(app.vault.files.has("Inbox/A Triage Paper.md")).toBe(true);
    const records = (plugin as never as { inbox: { manual?: boolean }[] }).inbox;
    expect(records[0]?.manual).toBe(true);
  });

  it("refuses an empty box instead of making a request", async () => {
    const { plugin } = await bootPlugin();
    await plugin.addByIds("   ", "papers");
    expect(requestedUrls).toHaveLength(0);
    expect(notices.some((n) => n.includes("DOI"))).toBe(true);
  });
});

describe("choosing arrivals by citation adjacency", () => {
  /** A vault with one kept paper, which is what adjacency anchors on. */
  async function vaultWithKeptPaper(
    configure?: (plugin: LiteratureInboxPlugin) => void,
    originId = "openalex:W1",
  ) {
    const booted = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.sources = [{ kind: "citing", value: "", enabled: true }];
      configure?.(p);
    });
    await booted.app.vault.createFolder("Papers");
    await booted.app.vault.create(
      "Papers/An Existing Paper.md",
      keptNoteContent("An Existing Paper", originId),
    );
    return booted;
  }

  it("asks what has cited the papers you keep", async () => {
    respondWith(openAlexPage([openAlexWork("W9", "A Paper Citing Yours", ["W1"], "10.1234/nine")]));
    const { app, plugin } = await vaultWithKeptPaper();

    await plugin.updateInbox();

    expect(requestedUrls[0]).toContain("cites%3AW1");
    expect(app.vault.files.has("Inbox/A Paper Citing Yours.md")).toBe(true);
  });

  it("wires the arrival to the paper it cited, so the why-line fires", async () => {
    // The entire point: an arrival chosen this way is connected by
    // construction rather than by hoping an edge exists.
    respondWith(openAlexPage([openAlexWork("W9", "A Paper Citing Yours", ["W1"], "10.1234/nine")]));
    const { app, plugin } = await vaultWithKeptPaper();

    await plugin.updateInbox();

    const arrival = app.vault.files.get("Inbox/A Paper Citing Yours.md") as string;
    expect(arrival).toContain("Why you're seeing this");
    expect(arrival).toContain("[[An Existing Paper]]");
  });

  it("resolves a DOI-only library into anchors rather than skipping it", async () => {
    // A note with only a DOI and no OpenAlex id is a normal case — a
    // hand-added paper, say. Without this lookup, adjacency would silently
    // find nothing for those users.
    let call = 0;
    setRequestResponder((url) => {
      call += 1;
      if (call === 1) {
        expect(url).toContain("doi%3A10.1234%2Fkept");
        return { status: 200, text: openAlexPage([openAlexWork("W1", "An Existing Paper")]) };
      }
      return {
        status: 200,
        text: openAlexPage([openAlexWork("W9", "A Paper Citing Yours", ["W1"])]),
      };
    });
    const { app, plugin } = await vaultWithKeptPaper(
      (p) => {
        p.settings.arrivalSelection = "adjacent";
      },
      "doi:10.1234/kept",
    );

    await plugin.updateInbox();

    expect(requestedUrls[1]).toContain("cites%3AW1");
    expect(app.vault.files.has("Inbox/A Paper Citing Yours.md")).toBe(true);
  });

  it("says the library is empty instead of reporting a normal quiet run", async () => {
    respondWith(openAlexPage([]));
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [{ kind: "citing", value: "", enabled: true }];
    });

    await plugin.updateInbox();

    expect(notices.some((n) => n.includes("source error"))).toBe(true);
  });

  it("puts citing papers ahead of topic matches, so the cap keeps the better ones", async () => {
    // When maxArrivalsPerRun bites, connectivity to your kept library decides
    // what survives — not which source listed it first. A paper citing your
    // library has a real edge; one that merely matched a topic string has
    // none, so it loses the cap regardless of source order.
    let call = 0;
    setRequestResponder(() => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          text: openAlexPage([openAlexWork("W9", "A Paper Citing Yours", ["W1"], "10.1234/nine")]),
        };
      }
      return {
        status: 200,
        text: openAlexPage([openAlexWork("W8", "A Topic Match", [], "10.1234/eight")]),
      };
    });
    const { app, plugin } = await vaultWithKeptPaper((p) => {
      p.settings.sources = [
        { kind: "citing", value: "", enabled: true },
        { kind: "topic", value: "transformers", enabled: true },
      ];
      p.settings.maxArrivalsPerRun = 1;
    });

    await plugin.updateInbox();

    expect(app.vault.files.has("Inbox/A Paper Citing Yours.md")).toBe(true);
    expect(app.vault.files.has("Inbox/A Topic Match.md")).toBe(false);
  });

  it("skips the adjacency query entirely in topic-only mode", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await vaultWithKeptPaper((p) => {
      p.settings.sources = [{ kind: "topic", value: "transformers", enabled: true }];
    });

    await plugin.updateInbox();

    expect(requestedUrls.every((url) => !url.includes("cites"))).toBe(true);
  });
});

describe("Crossref alongside OpenAlex", () => {
  const crossrefMessage = (doi: string, title: string, refs: string[]) => ({
    DOI: doi,
    type: "journal-article",
    title: [title],
    author: [{ given: "Ada", family: "Lovelace" }],
    issued: { "date-parts": [[2026, 5, 1]] },
    reference: refs.map((ref) => ({ DOI: ref })),
  });

  /** Crossref answers a single-record lookup and a search with *different*
   * shapes — `message` versus `message.items[]`. Serving one for both is the
   * quickest way to write a test that passes for the wrong reason. */
  const crossrefFor = (url: string, doi: string, title: string, refs: string[]) =>
    url.includes("query.bibliographic")
      ? JSON.stringify({ status: "ok", message: { items: [crossrefMessage(doi, title, refs)] } })
      : JSON.stringify({ status: "ok", message: crossrefMessage(doi, title, refs) });

  it("falls back to Crossref for references OpenAlex does not have", async () => {
    // OpenAlex answers the arrival query but has no reference list for it;
    // Crossref has the publisher's deposit. Half the edges beats none.
    let openAlexCalls = 0;
    setRequestResponder((url) => {
      if (url.startsWith("https://api.crossref.org")) {
        return { status: 200, text: crossrefFor(url, "10.1234/one", "A Paper", ["10.1234/kept"]) };
      }
      // The topic is resolved to a concept id first; that lookup isn't one
      // of the "did the search return the arrival" calls being counted.
      if (url.includes("/concepts")) {
        return { status: 200, text: JSON.stringify({ results: [] }) };
      }
      openAlexCalls += 1;
      // The arrival arrives with no reference list of its own.
      return openAlexCalls === 1
        ? {
            status: 200,
            text: openAlexPage([openAlexWork("W1", "A Paper", [], "10.1234/one")]),
          }
        : { status: 200, text: openAlexPage([]) };
    });

    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      // Topic-only, so the OpenAlex call order is deterministic.
      p.settings.arrivalSelection = "topic";
      p.settings.crossrefEnabled = true;
    });
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Paper I Kept.md",
      keptNoteContent("A Paper I Kept", "doi:10.1234/kept"),
    );

    await plugin.updateInbox();
    ageBackfillState(plugin, 5);
    await plugin.updateInbox();

    const arrival = app.vault.files.get("Inbox/A Paper.md") as string;
    expect(arrival).toContain("[[A Paper I Kept]]");
  });

  it("never contacts Crossref when the user turns it off", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.crossrefEnabled = false;
    });

    await plugin.updateInbox();
    ageBackfillState(plugin, 5);
    await plugin.updateInbox();

    expect(requestedUrls.some((url) => url.includes("crossref.org"))).toBe(false);
  });

  it("still works when OpenAlex is switched off entirely", async () => {
    // Crossref cannot answer "papers citing my library", but it can resolve
    // and enrich whatever a feed brings in.
    setRequestResponder((url) =>
      url.startsWith("https://api.crossref.org")
        ? { status: 200, text: crossrefFor(url, "10.1234/feed", "A Feed Paper", ["10.1234/kept"]) }
        : {
            status: 200,
            text:
              `<?xml version="1.0"?><rss version="2.0"><channel><title>J</title>` +
              `<item><title>A Feed Paper</title><link>https://example.org/a</link></item>` +
              `</channel></rss>`,
          },
    );

    const { app, plugin } = await bootPlugin((p) => {
      p.settings.crossrefEnabled = true;
      p.settings.sources = [
        { kind: "feed", value: "https://example.org/f.xml", enabled: true },
      ];
    });
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Paper I Kept.md",
      keptNoteContent("A Paper I Kept", "doi:10.1234/kept"),
    );

    await plugin.updateInbox();
    ageBackfillState(plugin, 5);
    await plugin.updateInbox();

    const arrival = app.vault.files.get("Inbox/A Feed Paper.md") as string;
    expect(arrival).toContain("[[A Paper I Kept]]");
  });
});

describe("what should I read?", () => {
  it("suggests a paper from the inbox", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin(enableOpenAlex);
    await plugin.updateInbox();

    await plugin.suggestPaper();

    // The modal names a real arrival rather than failing quietly.
    expect(notices.some((n) => n.includes("No papers yet"))).toBe(false);
  });

  it("says so when there is nothing to suggest", async () => {
    const { plugin } = await bootPlugin();
    await plugin.suggestPaper();
    expect(notices.some((n) => n.includes("No papers yet"))).toBe(true);
  });

  it("ignores notes the user wrote themselves", async () => {
    // A prose note has no identity and is none of this command's business.
    const { app, plugin } = await bootPlugin();
    await app.vault.createFolder("Papers");
    await app.vault.create("Papers/My Thoughts.md", "# My Thoughts\n\nprose\n");

    await plugin.suggestPaper();

    expect(notices.some((n) => n.includes("No papers yet"))).toBe(true);
  });

  it("skips papers already marked read", async () => {
    const { app, plugin } = await bootPlugin();
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Read Paper.md",
"---\ntitle: A Read Paper\norigin-ids:\n  - doi:10.1/x\nread-status: read\n---\n\nbody\n",
    );

    await plugin.suggestPaper();

    expect(notices.some((n) => n.includes("marked read or reference"))).toBe(true);
  });

  it("puts a paper you marked read beyond cleanup's reach", async () => {
    // Saying you have read something is engagement, and cleanup is only for
    // arrivals nobody looked at. Leaving the recorded hash stale is what makes
    // the note count as touched, which is exactly the guard we want here.
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.readStatusEnabled = true;
    });
    await plugin.updateInbox();

    const path = "Inbox/A Paper About Transformers.md";
    await plugin.setReadStatus(path, "read");

    const content = app.vault.files.get(path) as string;
    expect(content).toContain("read-status: read");

    // Cleanup now sees a note that no longer matches what it generated.
    const { contentHash } = await import("../src/core/hash");
    const record = (plugin as never as { inbox: { notePath: string; contentHash: string }[] }).inbox
      .find((r) => r.notePath === path);
    expect(record?.contentHash).not.toBe(contentHash(content));

    plugin.settings.pruneEnabled = true;
    plugin.settings.keepWindowDays = 0;
    await plugin.cleanUp();
    expect(app.vault.files.has(path)).toBe(true);
  });

  it("writes no read-status property unless the feature is on", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await plugin.updateInbox();

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note).not.toContain("read-status");
  });

  it("seeds the property when the feature is on", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.readStatusEnabled = true;
    });
    await plugin.updateInbox();

    const note = app.vault.files.get("Inbox/A Paper About Transformers.md") as string;
    expect(note).toContain("read-status: to-read");
  });
});

describe("keeping a paper", () => {
  it("keeps the library count in step", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await plugin.updateInbox();
    expect(plugin.status().keptCount).toBe(0);

    const file = app.vault.getAbstractFileByPath("Inbox/A Paper About Attention.md");
    await plugin.keepActiveNote(file as never);

    expect(plugin.status().keptCount).toBe(1);
    expect(plugin.status().inboxCount).toBe(1);
  });
});

describe("per-feed settings", () => {
  const feedItem = (title: string, date: string) =>
    `<item><title>${title}</title><link>https://example.org/${title}</link>` +
    `<pubDate>${date}</pubDate></item>`;
  const feedXml = (items: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>A Journal</title>` +
    `${items}</channel></rss>`;

  it("uses the one global window for every source, ignoring a stale per-row override", async () => {
    // Regression: a per-source "days back" control used to exist and is now
    // gone from the UI — recency is why a result is in the inbox at all, so
    // it isn't a per-row knob anymore. Any leftover `windowDays` from an
    // older settings file (migrated from the pre-rows feed shape) must not
    // silently keep acting as an override.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toUTCString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toUTCString();
    respondWith(
      feedXml(
        feedItem("Recent Paper", twoDaysAgo) +
          feedItem("Outside The Global Window", tenDaysAgo),
      ),
    );
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.newWindowDays = 7;
      p.settings.sources = [
        // windowDays: 30 would have kept both papers under the old per-row
        // behaviour — it must now be ignored in favour of the 7-day global.
        { kind: "feed", value: "https://example.org/f.xml", enabled: true, windowDays: 30 },
      ];
    });

    await plugin.updateInbox();

    expect(app.vault.files.has("Inbox/Recent Paper.md")).toBe(true);
    expect(app.vault.files.has("Inbox/Outside The Global Window.md")).toBe(false);
  });

  it("honours a per-feed cap", async () => {
    // Relative to whenever the suite actually runs — a hardcoded date drifts
    // out of the (now 14-day default) window the moment real time catches up.
    const recently = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toUTCString();
    respondWith(feedXml(feedItem("First Paper", recently) + feedItem("Second Paper", recently)));
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "feed", value: "https://example.org/f.xml", enabled: true, maxPerRun: 1 },
      ];
    });

    await plugin.updateInbox();

    expect(app.vault.files.has("Inbox/First Paper.md")).toBe(true);
    expect(app.vault.files.has("Inbox/Second Paper.md")).toBe(false);
  });

  it("skips a disabled row without deleting its settings", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "feed", value: "https://example.org/f.xml", enabled: false, windowDays: 7 },
      ];
    });

    await plugin.updateInbox();

    expect(requestedUrls).toHaveLength(0);
    expect(plugin.settings.sources[0]?.windowDays).toBe(7);
  });

  it("migrates a pre-rows settings file instead of losing the sources", async () => {
    const app = new App();
    const plugin = new LiteratureInboxPlugin(app as never, {} as never);
    await plugin.saveData({
      settings: {
        ...plugin.settings,
        // Empty, as a pre-rows settings file would be.
        sources: [],
        openAlexEnabled: true,
        openAlexTopic: "transformers",
        arrivalSelection: "both",
        arxivEnabled: true,
        arxivCategories: "quant-ph",
        rssEnabled: true,
        feeds: [{ url: "https://old.example/f.xml", enabled: true }],
      },
      inbox: [],
    });

    await plugin.onload();

    expect(plugin.settings.sources.map((s) => `${s.kind}:${s.value}`)).toEqual([
      "citing:",
      "topic:transformers",
      "arxiv:quant-ph",
      "feed:https://old.example/f.xml",
    ]);
    // Old keys are dropped, so migration runs exactly once.
    expect(plugin.settings.arxivCategories).toBeUndefined();
    expect(plugin.settings.feeds).toBeUndefined();
  });

  it("renders one row per source, whatever its kind", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "citing", value: "", enabled: true },
        { kind: "feed", value: "https://a.example/f.xml", enabled: true },
      ];
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const rows = allSettings.filter((s: Setting) =>
      s.settingEl.classList.contains("literature-inbox-feed-row"),
    );
    expect(rows).toHaveLength(2);
    // "Papers citing my library" has nothing to type, so no value box: papers
    // per run and folder are the only text fields.
    expect(rows[0]?.texts).toHaveLength(2);
    // A feed adds the URL box on top of those two.
    expect(rows[1]?.texts).toHaveLength(3);
    // Test only ever shows on the add-source draft now, not an added row.
    expect(rows[1]?.buttons).toHaveLength(1);
    expect(rows[1]?.buttons[0]?.text).toBe("Remove");
  });

  it("the draft add-source row has no toggle or remove button, unlike an added row", async () => {
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const draft = allSettings.find((s: Setting) => s.name === "Add a source");
    expect(draft?.toggles).toHaveLength(0);
    expect(draft?.buttons.some((b) => b.text === "Remove")).toBe(false);
    expect(draft?.buttons.some((b) => b.text === "Add source")).toBe(true);

    const existingRow = allSettings.find(
      (s: Setting) => s.settingEl.classList.contains("literature-inbox-feed-row"),
    );
    expect(existingRow?.toggles).toHaveLength(1);
    expect(existingRow?.buttons.some((b) => b.text === "Remove")).toBe(true);
  });

  it("only ever shows Test on the draft, never on an added row, even for arxiv/feed", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "arxiv", value: "cs.CL", enabled: true },
        { kind: "feed", value: "https://a.example/f.xml", enabled: true },
      ];
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const rows = allSettings.filter((s: Setting) =>
      s.settingEl.classList.contains("literature-inbox-feed-row"),
    );
    for (const row of rows) expect(row.buttons.some((b) => b.text === "Test")).toBe(false);

    const draft = allSettings.find((s: Setting) => s.name === "Add a source");
    // Default draft kind is "topic", which has no Test button either.
    expect(draft?.buttons.some((b) => b.text === "Test")).toBe(false);
  });

  it("shows a real per-run default and folder value, not just a greyed hint", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.inboxFolder = "Inbox";
      p.settings.maxArrivalsPerRun = 3;
      p.settings.sources = [{ kind: "citing", value: "", enabled: true }];
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const row = allSettings.find((s: Setting) =>
      s.settingEl.classList.contains("literature-inbox-feed-row"),
    );
    // Unset, so both fields show the resolved default as real, editable text.
    expect(row?.texts[0]?.value).toBe("3");
    expect(row?.texts[1]?.value).toBe("Inbox");
  });

  it("has no leftover column-legend text once the header exists", async () => {
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const row = allSettings.find((s: Setting) =>
      s.settingEl.classList.contains("literature-inbox-feed-row"),
    );
    expect(row?.desc).toBe("");
    const draft = allSettings.find((s: Setting) => s.name === "Add a source");
    expect(draft?.desc).toBe("");
  });

  it("commits the draft into a real, on-by-default row and resets the draft", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [];
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const draftKind = allSettings.find((s: Setting) => s.name === "Add a source");
    clearSettings(); // the select below re-renders; only the fresh render matters next
    await draftKind?.dropdowns[0]?.simulateSelect("arxiv");

    const draftAfterKindChange = allSettings.find((s: Setting) => s.name === "Add a source");
    // arXiv's value control is a category dropdown, not a plain text box.
    expect(draftAfterKindChange?.dropdowns).toHaveLength(2); // kind + category
    clearSettings();
    await draftAfterKindChange?.dropdowns[1]?.simulateSelect("cs.CL");

    const draftAfterCategory = allSettings.find((s: Setting) => s.name === "Add a source");
    const addButton = draftAfterCategory?.buttons.find((b) => b.text === "Add source");
    clearSettings();
    await addButton?.simulateClick();

    expect(plugin.settings.sources).toEqual([{ kind: "arxiv", value: "cs.CL", enabled: true }]);

    // The draft reset back to its default kind, with nothing typed.
    const draftAfterAdd = allSettings.find((s: Setting) => s.name === "Add a source");
    expect(draftAfterAdd?.dropdowns[0]?.value).toBe("topic");
  });

  it("refuses to add a source that needs a value but has none", async () => {
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [];
    });
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const draft = allSettings.find((s: Setting) => s.name === "Add a source");
    await draft?.dropdowns[0]?.simulateSelect("topic"); // needs a value, none typed
    const addButton = draft?.buttons.find((b) => b.text === "Add source");
    await addButton?.simulateClick();

    expect(plugin.settings.sources).toEqual([]);
  });
});

describe("per-source inbox folders", () => {
  it("writes an arrival into its source's own subfolder, nested under the parent", async () => {
    respondWith(openAlexPage([openAlexWork("W1", "A Topic Paper", [], "10.1234/one")]));
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "topic", value: "transformers", enabled: true, inboxFolder: "ArXiv" },
      ];
    });

    await plugin.updateInbox();

    expect(app.vault.files.has("Inbox/ArXiv/A Topic Paper.md")).toBe(true);
    expect(app.vault.files.has("Inbox/A Topic Paper.md")).toBe(false);
  });

  it("cleanup still finds an expired arrival in a per-source subfolder", async () => {
    // Cleanup trusts one prefix match against the *parent* inbox folder — the
    // whole point of nesting every source folder under it (see
    // effectiveInboxFolder) is that this keeps working with no folder-specific
    // cleanup logic at all.
    respondWith(openAlexPage([openAlexWork("W1", "A Topic Paper", [], "10.1234/one")]));
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "topic", value: "transformers", enabled: true, inboxFolder: "ArXiv" },
      ];
      p.settings.pruneEnabled = true;
      p.settings.keepWindowDays = 1;
    });
    await plugin.updateInbox();

    const record = (plugin as never as { inbox: { arrivedOn: string }[] }).inbox[0];
    if (record) record.arrivedOn = "2020-01-01";

    await plugin.cleanUp();

    // ConfirmPruneModal only opens when there's something prunable — reaching
    // it at all proves cleanup found the note in its nested subfolder.
    expect(notices.some((n) => n.includes("Nothing to clean up"))).toBe(false);
  });
});

describe("settings page: layout details", () => {
  it("preserves scroll position across a re-render", async () => {
    const { plugin } = await bootPlugin();
    const tab = (plugin as never as { settingTab: { containerEl: HTMLElement; display: () => void } })
      .settingTab;
    tab.display();
    tab.containerEl.scrollTop = 250;

    tab.display();

    expect(tab.containerEl.scrollTop).toBe(250);
  });

  it("shows the library directory setting with subfolder guidance", async () => {
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const setting = allSettings.find((s: Setting) => s.name === "Library directory");
    expect(setting).toBeDefined();
    expect(setting?.desc.toLowerCase()).toContain("subfolder");
  });

  it("has no standalone Folders or Everyday section, or a graph-setup section", async () => {
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const headings = allSettings.filter((s: Setting) => s.isHeading).map((s: Setting) => s.name);
    expect(headings).not.toContain("Folders");
    expect(headings).not.toContain("Everyday");
    expect(headings.some((h) => h.toLowerCase().includes("set up the graph"))).toBe(false);
    expect(allSettings.some((s: Setting) => s.name === "Papers folder")).toBe(false);
    expect(allSettings.some((s: Setting) => s.name === "Maximum arrivals per run")).toBe(false);
  });

  it("shows one global window setting instead of a per-row one", async () => {
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    expect(allSettings.some((s: Setting) => s.name === "How far back counts as new")).toBe(true);
  });
});

describe("what counts as new", () => {
  it("asks OpenAlex for the window the user configured", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { plugin } = await bootPlugin((p) => {
      enableOpenAlex(p);
      p.settings.newWindowDays = 7;
    });

    await runCommand(plugin, "update-inbox");

    // The colon is percent-encoded in the query string, so match the parts.
    // The topic is resolved to a concept id first, via a separate request.
    const url = requestedUrls.find((u) => u.includes("/works?")) as string;
    expect(url).toContain("from_publication_date");
    expect(url).toContain(isoDaysAgo(7));
  });

  it("defaults to a window wide enough to return something on day one", async () => {
    const { plugin } = await bootPlugin();
    expect(plugin.settings.newWindowDays).toBe(14);
  });
});

describe("testing feeds before trusting them", () => {
  const feedXml = (title: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>A Journal</title>` +
    `<item><title>${title}</title><link>https://example.org/a</link></item>` +
    `</channel></rss>`;

  it("says so rather than silently doing nothing when no feeds are set", async () => {
    const { plugin } = await bootPlugin();
    await plugin.testFeeds();
    expect(notices.some((n) => n.includes("feed URL"))).toBe(true);
    expect(requestedUrls).toHaveLength(0);
  });

  it("fetches every configured feed once, even with the source switched off", async () => {
    // Testing a feed before enabling the source is the normal order — you
    // paste a URL, check it works, then turn it on.
    respondWith(feedXml("A Recent Paper"));
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [
        { kind: "feed", value: "https://example.org/one.xml", enabled: false },
        { kind: "feed", value: "https://example.org/two.xml", enabled: false },
      ];
    });

    await plugin.testFeeds();

    expect(requestedUrls).toEqual([
      "https://example.org/one.xml",
      "https://example.org/two.xml",
    ]);
  });

  it("reports a dead feed instead of throwing", async () => {
    setRequestResponder(() => {
      throw new Error("ENOTFOUND");
    });
    const { plugin } = await bootPlugin((p) => {
      p.settings.sources = [{ kind: "feed", value: "https://example.org/dead.xml", enabled: true }];
    });

    await expect(plugin.testFeeds()).resolves.toBeUndefined();
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

  it("can ask OpenAlex for today's figures on demand, without a full run", async () => {
    respondWith(openAlexPage([]));
    const { plugin } = await bootPlugin();

    await plugin.refreshBudget();

    // The cheapest possible request — a filtered singleton page — not a
    // search, and not tied to any source being configured.
    expect(requestedUrls[0]).toContain("per-page=1");
    expect(requestedUrls[0]).not.toContain("default.search");
  });

  it("renders every settings section without throwing", async () => {
    const { plugin } = await bootPlugin();
    const tab = (plugin as never as { settingTab: { display: () => void } }).settingTab;
    expect(() => tab.display()).not.toThrow();

    const headings = allSettings.filter((s: Setting) => s.isHeading).map((s: Setting) => s.name);
    expect(headings).toContain("Update your inbox");
    // The heading itself has to say cleanup never runs on its own — that is
    // the misreading the wording exists to prevent.
    expect(headings).toContain("Clean out your inbox");
    expect(headings).toContain("What goes in a note");
    expect(headings).toContain("Network and integrations");
  });

  it("puts the add-papers action in front of the user", async () => {
    // Named for a thing you do repeatedly, not a one-off "build": adding to
    // the graph is meant to be re-run whenever you like. It's its own row at
    // the bottom of the section, below whichever mode-specific fields are
    // showing, rather than sharing a row with the mode dropdown.
    const { plugin } = await bootPlugin();
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();
    const button = allSettings.find((s: Setting) =>
      s.buttons.some((b) => b.text === "Add papers"),
    );
    expect(button).toBeDefined();
  });

  it("wires the settings buttons to real actions", async () => {
    respondWith(DEFAULT_RESPONSE);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    (plugin as never as { settingTab: { display: () => void } }).settingTab.display();

    const update = allSettings.find((s: Setting) => s.name.includes("Fetch new papers"));
    await update?.buttons[0]?.simulateClick();
    await waitForIdle(plugin);

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

    // Backfill is scheduled, not repeated: a second run the same day
    // deliberately does not re-ask. Age the record to stand in for a later
    // day, which is when the retry is actually due.
    ageBackfillState(plugin, 5);

    phase = 1;
    await runCommand(plugin, "update-inbox");

    const second = app.vault.files.get("Inbox/An Isolated Preprint Paper.md") as string;
    expect(second).toContain("## Citations");
    expect(second).toContain("[[A Paper I Kept]]");
  });

  it("does not re-ask about the same isolated arrival twice in one day", async () => {
    // This is the saving: previously every edge-less arrival was re-queried on
    // every run, forever — around 25 requests per update against a daily
    // allowance of roughly 100.
    let phase = 0;
    stagedResponder(() => phase);
    const { plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    clearRequests();
    phase = 1;
    await runCommand(plugin, "update-inbox");

    expect(requestedUrls.some((url) => url.includes("title.search"))).toBe(false);
  });

  it("gives up after three tries and says so on the note", async () => {
    let phase = 0;
    stagedResponder(() => phase);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await runCommand(plugin, "update-inbox");

    // Three scheduled attempts: the next day, a few days later, then a month.
    for (const days of [2, 10, 40]) {
      ageBackfillState(plugin, days);
      await runCommand(plugin, "update-inbox");
    }

    const note = app.vault.files.get("Inbox/An Isolated Preprint Paper.md") as string;
    expect(note).toContain("No citation links found");
  });

  it("never rewrites a note the user has edited, when backfill isn't due yet", async () => {
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

  it("still adds a newly-found citation link to an edited note, once backfill is due", async () => {
    // The citations block is additive-only and self-contained, so it's safe
    // to update even on a note the user has otherwise edited — unlike the
    // note as a whole, which cleanup must never touch. What "My own notes."
    // is standing in for here is real work; losing it to a backfill update
    // would be exactly the kind of destructive surprise this plugin promises
    // never to cause.
    let phase = 0;
    stagedResponder(() => phase);
    const { app, plugin } = await bootPlugin(enableOpenAlex);
    await app.vault.createFolder("Papers");
    await app.vault.create(
      "Papers/A Paper I Kept.md",
      keptNoteContent("A Paper I Kept", "openalex:W99"),
    );
    await runCommand(plugin, "update-inbox");

    const path = "Inbox/An Isolated Preprint Paper.md";
    const generated = app.vault.files.get(path) as string;
    const edited = `${generated}\n\nMy own notes.\n`;
    app.vault.files.set(path, edited);

    const recordBefore = (
      plugin as never as { inbox: { notePath: string; contentHash: string }[] }
    ).inbox.find((r) => r.notePath === path);
    const hashBefore = recordBefore?.contentHash;

    ageBackfillState(plugin, 5);
    phase = 1;
    await runCommand(plugin, "update-inbox");

    const updated = app.vault.files.get(path) as string;
    expect(updated).toContain("[[A Paper I Kept]]");
    expect(updated).toContain("My own notes.");

    // Cleanup safety must not weaken: this note was edited before the link
    // was added, so it must still read as "touched" afterward — the tracked
    // hash must not be laundered into matching the newly-written content.
    const recordAfter = (
      plugin as never as { inbox: { notePath: string; contentHash: string }[] }
    ).inbox.find((r) => r.notePath === path);
    expect(recordAfter?.contentHash).toBe(hashBefore);
  });

  it("connects an arXiv arrival through its derived DOI on the very next run", async () => {
    // Unlike a bare title guess (expensive, un-batchable, hence rationed on
    // the widening schedule above), an arXiv id resolves through the same
    // cheap batched DOI lookup as a real DOI — so there's no reason to make
    // it wait. No `ageBackfillState` here: this connects on the same run.
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toUTCString();
    setRequestResponder((url) => {
      if (url.includes("rss.arxiv.org")) {
        return {
          status: 200,
          text:
            `<?xml version="1.0"?><rss version="2.0"><channel><title>arXiv</title>` +
            `<item><title>A Fresh Preprint</title>` +
            `<link>https://arxiv.org/abs/2401.12345</link>` +
            `<pubDate>${recent}</pubDate></item></channel></rss>`,
        };
      }
      // The backfill's batched DOI lookup, on this same run.
      return {
        status: 200,
        text: openAlexPage([
          openAlexWork("W1", "A Fresh Preprint", ["W99"], "10.48550/arxiv.2401.12345"),
        ]),
      };
    });
    const { app, plugin } = await bootPlugin((p) => {
      p.settings.sources = [{ kind: "arxiv", value: "cs.CL", enabled: true }];
    });
    await app.vault.createFolder("Papers");
    await app.vault.create("Papers/Cited Paper.md", keptNoteContent("Cited Paper", "openalex:W99"));

    await runCommand(plugin, "update-inbox");

    const note = app.vault.files.get("Inbox/A Fresh Preprint.md") as string;
    expect(note).toContain("## Citations");
    expect(note).toContain("[[Cited Paper]]");
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
