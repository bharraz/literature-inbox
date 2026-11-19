# Literature Inbox

An Obsidian plugin that turns new scholarly papers into graph nodes already
wired by citation links to papers you keep. Connected arrivals stand out;
isolated ones are easy to ignore. Keep a paper by moving it into your library,
or delete it and it will not return.

<!-- Add a screenshot or short GIF of the graph view here, e.g.:
![Graph view with new arrivals connected to a kept library](docs/screenshot.png)
-->

## The core loop

1. **Arrive.** Run **Update inbox** to fetch papers from your configured
   sources. New notes land under `Inbox/`, with exact citation links where
   OpenAlex or Crossref provides them.
2. **Keep = move it out.** Move an arrival into `Papers/`, by dragging it or
   using **Keep this paper**. The folder—not a checkbox—is the source of truth.
3. **Let go = delete it.** Delete an arrival, or move it outside both trees.
   Its identifiers are remembered so sources cannot resurrect it.

Any Markdown file under `Inbox/` is an arrival; any file under `Papers/` is
kept. Subfolders and note renames are fine. Renaming either root folder in
Obsidian updates the plugin settings. The plugin never deletes notes or
overwrites files it did not create.

## Setting the graph up

The plugin writes links; Obsidian draws the graph. A useful setup is:

- **Graph settings → Filters:** `path:Inbox OR path:Papers`
- **Graph settings → Groups:** a bright colour for `path:Inbox`, a muted one
  for `path:Papers`

Under **Paper properties in notes**, choose **Hidden (abstract first)**,
**Compact**, or **Show all**. This affects Literature Inbox paper views only;
the metadata remains searchable and available in source mode and the
Properties sidebar. Notes intentionally carry no `inbox` or `kept` tag because
folders track moves while static tags do not.

## Nothing runs on its own

There is no timer, scheduler, or background fetch. Network requests happen
only when you run an update or add papers. Feed and arXiv sources are checked
when you add them. The plugin never removes a note.

## Sources and their ergonomics

Sources are configurable rows with independent on/off switches and per-run
caps. The plugin fetches extra candidates, removes papers already seen or
dismissed, then keeps the best results per source.

- **Papers citing my library** — recent papers citing something under
  `Papers/`; connected by construction and ranked by the specificity of those
  connections.
- **Papers matching a topic** — recent title/abstract matches, most relevant
  first. Quote a phrase to require it exactly.
- **arXiv categories** — fresh category feeds such as `cs.CL`.
- **RSS/Atom feeds** — journal TOCs, bioRxiv, Scholar alerts, or any feed URL
  you provide.

Feed items often arrive without reference lists. For 30 days, the plugin
checks identifiable arrivals again on later manual runs and adds citation
links when indexing catches up. Persisted reference lists also allow a paper
kept today to connect to one arriving months later.

## What this costs you

Nothing, and no account is required. OpenAlex provides a metered free daily
allowance; a free API key raises it substantially and is useful for large
starting graphs. The settings page shows a usage gauge. Crossref is also free
and can be disabled.

The same paper from multiple sources remains one note. Identity is matched by
normalized DOI, OpenAlex, arXiv, Zotero, or RSS identifiers, then by normalized
title as a fallback. Anything already under `Inbox/` or `Papers/` is skipped
and reported rather than duplicated.

## Starting from your own library

**Add papers to your graph** can start from a topic or pasted DOI/arXiv
identifiers. Pasted papers can optionally bring in their references and
citers too.

For Zotero, copy a bibliography that includes DOIs and paste it into the seed
input. **Copy this paper's DOI** copies the active paper's DOI for Zotero's
*Add by Identifier*; it is available only when the note has a DOI.

## Privacy and network access

- All network access uses Obsidian's `requestUrl()`; all vault access uses its
  Vault API. The plugin works on desktop and mobile.
- It contacts only OpenAlex (`api.openalex.org`), Crossref
  (`api.crossref.org`), arXiv (`rss.arxiv.org` and `export.arxiv.org`), and
  feed URLs you add.
- Requests contain search terms or paper identifiers, never note contents.
- The optional OpenAlex key and Crossref email are stored as ordinary plugin
  settings and sent only to their respective services.
- Generated notes are only changed inside the plugin-owned citations block;
  user edits elsewhere are preserved.

## Commands

| Command | What it does |
|---|---|
| **Update inbox** | Fetch, deduplicate, rank, and report arrivals from enabled sources. |
| **Add papers to your graph** | Build or expand the kept-paper graph. |
| **Keep this paper** | Move the active arrival into `Papers/`. |
| **Add a paper by DOI or arXiv id** | Add one paper on demand. |
| **Copy this paper's DOI** | Copy its DOI. |

Right-click papers or folders under `Papers/` and choose **Expand outward** to
add their references and citers to the shared folder.

## Installing

**Community plugins:** search for “Literature Inbox” once it is listed.

**[BRAT](https://github.com/TfTHacker/obsidian42-brat):** add
`bharraz/literature-inbox` as a beta plugin.

**Manual:** place `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/bharraz/literature-inbox/releases/latest)
in `<vault>/.obsidian/plugins/literature-inbox/`, then enable the plugin.

## Building from source

```bash
npm install
npm test
npm run build
```

## Layout

```text
literature-inbox/
  manifest.json          plugin metadata
  src/
    main.ts              Obsidian integration and commands
    settings.ts          settings UI
    obsidian-adapter.ts  vault/network adapter
    core/                testable policy and data logic
  tests/                 hermetic tests and recorded fixtures
```

The `core/` and adapter split keeps policy testable without Obsidian and gives
file/network access one auditable boundary.

## License

MIT — see `LICENSE`.
