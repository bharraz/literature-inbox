# Data sources, and what we need from OpenAlex

**Section 0 is the complete list of sources. It is closed.** Nothing gets added
without amending this file and stating what it does that the existing ones
cannot. Written 2026-08-06, after too many ad-hoc "we could also use X"
detours — the scholarly-metadata world is smaller than it looks, and all of it
is below.

## 0. What exists, and what each thing actually is

**Registries** — where identifiers come from. A publisher deposits metadata
here when it mints a DOI, so this is the source of record.

| | What it is | Has references? | Cost |
|---|---|---|---|
| **Crossref** | The DOI registration agency for scholarly publishing, ~160M records deposited by publishers | Yes, *when the publisher deposited them* — measured at 23 of 49 carrying DOIs | Free, keyless |
| DataCite | The same, for datasets and software | n/a | — |

**Aggregators** — build a unified graph on top of registries plus other
sources. This is where a *queryable* citation graph comes from.

| | What it is | Unique capability | Cost |
|---|---|---|---|
| **OpenAlex** | Nonprofit (OurResearch) index merging Crossref, PubMed, arXiv and the retired Microsoft Academic Graph, ~250M works | **Inbound citations, filterable by date, 50 anchors per request** | Metered daily allowance |
| Semantic Scholar | Allen Institute for AI; similar scope plus ML-derived extras | Citation *contexts* — the sentence a citation appears in | Free, key needed in practice |
| Europe PMC | Biomedical literature only | — | Free |
| INSPIRE-HEP | High-energy physics only | — | Free |

**Citation-only slices**

| | What it is | Verdict |
|---|---|---|
| **OpenCitations (COCI)** | DOI→DOI citation links extracted from open Crossref deposits | Measured: outbound duplicates Crossref; inbound **504'd after 280 s**. Not usable |

**Primary / discovery sources** — where new papers appear first. Titles and
abstracts only; none of them publish reference lists.

| | What it is |
|---|---|
| **arXiv** | Preprint server: RSS feeds per category, plus an Atom query API |
| bioRxiv / medRxiv | The same for biology and medicine, reachable as ordinary RSS |
| Journal TOC and Scholar alert feeds | Ordinary RSS, bring your own URL |

That is the field. There is no long tail waiting to be discovered.

### 0.1 What we use, and why

| Source | Role | Why it and not another |
|---|---|---|
| **OpenAlex** | Primary: citation edges, topic and author search, adjacency selection | The only source with a **queryable, date-filtered inbound citation index**. That one capability is what makes an arrival connected by construction |
| **Crossref** | Secondary: title→DOI, and outbound references when OpenAlex cannot answer | Free and unmetered, and the registry of record. Half coverage on references beats none |
| **arXiv + RSS** | Discovery only | Fastest to publish. Never a metadata authority — items get resolved against the two above |

**Deliberately not used:**

- **Semantic Scholar** — its one unique offering is citation contexts, which
  are tabled. Adopting it means a second key and a second rate limit for data
  we already have.
- **OpenCitations** — measured and rejected above.
- **Europe PMC, INSPIRE-HEP** — field-specific. Using them makes the plugin
  behave differently per discipline, which is a design fork, not a feature.
- **PDF parsing for references** — ruled out at the start: it breaks mobile
  support and turns exact citation matching into fuzzy matching.

### 0.2 Crossref's terms, verified 2026-08-06

Checked before building on it, because a second dependency is only worth
having if it is genuinely unencumbered.

| | |
|---|---|
| **Account / key** | None. No signup of any kind |
| **Cost** | Free. No daily quota, no credits, no metering |
| **Rate limit** | Measured live: `x-rate-limit-limit: 1`, interval `1s`, concurrency 1 anonymously. Supplying a contact address moves you to the "polite pool" — measured at 3 req/s, concurrency 3 |
| **Pools** | `public`, `polite` (free), and `plus` (paid, for very high volume — not used) |
| **Metadata licence** | **CC0.** Explicitly reusable and redistributable, which matters because we write it into the user's notes |
| **Etiquette** | Identify yourself with a contact address so they can reach you about a problem. Optional, and honoured as a user setting |

Limits are advertised per response in `x-rate-limit-limit` and
`x-rate-limit-interval`, so the client paces itself rather than assuming: 1.1s
between requests anonymously, 400ms when a contact address is set.

This is about as lenient as an API gets. The only real constraint is requests
per second, which matters not at all for a plugin making tens of requests when
a human presses a button.

The rest of this document is the deep dive on OpenAlex, because it is the one
with a budget and the one that can break us.

---

## 1. The endpoints we use

Everything goes through one host, `https://api.openalex.org/works`. We use no
other OpenAlex entity — no authors, sources, institutions, or concepts
endpoints.

| Call | Shape | Used by | Billed as |
|---|---|---|---|
| Single work by DOI | `/works/https://doi.org/{doi}` | add-by-DOI, backfill fallback | Singleton |
| Works by DOI list | `?filter=doi:a\|b\|…` (50/req) | seed resolution, backfill, adjacency anchors | List+Filter |
| Works by OpenAlex id | `?filter=openalex_id:W1\|W2\|…` (50/req) | snowball references, library seeds | List+Filter |
| Works citing others | `?filter=cites:W1\|W2\|…` (50/req) | adjacency selection, snowball citers | List+Filter |
| Topic search | `?filter=default.search:{topic}` | starting graph, topic arrivals | **Search** |
| Title search | `?filter=title.search:{title}` | resolving a feed item to a real paper | **Search** |
| Author's works | `?filter=authorships.author.id:` / `.orcid:` / `raw_author_name.search:` | author starting-graph mode | Filter / **Search** |
| Recency window | `?filter=from_publication_date:{date}` | every arrival query | (modifier) |

Sorting uses `cited_by_count:desc` and `publication_date:desc`. Pagination is
cursor-based (`cursor=*` then `meta.next_cursor`), `per-page` up to 200.

### Fields we actually read

If any of these disappear or are renamed, parsing breaks:

`id`, `doi`, `title` / `display_name`, `publication_date`, `type`,
`authorships[].author.display_name`, `primary_location.source.display_name`,
`referenced_works`, `abstract_inverted_index`, `topics[].display_name`,
`keywords[].display_name`, `concepts[].display_name`,
`locations[].landing_page_url` (for arXiv ids), `meta.next_cursor`.

**`referenced_works` is the one that matters most.** It is the sole source of
citation edges. Without it this plugin is an RSS reader.

---

## 2. What it costs

| Call type | Price | Credits (observed) |
|---|---|---|
| Singleton | free per docs | **1 credit observed** |
| List + Filter | $0.10 / 1,000 | 1 |
| Search | $1.00 / 1,000 | ~10 |
| Content download | $10 / 1,000 | not used |

**Daily allowance:** 1,000 credits keyless (measured from
`X-RateLimit-Limit`), roughly ten times that with a free API key. Resets at
midnight UTC.

> **Documented vs. observed.** The docs say single-entity lookups are "free,
> unlimited". A live probe showed `X-RateLimit-Credits-Used: 1` for a singleton
> and the remaining count decrementing. We trust the headers, because they are
> what actually gates us. This is why `backfillReferences` batches DOIs into
> one filter call rather than issuing one free-per-docs lookup each.

### Where our credits go

A typical update, keyless (1,000/day):

| Step | Credits |
|---|---|
| Adjacency query (100 anchors, 50/batch) | 2 |
| Topic search | ~10 |
| Feed fetches (arXiv/RSS) | 0 — not OpenAlex |
| Scheduled backfill, DOIs batched | 1 |
| Scheduled backfill, titles | **0 — goes to Crossref** (§0.1) |

| Configuration | Credits per run | Runs per keyless day |
|---|---|---|
| Adjacency only | ~3 | ~300 |
| Adjacency + topic (default) | ~13 | ~75 |
| Topic only | ~11 | ~90 |

Building a 100-paper starting graph is one search plus a few filters, ~12
credits.

**The topic search is now the dominant cost** — the only search-priced call
left on OpenAlex, and it is one per run rather than one per feed item. Before
Crossref, an update against a 25-item feed spent ~250 credits on title lookups
that mostly missed; that is now zero. A user who prefers adjacency selection
never issues a search-priced call at all.

---

## 3. Authentication

- Key is optional, free, and passed as `api_key=…` in the query string.
- Stored in plugin settings, blank by default, **never hardcoded** — a shipped
  key would put every user on one identity and one allowance.
- Keyless works. The plugin must never require a key.

**`mailto` and the "polite pool" are gone**, retired when keys arrived in
February 2026. Any code or docs still mentioning them is stale.

---

## 4. Decisions this pricing forced

Each of these is a deliberate trade, not an accident:

1. **Recency windows use `from_publication_date`, not `from_created_date`.**
   Index date is the better signal — OpenAlex indexes papers weeks after
   publication, so a publication-date window misses late-indexed work — but
   `from_created_date` is a **paid-plan filter** that answers `429 "Plan
   upgrade required"` on the free tier. The free substitute is a wide,
   deliberately overlapping window plus exact dedup.
2. **Feed items are not resolved by title at fetch time.** A title search costs
   ~10× a filter and, for a preprint published hours ago, near-certainly
   misses: measured live at 25 searches, 0 resolved. The scheduled backfill
   does the same work later, when OpenAlex plausibly has the paper.
3. **Backfill is scheduled, not repeated** — three widening attempts (next run,
   ~4 days, ~30 days) then a visible notice on the note. Previously every
   edge-less arrival was re-queried on every run forever.
4. **DOI→OpenAlex-id for kept papers is cached** in `data.json`. The mapping
   never changes, so re-resolving the library every run was pure waste.
5. **Adjacency batches 50 anchors per request**, halving the request count
   versus 25.
6. **One client per run**, so a single rate limiter paces everything. A client
   per call paced nothing.
7. **A 429 latches.** Once OpenAlex says stop, every later call in that run
   bails rather than each batch running its own retry ladder.
8. **`Retry-After` is capped at 30s.** An exhausted allowance returns hours
   (16043s seen live); honouring that literally would park a user-initiated
   run until midnight.

---

## 5. What breaks if OpenAlex changes

| Change | Impact | What needs rewriting |
|---|---|---|
| **`referenced_works` removed or paywalled** | **Severe.** Outbound edges survive via Crossref at ~half coverage (§5a); adjacency selection does not survive at all | New client for Crossref `/works/{doi}` behind `ReferenceResolver`; `worksCitingSince` and the `adjacent` mode retire |
| Keyless tier removed | Plugin stops working on install | `openAlexApiKey` becomes required; onboarding gains a mandatory step; README's "no account" claim goes |
| Daily allowance cut sharply | Large starting graphs become impractical | Lower `kernelSize` default; make topic search opt-in; lean harder on adjacency (filter-priced) |
| `cites:` filter paywalled | Adjacency selection dies — arrivals stop being connected by construction. **No free substitute exists** (§5a) | Fall back to topic search plus post-hoc edge resolution; `worksCitingSince` and the `adjacent` mode retire |
| Search calls paywalled | Topic mode dies; title backfill moves to Crossref (§5a) | Starting graph falls back to seeds/snowball/library modes (all filter-priced). `topWorks` and `worksByAuthor`'s name branch retire; `workByTitle` re-points at Crossref |
| `X-RateLimit-*` headers dropped | Gauge silently reverts to estimating | `budget.ts` already falls back to the local tally; only the label changes |
| Pricing per call type changes | §2's arithmetic is wrong | Re-measure with a probe; update this file and the `ADJACENCY_BATCH` / cap constants |
| Cursor pagination changed | Multi-page fetches break | `paginated()` in `core/openalex.ts` |
| `abstract_inverted_index` removed | Notes lose abstracts; edges unaffected | `reconstructAbstract` and the note template |
| Rate limit expressed differently | Retry logic may mis-handle | `getWithRetry` in `core/http.ts`, plus `isPlanRequired` / `isBudgetExhausted` |

## 5a. Measured alternatives (probed 2026-08-06)

Before assuming OpenAlex is irreplaceable, the candidates were actually tried
against the same paper (`10.1109/cvpr.2016.90`).

| Source | Outbound references | Inbound citations | Title → DOI | Cost |
|---|---|---|---|---|
| **OpenAlex** | inline with the record, all ids resolvable | `cites:` filter, date-filterable, 50 anchors/request | `title.search` | credits; search is 10× |
| **Crossref** | `/works/{doi}` → 49 refs, **only 23 carry a DOI** | not offered | `query.bibliographic`, **292 ms** | free, keyless |
| **OpenCitations COCI** | `/references/{doi}` → 26, all DOI-to-DOI, ~1.2 s | `/citations/{doi}` — **504 after 280 s** | not offered | free, keyless |

Three things follow:

1. **Outbound references are replaceable, at roughly half the coverage.**
   Crossref returned 49 references but only 23 with a DOI, and an id-less
   reference cannot be matched to anything in the vault. OpenCitations agrees
   at 26, which is unsurprising — COCI is built from Crossref deposits.
   OpenAlex also returns references *inline with the work*, so one filter call
   fetches 50 papers **and** their reference lists; Crossref needs one request
   per paper.
2. **Inbound citations are effectively not replaceable.** The one free source
   that offers them timed out. Even working, it answers per-DOI with no date
   filter — so "what cited any of my 100 papers in the last 30 days" would be
   100 requests and client-side filtering, against one OpenAlex call.
3. **Title → DOI is replaceable, cleanly and for free.** Crossref's
   `query.bibliographic` answered in under 300 ms with no key and no credits.
   Its near-miss behaviour is the expected one — searching "Attention is all
   you need" returned "Is Attention All You Need?" — which our existing
   `titlesMatch` guard already rejects.

**Actionable:** moving title resolution to Crossref would take the *only*
search-priced operation off OpenAlex entirely, leaving nothing but
filter-priced calls. That is the single highest-value change available for
reducing this dependency.

### The single point of failure

Everything above is survivable except the first row. **This plugin's premise
depends on one free source of reference lists.** That is worth knowing before
building anything else on top of it, and it is the strongest argument for
keeping `core/` provider-agnostic: the `Transport` seam and the narrow client
interfaces (`ReferenceResolver`, `SnowballResolver`) exist so a second provider
could be added without touching policy.

---

## 6. How to re-verify

The claims here decay. To check them:

```bash
npm run test:live     # structural checks against the real API
npm run test:vault    # builds a real vault and measures connectivity
```

For pricing specifically, one probe reports everything:

```bash
curl -sI "https://api.openalex.org/works?per-page=1&filter=default.search:quantum" \
  | grep -i x-ratelimit
```

`X-RateLimit-Credits-Used` on that response is what a search costs today.
Compare it against a `filter=cites:` call and a `/works/{doi}` singleton.
