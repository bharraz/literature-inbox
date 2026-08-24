# Proposal: fold zot2vault into the plugin via Zotero's local API

**Status:** proposal, not yet implemented. Written in the `Zot-To-Vault`
monorepo for the AI/developer working in the `literature-inbox` repo.

**One-line version:** Zotero 7 serves a read-only mirror of the Zotero Web API
on `127.0.0.1:23119`. The plugin can read the library directly, which removes
the separate Python app, the bundled executable, the `child_process` launcher,
and the PyMuPDF dependency — and *lowers* community-plugin review risk rather
than raising it.

---

## 1. What this replaces

Today there are two products sharing one on-disk contract
(`docs/interop-spec.md`):

| | today | proposed |
|---|---|---|
| Zotero → vault | zot2vault, a Python PyInstaller exe reading Zotero's SQLite file directly | a source module inside the plugin, reading Zotero's local HTTP API |
| PDF text | PyMuPDF (`fitz`), extracted per-file, cached | Zotero's own full-text index, over the API |
| Incremental re-runs | hand-rolled, via `.scriptorium/state.json` content hashes | `?since=<libraryVersion>`, native to the API |
| Install | download exe, dismiss SmartScreen, point plugin at its path | nothing — it's the plugin |

The Python codebase is ~4.2k lines of source. The genuinely Python-only parts
are smaller than that suggests, because ids, filenames, note format, the
OpenAlex client, and vault state are already ported to TypeScript:

- `sources/zotero/reader.py` (234 lines) — **replaced** by the API client
- `sources/pdf/extract.py` (121 lines) — **deleted**, Zotero indexes for us
- `citations/fuzzy.py` (126 lines) — **dropped or deferred** (see §6)
- `vault/report.py`, `vault/builder.py`, `config/`, `ui/` — **replaced** by
  the plugin's existing settings page and note generation

---

## 2. Findings — the local API

Primary source: <https://www.zotero.org/support/dev/web_api/v3/local_api>

- **What it is.** Recent Zotero desktop versions expose a local implementation
  of Web API v3 at `http://127.0.0.1:23119/api/`, serving the local database.
  Pass `0` as the user id: `/api/users/0/items`.
- **Read-only.** All writes must go through `/connector/` endpoints. We only
  read, so this is fine.
- **No authentication, no rate limits, works offline**, and is substantially
  faster than the web API.
- **Not enabled by default.** The user must tick Settings → Advanced →
  *"Allow other applications on this computer to communicate with Zotero"*
  (pref key `extensions.zotero.httpServer.localAPI.enabled`). See §5.
- **Not paginated by default** — a request returns the full result set in one
  response. Pass `limit` / `start` explicitly.
- Atom is not supported; JSON only. Item type/field endpoints return names
  localized to the user's Zotero locale (don't key logic off them).

### Endpoints we need

| Endpoint | Use |
|---|---|
| `GET /users/0/collections` | collection tree, for the include/exclude filters |
| `GET /users/0/items?since=N` | library items, incrementally |
| `GET /users/0/deleted?since=N` | removals since last sync |
| `GET /users/0/items/<key>/children` | attachments of an item |
| `GET /users/0/items/<key>/fulltext` | indexed PDF text — **replaces PyMuPDF** |
| `POST /users/0/fulltext` | bulk full-text, up to 10 items per call |
| `GET /users/0/searches/<key>/items` | optional: drive selection from a saved search |

`GET /users/0/items/<key>/file` returns a **302 to a `file://` URL**.
`requestUrl` will not follow that, and we don't need it — `/fulltext` gives us
the text without ever touching PDF bytes.

### The `since` mechanism

Every response carries a `Last-Modified-Version` header. Store it; pass it back
as `?since=`. You get only what changed. This directly replaces the
content-hash diffing in `vault/state.py` for the Zotero source, and answers the
question that motivated the JSON state store in the first place ("if the user
re-runs to add new papers, do you re-search everything?" — no).

Keep `.scriptorium/state.json` anyway: it still tracks generated-note hashes
for cleanup safety, and it is the interop contract. But the Zotero-side
freshness check becomes a single integer.

---

## 3. Review risk: low, and net-negative

The concern was that talking to localhost would fail community-plugin review.
Evidence says no.

**Policy** (<https://docs.obsidian.md/Developer+policies>) treats network use as
a *disclosure* requirement, not a prohibition: *"Network use. Clearly explain
which remote services are used and why they're needed."* Prohibited items are
obfuscated code, client-side telemetry, dynamic ads, remote code execution —
none of which apply.

**Precedent** — plugins currently in the community directory that use the
Zotero local API on `127.0.0.1:23119`:

- [Citation Extended](https://community.obsidian.md/plugins/citation-extended)
  — added ~10 months ago, updated recently; explicitly offers *"Zotero's own
  local API (Zotero 7+, no extensions required)"*
- [Zotero Link](https://community.obsidian.md/plugins/zotero-link)
- [Zotero Completion](https://community.obsidian.md/plugins/zotero-completion)
- [Zotero Research Assistant](https://community.obsidian.md/plugins/zotero-redisearch-rag)
- [Zotero Bridge](https://github.com/vanakat/zotero-bridge)

Citation Extended's README is a usable template for the disclosure: it states
the plugin *"accesses the network only when you configure it to, and it never
sends telemetry or analytics,"* then enumerates exactly which endpoints,
naming `127.0.0.1:23119` loopback traffic specifically.

**The risk this removes.** The riskiest code in the plugin today is
`src/core/launcher.ts` — spawning a user-specified executable via
`child_process`. That is the pattern reviewers scrutinize hardest, and there is
active security discourse about Obsidian plugins performing shell execution.
Adopting this proposal deletes that file, drops the `Platform.isDesktop`
gating around it, and ends the bundled-binary conversation entirely.

Residual risk is ordinary first-submission friction (README completeness,
manifest/tag matching, `innerHTML` usage, unload cleanup) — not this.

---

## 4. Proposed design

### Where it goes

The Zotero library becomes **one more source**, structurally identical to
OpenAlex and arXiv. It is not a special mode.

```
src/core/zotero/
  client.ts      // pure: URL building, JSON parsing, since-token handling
  mapping.ts     // pure: Zotero item JSON -> Work
  index.ts       // re-exports
```

`src/core/**` must keep importing nothing from Obsidian. The client takes the
existing `Transport` interface (already used by `OpenAlexClient` and
`ArxivClient`), so it is testable against fixtures with zero mocking, and
`obsidian-adapter.ts` remains the only file calling `requestUrl`.

```ts
export interface ZoteroLocalOptions {
  /** Default "http://127.0.0.1:23119". Overridable for tests and odd setups. */
  baseUrl?: string;
  /** Page size for explicit pagination. Default 100. */
  limit?: number;
}

export class ZoteroLocalClient {
  constructor(transport: Transport, options?: ZoteroLocalOptions);

  /** Cheap liveness probe; distinguishes "Zotero closed" from "API off". */
  status(): Promise<ZoteroStatus>;

  collections(): Promise<ZoteroCollection[]>;

  /** Paged internally; `since` omitted means a full sync. */
  items(since?: number): Promise<{ works: Work[]; version: number }>;

  deleted(since: number): Promise<{ itemKeys: string[]; version: number }>;

  /** Best-effort; missing/unindexed items simply yield undefined. */
  fulltext(itemKeys: string[]): Promise<Map<string, string>>;
}
```

`Transport` currently exposes only `get`. Bulk full-text needs `POST`, so
either extend `Transport` with an optional `post`, or issue up to 10 separate
`GET /items/<key>/fulltext` calls. **Start with the `GET` loop** — no interface
change, no adapter change, and full text is not needed on the hot path (§6).

### Field mapping

Zotero Web API v3 item JSON → the `Work` shape the note generator already
consumes. Verify each against a real response before trusting this table; it is
written from the API spec, not from a captured payload.

| `Work` field | Zotero JSON |
|---|---|
| `key` | `key` |
| `ids` | `zotero:<key>`, plus `doi:<normalized>` when `data.DOI` is present |
| `itemType` | `data.itemType` |
| `title` | `data.title` |
| `abstract` | `data.abstractNote` |
| `date` | `data.date` (free-form — normalize; year may be all you get) |
| `doi` | `data.DOI` (also check `data.extra` for `DOI: ...`, common for preprints) |
| `url` | `data.url` |
| `publication` | `data.publicationTitle` / `data.proceedingsTitle` / `data.bookTitle` |
| `authors` | `data.creators[]` — note two shapes: `{firstName, lastName}` **or** `{name}` for single-field names |
| `userTags` / `autoTags` | `data.tags[]` — `{tag, type}`, `type: 1` means automatic |
| `collectionPaths` | `data.collections[]` are collection **keys**; resolve to paths via `/collections` + `parentCollection` |
| `references` | empty — Zotero has no reference lists; filled by OpenAlex DOI lookup |

Two things must be carried over from the Python side rather than reinvented:

1. **LaTeX cleaning.** `packages/scriptorium/src/scriptorium/text/latex.py`
   (80 lines) handles accent escapes, `\text{}`, `$…$`, `~`, and script
   markers in titles, abstracts, and author names. Zotero libraries populated
   from BibTeX are full of these. This was a reported real-vault bug. **Port
   it**, with its tests.
2. **Filename and note-format rules.** Already in `src/core/filenames.ts` and
   pinned by `docs/interop-spec.md` §5. Zotero-sourced notes must use the same
   rules, or a Zotero import creates a second competing file next to an
   existing note instead of upgrading it in place.

### Filters

`vault/filters.py` (collection include/exclude, tag exclusion, the
`(No collection)` bucket for uncategorized items) ports almost verbatim — it is
already pure logic over collection paths and tags. Keep the `(No collection)`
behaviour; it was added because uncategorized items were otherwise unfilterable.

### Settings UI

Extend the existing **Sources** section with a Zotero block:

- Toggle: *Import from Zotero*
- Status line: reachable / not reachable, with the specific remedy (§5)
- Collection picker, populated from `/collections`, with the same
  include/exclude checkbox semantics the Python config file had
- Excluded tags
- Last synced: `<library version>`, plus a *Full resync* button that clears the
  `since` token

The starting-graph ("kernel") flow should offer *"use my Zotero library"* as an
alternative to a topic search. On a vault where Zotero is present, that is a
better seed than top-cited-by-topic — it is literally the user's own field.

---

## 5. Onboarding: the one real cost

The local API is **off by default**. A user with Zotero installed and running
will still get connection refused until they enable it.

The failure modes must be told apart and reported precisely — a generic
"couldn't connect to Zotero" will generate support noise:

| Symptom | Cause | Message |
|---|---|---|
| `ECONNREFUSED` on `:23119` | Zotero not running | "Zotero doesn't appear to be running. Start Zotero and try again." |
| Port answers, `/api/...` 404s / "No endpoint found" | local API not enabled | "Zotero is running, but its local API is off. In Zotero: Settings → Advanced → tick *Allow other applications on this computer to communicate with Zotero*." |
| `/api/` responds but no items | empty or wrong library | "Connected to Zotero, but found no items." |

Put the same two sentences in the README and in the settings status line. This
is the single highest-leverage piece of copy in the feature.

Mobile: the Zotero source is simply unavailable. Hide the section when
`!Platform.isDesktop`, keep `isDesktopOnly: false` in the manifest (Zotero is
one source among several, and the rest work fine), and say so in the README.

---

## 6. What gets lost, and whether it matters

**Fuzzy citation matching from PDF text.** `citations/fuzzy.py` scans extracted
PDF text for citation markers and matches them against the library. The current
design already prefers OpenAlex reference lists (exact, by id intersection) and
treats fuzzy matching as the fallback for items OpenAlex doesn't know.

Recommendation: **ship without it.** The full-text endpoint means the input is
still available, so it can be added later as a pure `core/` module if the
exact-resolution coverage turns out to be inadequate on a real library. Do not
port it preemptively — it was also the largest source of noise in the
generation report ("87 references not in your library" is not an error).

**Annotations.** Zotero annotations are child items and are reachable via
`/items/<key>/children`. Not currently used by the plugin; out of scope here,
but the path exists.

**Zotero-first users who don't use Obsidian.** They lose the tool entirely.
If that audience matters, the fallback is a Zotero 7 plugin (`.xpi`) writing
markdown per `docs/interop-spec.md` — the spec was written for exactly that
kind of second writer. Judgement call: the Obsidian directory is a far larger
distribution channel, and the product's premise (papers as graph nodes) only
pays off inside Obsidian.

---

## 7. Verification spike — do this before writing code

30 minutes, and it decides whether §4 survives contact.

1. Zotero → Settings → Advanced → enable *Allow other applications…*
2. `curl http://127.0.0.1:23119/api/users/0/collections` — is the tree complete,
   with `parentCollection` links intact? Are `key`s stable?
3. `curl 'http://127.0.0.1:23119/api/users/0/items?limit=5'` — capture a real
   payload and check §4's field table against it. Note the
   `Last-Modified-Version` response header.
4. `curl 'http://127.0.0.1:23119/api/users/0/items/<attachmentKey>/fulltext'` —
   **is full text on the parent item or the attachment child?** (Expect the
   attachment.) Does it return usable prose, and what fraction of the library
   is actually indexed?
5. Re-request `/items?since=<version>` and confirm an empty delta.
6. Make one `requestUrl` call to `http://127.0.0.1:23119/api/users/0/items`
   from inside a scratch plugin. Confirm plain HTTP to loopback works and CORS
   doesn't bite.

Save the payloads from steps 2–4 as fixtures under `tests/fixtures/zotero/`;
they become the basis for the hermetic tests, exactly as the OpenAlex fixtures
did. Add a `zotero` block to `tests/live-api.test.ts` (skipped unless
`LIVE_API=1`) that runs steps 2 and 4 against a real instance.

---

## 8. Sequencing

1. Spike (§7), capture fixtures.
2. `core/zotero/client.ts` + `mapping.ts` against fixtures. No Obsidian.
3. Port `text/latex.ts` with its tests.
4. Port `core/filters.ts` (collections/tags/`(No collection)`).
5. Wire into `update-inbox` and the kernel run as a source.
6. Settings section + the three error messages from §5.
7. **Delete `core/launcher.ts`**, its settings field, the `run-zot2vault`
   command, and the desktop gating.
8. README network-disclosure section, modeled on Citation Extended's.
9. Update `docs/interop-spec.md`: the spec stops describing a cross-process
   contract between two apps and becomes the plugin's own note-format
   invariants, with a note that a future Zotero `.xpi` could write to it.

Steps 1–4 are pure `core/` work with no Obsidian surface, so they are testable
end-to-end before anything is visible in the app.

---

## Sources

- [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [Zotero Web API v3 basics](https://www.zotero.org/support/dev/web_api/v3/basics)
- [Obsidian developer policies](https://docs.obsidian.md/Developer+policies)
- [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Citation Extended](https://community.obsidian.md/plugins/citation-extended)
- [Zotero Link](https://community.obsidian.md/plugins/zotero-link) ·
  [Zotero Completion](https://community.obsidian.md/plugins/zotero-completion) ·
  [Zotero Research Assistant](https://community.obsidian.md/plugins/zotero-redisearch-rag) ·
  [Zotero Bridge](https://github.com/vanakat/zotero-bridge)
- [Obsidian forum: HTTP requests from plugins (requestUrl vs fetch/CORS)](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)
