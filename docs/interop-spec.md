# Vault interop spec, v1

The on-disk contract between tools that share one Obsidian vault — today
**zot2vault** (Python, this repo) and **literature-inbox** (a TypeScript
Obsidian plugin, separate repo). The two share *no code*. This document is the
entire interface: an implementation conforms to this file, not to the Python
source.

Every format below was transcribed from working code and verified against real
generated output. Where a rule looks arbitrary, the rationale is given — those
are the ones most likely to be "simplified" into a bug.

---

## 1. Scope, versioning, conformance

- **Vault-relative paths only.** Nothing on disk records an absolute path
  (except `pdf_cache` keys, §4.4, which are machine-local by nature and are not
  part of the cross-tool contract). A vault can be moved or synced to another
  machine without invalidating anything here.
- **`version` is an integer**, currently `1`, stored in `state.json`. Bump it
  only for a *breaking* change to the file format. Adding a new optional key is
  not breaking, and neither is a change to how tools *behave* toward a format
  that has not changed — an out-of-step pair must degrade rather than corrupt.
  (§7.2's move from filename matching to identity matching is such a change.)
- **Reader rules:** ignore unknown keys; tolerate missing optional keys; if
  `version` is higher than you understand, you may still read the keys you
  recognize but **must not write the file**.
- **UTF-8, LF-normalized content, no BOM.** Markdown files end with a trailing
  newline.

## 2. Folder layout

```
<vault>/
  Papers/                     paper notes            (zot2vault writes)
  Authors/                    one note per author    (zot2vault writes)
  Inbox/                      arrivals               (literature-inbox writes)
  _External References.md     "cited but not in your library" hub
  _generation-report.md       last run's report
  instructions.md             zot2vault's checkbox config (app-specific)
  note-template.md            optional user note layout (app-specific)
  .scriptorium/
    state.json                shared state (§4)
    cache/                    extracted-PDF-text sidecars (machine-local)
    trash/                    notes removed by opt-in cleanup (recoverable)
```

Folder separation prevents *file* collisions. It does **not** prevent wikilink
ambiguity — Obsidian resolves `[[Foo]]` by basename, so `Inbox/Foo.md` and
`Papers/Foo.md` would be ambiguous. The rule that actually prevents this is
§7.1: never create an inbox note for a paper the vault already has.

### 2.1 Ownership (single writer per file)

| Path | Writer | Others |
|---|---|---|
| `Papers/`, `Authors/`, `_External References.md`, `_generation-report.md`, `.scriptorium/state.json` | zot2vault | read-only |
| `Inbox/`, `_Inbox.md`, plugin `data.json` | literature-inbox | read-only |

One writer per file is what makes concurrent use safe without locking. A
plugin keeps its own operational state in Obsidian's per-plugin `data.json`,
never in `state.json`.

**`state.json` may not exist.** It is created only once something is written to
it, so a vault that has only ever been used by the plugin has none. Treat a
missing file as empty state — never an error.

## 3. Identity: origin ids and titles

### 3.1 Namespaces

| Prefix | Value | Normalization |
|---|---|---|
| `doi:` | `10.5555/attention` | strip any `http(s)://doi.org/` prefix, **lowercase** |
| `zotero:` | `ABC123` | Zotero item key, case preserved |
| `openalex:` | `W2963403868` | bare id — last URL path segment |
| `arxiv:` | `2607.15277` | bare id, **version suffix stripped** (`2607.15277v1` → `2607.15277`) |
| `rss:` | feed item `guid` | verbatim; fall back to `url:<link>` if the feed has no guid |
| `author:` | `ashish vaswani` | lowercased full name |

A serialized id is `"<prefix>:<value>"`.

### 3.2 A note records *every* id it is known by

`origin_ids` is a list, ordered `doi:` first (most widely shared namespace),
then the source's own ids. **Not** a single preferred id: the two tools rarely
learn the same one id for a paper. zot2vault knows `zotero:KEY`; the plugin
knows `openalex:`/`arxiv:`. Recording only a favourite meant a Zotero item
without a DOI could never match anything fetched from an API, and duplicated
silently — books, theses, hand-entered records, DOI-less preprints.

**Match rule:** two records refer to the same work if their `origin_ids`
intersect on *any* id.

`author:` entries identify author pages, not papers. **Never treat an
`author:` entry as a dedup target for a fetched work.**

### 3.3 Title fallback

Each note also records its `title`. When two records share no id at all,
compare normalized titles:

> lowercase, then delete every character that is not `a-z` or `0-9`.

`"Attention Is All You Need!"` and `"attention is all-you need"` both normalize
to `attentionisallyouneed`.

This is a **fallback behind id matching**, never a primary key: titles are not
unique in principle (`"Introduction"`, `"Preface"`). A title-only hit should be
corroborated — year or first author — before being treated as the same work.

## 4. `state.json`

Loaded once, written once per run, via temp-file-then-rename so a crash cannot
leave a partially-written file. Real output:

```json
{
  "version": 1,
  "params": {
    "zot2vault": { "zotero_folder": "/home/me/Zotero" }
  },
  "note_manifest": {
    "Papers/Attention Is All You Need.md": {
      "content_hash": "ca2296bd80268786e69fc2b3abc290c6dca7851d3250d20435aec5894fd0a75d",
      "generated_at": "2026-07-22T18:34:39Z",
      "origin_ids": ["doi:10.5555/attention", "zotero:ABC123", "openalex:W2963403868"],
      "title": "Attention Is All You Need"
    },
    "Authors/Ashish Vaswani.md": {
      "content_hash": "219020e7a9b513d38cd999493f60ec187c23ef9b75789d200dedfc0b7f69b71a",
      "generated_at": "2026-07-22T18:34:39Z",
      "origin_ids": ["author:ashish vaswani"],
      "title": "Ashish Vaswani"
    }
  },
  "pdf_cache": {}
}
```

### 4.1 `params`
`{app: {key: value}}`, values always strings. App namespaces the key.

### 4.2 `note_manifest`
Keyed by **vault-relative note path including `.md`**.

- `content_hash` — SHA-256 hex of the note's **full file content** (frontmatter
  included) as written.
- `generated_at` — **ISO-8601 UTC with a literal `Z`**: `YYYY-MM-DDTHH:MM:SSZ`.
  A zone-less `"YYYY-MM-DD HH:MM:SS"` is parsed as *local* time by
  JavaScript's `new Date(...)`, silently shifting it by hours and skewing any
  age or keep-window calculation. Do not emit one.
- `origin_ids` — §3.2. `title` — §3.3.

### 4.3 Touched detection and deletion safety

A note is **untouched** iff it has a manifest entry *and* its current content
hashes to that entry's `content_hash`.

> **Never delete a note that is not untouched.** A note with no manifest entry
> is not "safe to delete" — it is unknown, and unknown files are invisible to
> any cleanup. Any edit, including ticking a checkbox inside the note, changes
> the hash and counts as touched.

Cleanup is recoverable: zot2vault moves to `.scriptorium/trash/`; the plugin
uses Obsidian's trash. Neither hard-deletes.

### 4.4 `pdf_cache` (machine-local, not cross-tool)
`{absolute_pdf_path: {size, mtime_ns, cache_file}}`, with extracted text in
`.scriptorium/cache/<sha256-of-path>.txt`. A hit requires size *and* mtime to
match. Absolute paths and a foreign tool's PDF handling make this
implementation-private — **other tools should ignore it**, and must not treat
its absence or staleness as meaningful.

## 5. Note format

### 5.1 Generated-section markers

```
<!-- zot2vault:generated:start -→
...regenerated on every run...
<!-- zot2vault:generated:end -→
...anything below the end marker is the user's and is preserved verbatim...
```

These exact strings are an **on-disk format, not an implementation detail**.
Changing the text would make every existing note look unmarked and silently
drop what users wrote below it. The name says `zot2vault` for historical
reasons; **both tools use it unchanged.**

Preservation rule on regenerate: take everything after the end marker, strip
leading newlines, re-append it below the freshly generated block.

Both tools sharing these markers is load-bearing, not cosmetic — see §7.2.

### 5.2 Frontmatter

A `---`-delimited YAML block. Keys are omitted entirely when empty (never
written blank). Paper notes:

```yaml
---
title: Attention Is All You Need
authors:
  - Ashish Vaswani
year: "2017"
doi: 10.5555/Attention
url: "https://arxiv.org/abs/1706.03762"
publication: NeurIPS
item-type: journalArticle
work-key: ABC123
tags:
  - transformers
---
```

Author pages carry `title` and `scriptorium-type: author`. External-reference
stubs carry `title`, `external-reference: true`, and `origin-id`.

Note that `doi` here preserves source casing while the `doi:` **origin id** is
lowercased (§3.1) — normalize before comparing. Quoting is conditional, so
consumers must **YAML-parse, not string-match**.

Plugin-written notes should additionally record fetch provenance (source, fetch
date, and the ids the work arrived with).

**Subject terms.** literature-inbox can record OpenAlex subject terms, either
under an optional `subjects` key or folded into `tags`. Both are legal under §1
(a new optional key is not breaking, and readers ignore unknown keys), but note
what happens on an upgrade-in-place (§7.2): zot2vault regenerates frontmatter
from Zotero, so it will **drop `subjects` and replace `tags` with Zotero's
tags**. That is acceptable degradation — the note is still correct and still
one file — but it means subject terms are not durable on a paper that later
enters a Zotero library. A tool wanting them to survive should treat `subjects`
as pass-through rather than regenerating it away.

### 5.3 Filename allocation

Both tools must allocate identically, or the same paper lands in two
differently-named files (§7.2 turns into a duplicate instead of an upgrade).

Allocation names a **new** note and keeps names unique. It is *not* how an
existing note is located — see §7.2. A note the user has renamed keeps its
name; nothing recomputes it.

**Base name**, first non-empty of: `title` → `"<FirstAuthorLastName> <year>"`
(with `n.d.` when there's no year) → the work key.

**Sanitize:**
1. Replace `< > : " / \ | ? *` and control chars `\x00-\x1f` with a space.
2. Collapse whitespace runs to one space; trim.
3. Strip trailing dots and spaces (Windows rejects them).
4. Empty result → `Untitled`.
5. Truncate to **150** chars, then strip trailing dots/spaces again.
6. Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
   `LPT1`–`LPT9`, case-insensitive) → prefix with `_`.

**Collisions** are resolved deterministically against a case-insensitive set of
already-assigned names, allocating in a stable order (works sorted by key):
1. `Name` if free;
2. else `Name (year)` if a year exists and it's free;
3. else `Name (key)`;
4. else `Name (key-2)`, `Name (key-3)`, … until free.

Author pages use the author name as base with unique key `AUTHOR:<name>` and no
year. Stubs use the display text with unique key `EXTERNAL:<origin_id>`.

## 6. Page formats (checkboxes and links)

### 6.1 Wikilinks
`[[Target]]` or `[[Target|Display]]`. Parsed with
`\[\[([^\]|]+)(?:\|[^\]]+)?\]\]` — the capture is the *target*, never the alias.

### 6.2 Checkboxes
Actionable checkboxes are **top-level only**: `- [ ] …` / `- [x] …` at the very
start of a line, matched by `^- \[( |x|X)\] (.+)$` (multiline). Indented
checkboxes are decorative sub-items (e.g. citation candidates) and are
deliberately **not** matched.

> Do not rely on that indentation for safety. Parse checkboxes **scoped to
> their `##` section**, not across the whole document — a document-wide scan
> would let ticking any same-named box elsewhere in the file authorize an
> action it wasn't meant to. This matters most for delete checkboxes.

A `##` section runs from its heading line to the next line starting with `## `
(or EOF).

### 6.3 Dated index pages (`_Inbox.md`)

```markdown
# Inbox

## 2026-07-19

- [[Some Paper]]
- [[Another Paper|Another]]
```

`## ` sections are dates, sorted **newest first**; entries keep insertion order
within a date. Front pages are fully regenerated each run: read back any user
state (checked boxes) *before* overwriting, and fold it into the new render.

### 6.4 External-reference hub

```markdown
- [ ] [[(Turing, 1950)]] — cited by 2:
    - [[Attention Is All You Need]]
    - [[Computing Machinery Foundations Revisited]]
```

Top-level box = "create a stub note for this on the next run"; indented items
are the citing papers. Sorted by citer count descending, then display text.

### 6.5 Report deletion checkboxes

Under the `## Notes no longer in your library scope` heading:

```markdown
- [ ] [[Ghost Paper]] — delete this note on the next run
```

Parsed **section-scoped** (§6.2) and applied on the next run only if the note is
still untouched (§4.3).

## 7. Cross-tool behaviors

### 7.1 Never inbox what the vault already has

Before creating an inbox note, the plugin checks the vault manifest — by
`origin_ids` intersection over *all* of the fetched work's ids, then by
normalized title — and skips anything already present, **listing the skip in
its run report** so it's visible rather than mysterious. This is what keeps
duplicate basenames from ever arising (§2).

### 7.2 Keeping is a file move; regeneration is an upgrade

The user keeps a paper by moving the note out of `Inbox/` into `Papers/` — by
hand or via a one-click command; both are identical, because **the folder is
the source of truth**, not a command having been run. Obsidian rewrites inbound
wikilinks on move, so nothing dangles. The plugin only ever prunes notes still
in `Inbox/`; a note that has left is no longer its business.

If that paper later enters the user's Zotero library, zot2vault *upgrades the
note in place*: the generated block gains real metadata, annotations and
citations, and everything the user wrote below the end marker survives.

**Finding that note is by identity, never by filename.** Before writing, a tool
scans the papers folder and reads each note's frontmatter, matching
`origin_ids` intersection first and normalized `title` second (§3). It writes
to the note it found; only when there is no match does it use the name §5.3
allocates.

This replaces an earlier rule where both tools computed the same filename and
met there. That worked, and it made the filename load-bearing: renaming a note
— including to the nickname the user actually calls the paper — produced a
second, competing file on the next run. Identity already travels *inside* the
note, so the name never needed to carry it. The cost is one file read per note
per run, which is what a tool reading `origin-ids` out of frontmatter already
pays anyway.

**§5.1 markers remain load-bearing.** Diverge on those and the upgrade still
becomes a second file, because there is then no generated block to replace.

*Mixed versions degrade safely.* A tool still matching on filename keeps
working on notes nobody has renamed, and duplicates one that has been — the
old behavior, no worse. Nothing is corrupted either way, which is why this
revision does not bump `version`: `state.json`'s format is unchanged.

### 7.3 What the plugin must tolerate

- `state.json` absent entirely (§2.1).
- A `version` it doesn't recognize (§1) — read what you know, write nothing.
- `author:` manifest entries that are not papers (§3.2).
- Notes present on disk with no manifest entry — user-authored; never touch.

## 8. Reserved

Namespaces and keys not yet used but reserved so an implementation doesn't
claim them: origin-id prefixes `isbn:`, `pmid:`, `s2:`; `state.json` top-level
keys beginning `x-` are available for private experimentation and must be
ignored by other tools.
