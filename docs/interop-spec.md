# Note format

This plugin's own on-disk conventions for the notes it writes. It used to
also describe a shared contract with a companion desktop app (zot2vault);
that app is no longer part of the workflow — import is via pasting a
bibliography (Zotero's "Create Bibliography from Items" or an exported
list) into the starting-graph seeds box — so this file now documents the
plugin's own invariants only.

Every format below was transcribed from working code. Where a rule looks
arbitrary, the rationale is given — those are the ones most likely to be
"simplified" into a bug.

---

## 1. Identity: origin ids and titles

### 1.1 Namespaces

| Prefix | Value | Normalization |
|---|---|---|
| `doi:` | `10.5555/attention` | strip any `http(s)://doi.org/` prefix, **lowercase** |
| `zotero:` | `ABC123` | Zotero item key, case preserved |
| `openalex:` | `W2963403868` | bare id — last URL path segment |
| `arxiv:` | `2607.15277` | bare id, **version suffix stripped** (`2607.15277v1` → `2607.15277`) |
| `rss:` | feed item `guid` | verbatim; fall back to `url:<link>` if the feed has no guid |

A serialized id is `"<prefix>:<value>"`.

### 1.2 A note records *every* id it is known by

`origin-ids` is a list, ordered `doi:` first (the most widely shared
namespace), then whichever other ids the source supplied. **Not** a single
preferred id: different sources learn different ids for the same paper, and
recording only a favourite would mean a DOI-less record (a book, a thesis, a
hand-entered paste) could never be recognised again once its one id fell out
of view.

**Match rule:** two records refer to the same work if their `origin-ids`
intersect on *any* id.

### 1.3 Title fallback

Each note also records its `title`. When two records share no id at all,
compare normalized titles:

> lowercase, then delete every character that is not `a-z` or `0-9`.

`"Attention Is All You Need!"` and `"attention is all-you need"` both normalize
to `attentionisallyouneed`.

This is a **fallback behind id matching**, never a primary key: titles are not
unique in principle (`"Introduction"`, `"Preface"`). A title-only hit should be
corroborated — year or first author — before being treated as the same work.

## 2. Note format

### 2.1 Generated-section markers

```
<!-- literature-inbox:generated:start -->
...regenerated on every run...
<!-- literature-inbox:generated:end -->
...anything below the end marker is the user's and is preserved verbatim...
```

These exact strings are an **on-disk format, not an implementation detail**.
Changing the text would make every existing note look unmarked and silently
drop what users wrote below it.

Preservation rule on regenerate: take everything after the end marker, strip
leading newlines, re-append it below the freshly generated block.

A note is **untouched** iff its current content still matches what was
generated for it (tracked as a hash in the plugin's own `data.json`, never
in the note itself). Any edit at all — including ticking a checkbox — makes
it touched. Cleanup never removes anything that is not untouched, and even
then moves to Obsidian's trash rather than deleting.

### 2.2 Citations sub-block markers (additive)

Inside the generated section, the plugin wraps its `## Citations` content in a
second, narrower marker pair:

```
<!-- literature-inbox:citations:start — auto-updated, please don't edit inside this block -->
## Citations
...
<!-- literature-inbox:citations:end -->
```

Purpose: the outer generated-section markers guard the *whole* note for
cleanup — any edit anywhere inside them freezes the note from cleanup, by
design. That all-or-nothing rule would also freeze the citations list the
moment the user wrote so much as a personal tag elsewhere in the note. This
inner block lets the plugin always find and *add to* just the citations
content, regardless of anything else going on in the note — additively
only, never removing an existing link, and leaving anything the user added
inside the block exactly where it is.

### 2.3 Frontmatter

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
source: openalex
fetched: 2026-07-22
origin-ids:
  - doi:10.5555/attention
  - openalex:W2963403868
tags:
  - transformers
---
```

Note that `doi` here preserves source casing while the `doi:` **origin id** is
lowercased (§1.1) — normalize before comparing. Quoting is conditional, so a
reader must **parse the YAML, not string-match** it.

### 2.4 Filename allocation

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

## 3. Never inbox what the vault already has

Before creating an inbox note, the plugin scans the papers folder, reads each
note's frontmatter, and checks the fetched work's ids against what it finds —
by `origin-ids` intersection first, then by normalized title — skipping
anything already present and **listing the skip in the run report** so it's
visible rather than mysterious.

## 4. Keeping is a file move

The user keeps a paper by moving the note out of `Inbox/` into `Papers/` — by
hand or via a one-click command; both are identical, because **the folder is
the source of truth**, not a command having been run. Obsidian rewrites inbound
wikilinks on move, so nothing dangles. The plugin only ever prunes notes still
in `Inbox/`; a note that has left is no longer its business.

Recognising a kept note again is by identity, never by filename: the plugin
scans the papers folder and reads each note's frontmatter, matching
`origin-ids` first and normalized `title` second (§1). This is what lets a
note be renamed — including to whatever the user actually calls the paper —
without becoming invisible to the plugin.
