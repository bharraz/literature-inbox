# What this plugin needs from OpenAlex

OpenAlex is the only source of **citation edges** in this plugin, and edges are
the entire product. Everything else — arXiv, RSS — supplies titles. This
document records exactly what we depend on, what it costs, and what would break
if OpenAlex changed it.

Written 2026-08-06, after a live run discovered that two of our assumptions
were already out of date. Verify against the API before trusting it; the
"verified" column says how each line was established.

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
| Scheduled backfill, title searches | ~10 each |

So an ordinary run costs ~13 credits: about 75 runs a day. Building a
100-paper starting graph is one search plus a few filters, ~12 credits.

**Title search is the only thing that can blow the budget**, which is why feed
items are no longer resolved by title at fetch time — see §4.

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
| **`referenced_works` removed or paywalled** | **Fatal.** No citation edges; the product premise is gone | Nothing salvages it in-tree. Would need a second provider — OpenCitations/COCI (free DOI-to-DOI edges, no metadata) or Semantic Scholar (needs a key) |
| Keyless tier removed | Plugin stops working on install | `openAlexApiKey` becomes required; onboarding gains a mandatory step; README's "no account" claim goes |
| Daily allowance cut sharply | Large starting graphs become impractical | Lower `kernelSize` default; make topic search opt-in; lean harder on adjacency (filter-priced) |
| `cites:` filter paywalled | Adjacency selection dies — arrivals stop being connected by construction | Fall back to topic search plus post-hoc edge resolution; `worksCitingSince` and the `adjacent` mode retire |
| Search calls paywalled | Topic mode and title backfill die | Starting graph falls back to seeds/snowball/library modes (all filter-priced). `topWorks`, `worksByAuthor`'s name branch, `workByTitle` retire |
| `X-RateLimit-*` headers dropped | Gauge silently reverts to estimating | `budget.ts` already falls back to the local tally; only the label changes |
| Pricing per call type changes | §2's arithmetic is wrong | Re-measure with a probe; update this file and the `ADJACENCY_BATCH` / cap constants |
| Cursor pagination changed | Multi-page fetches break | `paginated()` in `core/openalex.ts` |
| `abstract_inverted_index` removed | Notes lose abstracts; edges unaffected | `reconstructAbstract` and the note template |
| Rate limit expressed differently | Retry logic may mis-handle | `getWithRetry` in `core/http.ts`, plus `isPlanRequired` / `isBudgetExhausted` |

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
