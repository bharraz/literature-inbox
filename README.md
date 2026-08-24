# Literature Inbox

An Obsidian plugin that turns new scholarly papers into **nodes in your graph,
already wired by citation edges to the papers you keep** — instead of a list of
titles in an RSS reader or email alert. A new arrival that lands connected to
five papers you care about is visually loud; an isolated dot is easy to ignore.
You triage by looking at the graph, open what looks interesting, and everything
you never touched quietly cleans itself out.

> **Status:** built and tested (463 hermetic tests, `tsc` clean, plus live
> harnesses that build a real vault and measure connectivity). Loaded in a real
> vault; still being shaken out. See `roadmap.md` for design context and the
> path to the community store, `docs/interop-spec.md` for the note-format
> conventions, and `docs/openalex-dependency.md` for exactly what this plugin
> needs from OpenAlex and what would break if that changed.

## The core loop

1. **Arrive.** On a manual "Update inbox" run (never a background daemon), new
   papers are fetched from your configured sources and land as notes in
   `Inbox/`, each wired via exact citation edges (OpenAlex reference lists — no
   PDFs, no fuzzy matching) to the papers already in your vault.
2. **Keep window.** Arrivals sit in `Inbox/` for a configurable window
   (default ~30 days).
3. **Keep = move it out.** Want to keep a paper? Move the note from `Inbox/`
   into `Papers/`. That's the whole mechanism — no checkbox to tick, no
   round-trip through Zotero, no state to infer. Drag it in Obsidian, or use
   the one-click **"Keep this paper"** command; both do exactly the same thing,
   because *the folder is the source of truth*, not a command having been run.
   Obsidian rewrites inbound wikilinks automatically on a move, so nothing
   dangles. The plugin only ever touches notes still in `Inbox/`.
4. **Clean out.** Notes still in `Inbox/` past the window, and still
   hash-identical to what was generated (never edited), are cleaned up —
   **preview first, confirm, then Obsidian trash** (`app.vault.trash`,
   recoverable). Never a silent or hard delete. A "keep everything, prune
   nothing" setting exists. Files the plugin didn't generate are invisible to
   cleanup, always — and so is anything you've edited, even in place.

## Setting the graph up

The plugin writes notes; Obsidian draws the graph. One 30-second setup turns
the graph into a triage surface, and it only has to be done once per vault:

- **Graph settings → Filters**, search box: `path:Inbox OR path:Papers`
- **Graph settings → Groups**: a bright colour for `path:Inbox`, a muted one
  for `path:Papers`

Arrivals are then the bright dots and your library is the background they wire
themselves into.

Notes carry **no `inbox` or `kept` tag**, on purpose. A tag is written once,
when the note is generated, and cannot follow a file you later drag from one
folder to another — so it would claim a paper you kept was still an arrival.
The folder is the source of truth for whether a paper is kept, and the graph
should ask the same question the plugin does.

## Cleanup is manual, always

There is no timer, no scheduler, and no background task anywhere in this
plugin. Nothing is fetched on load, and no note is ever removed unless you
press **Clean up now** in settings — which then shows you the exact list and
asks. The "unlock the cleanup button" toggle is off by default and does not
schedule anything; it only decides whether that button is allowed to work.

## Sources and their ergonomics

Configured in settings, each independently enabled with a per-run arrival cap
(a misconfigured source produces a warning, not a flooded vault):

- **OpenAlex topic** — free-text or topic query; settings show a live preview
  of the top ~20 titles ("does this look like your field?") before committing.
  Best edges: OpenAlex provides full reference lists.
- **arXiv categories** (e.g. `cs.CL`) — the freshest stream for STEM. You type
  the category; the plugin turns it into arXiv's RSS feed for you.
- **RSS/Atom feeds (bring your own URL)** — journal TOCs, bioRxiv, Scholar
  alerts, one row each with its own window and per-run cap. Identity is the
  item's `guid` (falling back to its link).

Feed items carry no reference list, so they arrive as isolated dots and are
connected later: a scheduled backfill re-asks OpenAlex on three widening
attempts (next run, ~4 days, ~30 days) and then says so on the note if the
paper was never indexed. Resolving them *immediately* would cost OpenAlex's
most expensive call type for a near-certain miss — see
`docs/openalex-dependency.md`.

## What this costs you

Nothing, and no account is required. OpenAlex meters a free daily allowance
(1,000 credits without a key); an ordinary update run costs around 14. A free
API key raises the allowance roughly tenfold and is worth adding if you build
large starting graphs — it's an optional setting, and the plugin never ships
one. The settings page shows a live gauge of what's left today.

**Identity discipline:** the same paper via two sources is one note. A note
records *every* id it's known by (`doi:`, `openalex:`, `arxiv:`, `zotero:`,
`rss:`) and matches if any of them overlap, with a normalized-title fallback
for papers that share no id at all — which is what makes DOI-less items (books,
theses, hand-entered records) dedup instead of silently duplicating.

**Nothing already in `Papers/` is ever inboxed.** Before creating a note, the
plugin checks the vault's manifest by id and then by title, and skips anything
you already have — listing the skip in the run report so it's visible rather
than mysterious. This is also why inbox and paper notes never collide in the
graph: the duplicate simply never gets created.

## Starting from your own library

The plugin is fully useful on an empty vault, but the more personal starting
graph is your own bibliography. Bringing it in doesn't need a separate
app — in Zotero, select the items you want (or a whole collection), right-click
→ **Create Bibliography from Items** → a citation style that includes DOIs
(APA works) → **Copy to Clipboard**, then paste that straight into the
"papers to start from" box (starting-graph mode: seeds, or snowball to also
pull in what those papers cite and what cites them). No export file, no
format to pick.

Flows with Zotero:

- **Inbox → Zotero:** every inbox note carries its DOI/arXiv id and URL; a
  "Copy identifier" command feeds Zotero's *Add by Identifier*.
- **Add by DOI:** a command to paste a DOI/arXiv id and get a note immediately,
  wired into the graph. Manual adds are intentional, so they aren't pruned.

## Non-negotiables (community review + project principles)

- `requestUrl()` for all network access, never `fetch()`; Obsidian Vault API for
  all file access, never Node `fs`. `isDesktopOnly: false`.
- No bundled or auto-downloaded binaries, and no launching of external
  programs at all.
- The OpenAlex API key is an optional user setting — never ship a
  hardcoded email. Disclose exactly which hosts are contacted and when.
- Manual runs only. No timers, no network on plugin load.
- Never destroy user work: hash-guarded cleanup, trash not delete, preview
  before prune, unknown files untouchable.

## Commands

| Command | What it does |
|---|---|
| **Update inbox** | Fetch from every enabled source, dedup, write arrivals, regenerate `_Inbox.md`. |
| **Keep this paper** | Move the active inbox note into your papers folder. Identical to dragging it there yourself. |
| **Add a paper by DOI or arXiv id** | Fetch one paper on demand. Exempt from cleanup. |
| **Copy this paper's identifier** | Puts the DOI/URL on the clipboard for Zotero's *Add by Identifier*. |
| **Clean up old arrivals** | Preview, confirm, then move untouched expired arrivals to trash. Off until enabled in settings. |

## Building

```bash
npm install
npm test        # vitest, no network — replays recorded API responses
npm run build   # tsc --noEmit && esbuild -> main.js
```

To try it in a real vault, copy `manifest.json` and the built `main.js` into
`<vault>/.obsidian/plugins/literature-inbox/` and enable it in Community
plugins → Installed plugins.

## Layout (self-contained — survives extraction as-is)

```
literature-inbox/
  manifest.json          id: literature-inbox, isDesktopOnly: false
  package.json           esbuild → main.js, TypeScript strict, vitest
  src/
    main.ts              plugin entry: commands only, no policy
    settings.ts          settings tab
    obsidian-adapter.ts  the ONLY file importing Obsidian's file/network APIs
    core/                zero Obsidian imports, therefore unit-testable:
                         ids, filenames, http, openalex, arxiv, rss,
                         citations, notes, vault-state, update, prune,
                         hash, xml, types
  tests/
    fixtures/            real recorded API responses
    *.test.ts            463 tests
```

The `core/` ⇄ `obsidian-adapter.ts` split is deliberate: policy is testable
without mocking Obsidian, and there is exactly one place to audit for API use.

## Status

**Verified:** 463 tests green, including a suite that drives the real plugin
class end to end through a faked Obsidian API. Typecheck and build clean.
A live-API suite runs against the real OpenAlex and arXiv endpoints
(`npm run test:live`), kept out of the default run so the suite stays offline.

**Not yet verified:** nobody has loaded this in Obsidian and judged whether the
resulting graph is a good triage surface. That's the next step, and it's the
one thing no test can do — see `roadmap.md` (M1).

Then: screenshots, BRAT testing, and the community-plugin PR. The release
workflow is in place: push a bare version tag and it builds, tests, and
attaches the assets.
