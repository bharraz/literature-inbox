# Path to the Obsidian community plugin store

Where this plugin stands against the actual submission process, and what to
expect from review. This expands on the one-line checklist in `roadmap.md`
("Reviewer non-negotiables") — that section says *what* must stay true;
this file is *how the submission itself goes* and *what a human reviewer is
likely to push back on*, specific to this codebase as it stands today.

Nothing here is guesswork about Obsidian's process in general — the
mechanics (bot checks, then a human reviewer, PR against
`community-plugins.json`) are the documented, current process. The
per-plugin risk assessment below is from reading this repo's actual code.

---

## 1. What's already true (verified against this repo)

- `manifest.json` has `id`, `name`, `version`, `minAppVersion`, `description`,
  `author`, `isDesktopOnly: false` — all the required fields, all populated.
- `versions.json` exists and is expected to map plugin versions to
  `minAppVersion` — keep it updated on every release (the release workflow
  should do this, but confirm before each tag).
- No `eval`, no `innerHTML`/`outerHTML`, no global `fetch` — grepped the
  whole `src/` tree to confirm. Network goes through `requestUrl()` only, and
  only from `src/obsidian-adapter.ts`, per `CLAUDE.md`.
- No bundled binaries, no launching external processes.
- `MIT` license is declared in `package.json`.
- Manual-only execution: no `registerInterval`, no network call on load.

## 2. What to do, in order

1. **Pick the version you're actually submitting.** The store reviews
   whatever tag you point it at; don't submit mid-development. `1.2.0` is
   current.
2. **Tag the release.** Bare version, no `v` prefix (`1.0.0`, not `v1.0.0`) —
   already a documented gotcha in `CLAUDE.md`, and the release workflow
   checks the tag against `manifest.json`. Pushing the tag runs
   `.github/workflows/release.yml`, which should attach `main.js`,
   `manifest.json`, and `styles.css` to the GitHub release — the community
   store reads these three files directly off the release, not off your
   repo's default branch source.
3. **Fork `obsidianmd/obsidian-releases`** and add one entry to
   `community-plugins.json` (alphabetical by `id`):
   ```json
   {
     "id": "literature-inbox",
     "name": "Literature Inbox",
     "author": "Bahaa Harraz",
     "description": "New papers arrive as notes wired by citation edges to the papers you already keep, so you triage by looking at your graph.",
     "repo": "bharraz/literature-inbox"
   }
   ```
   The `description` field has a hard length cap enforced by the bot (roughly
   250 characters) — the one above is short enough, but re-check if you
   change the wording.
4. **Open the PR.** A bot (`Release Checks` / the plugin-review Action) runs
   immediately and comments with a checklist: manifest validity, id
   uniqueness, tag/release asset presence, banned-API scan, `isDesktopOnly`
   presence, license file presence. Everything in §1 above should make this
   pass clean on the first try.
5. **Wait for a human reviewer.** This is the part with no fixed timeline —
   historically anywhere from a couple of weeks to a couple of months,
   depending on review queue length. The PR thread is the only channel; there
   is no way to expedite it.
6. **Respond to review comments in the PR thread**, push fixes to your repo,
   tag a new release if the fix touches plugin code (the reviewer re-checks
   against the tagged release, not your latest commit). Comment on the PR
   once done so it re-enters the queue rather than sitting silently.

## 3. What a reviewer is likely to flag, specific to this plugin

Ranked by how likely each is to come up, based on reading the actual code
and README as they stand:

1. **"What does this send, and to whom?"** — this plugin talks to OpenAlex,
   arXiv, Crossref, and optionally an RSS URL and a locally-run Zotero
   instance. Reviewers specifically look for a plain-English disclosure of
   every external service a plugin contacts, since this is the single most
   common reason a plugin gets sent back for revision. `README.md` should
   name all of these explicitly near the top, not just imply them via feature
   descriptions — worth double-checking the README says "OpenAlex, arXiv,
   Crossref" by name before submitting, and add Zotero once/if the local-API
   feature in `zotero-local-api-proposal.md` actually ships.
2. **Inline styles.** `src/main.ts` and `src/settings.ts` set
   `.style.width`, `.style.height`, etc. directly on a few elements (a text
   input's width, a progress bar). This is a very common **nit**, not a
   blocker — reviewers often ask plugins to move inline styles into
   `styles.css` as classes instead, for theme-compatibility reasons (a
   hardcoded color especially would look wrong in some themes; the ones here
   are mostly dimensionless like `width`/`height`/`overflow`, which is lower
   risk, but still worth pre-emptively moving to CSS classes to skip a review
   round-trip).
3. **API key handling.** The optional OpenAlex "polite pool" email/key is
   stored in plain `data.json` like any other setting. This is normal and
   expected for a user's own, non-secret API identifier — but be ready to
   explain in the PR thread *why* it's optional and *what it's for* (faster
   rate limits, nothing account-specific) if asked, since "stores an API key"
   pattern-matches things reviewers do scrutinize.
4. **README completeness.** Obsidian's guidelines expect: what the plugin
   does, how to use it, and ideally a screenshot or short GIF of it in
   action. This repo's README is thorough on the *what* and *why* but has no
   image — worth adding one screenshot of the graph view mid-triage before
   submitting; "show, don't just tell" is a frequent review comment for
   graph/visual plugins specifically.
5. **Funding/support link.** Optional, but `manifest.json` supports a
   `fundingUrl` field and its absence sometimes draws a passing comment, never
   a blocker. Add it only if you actually want one.
6. **Name/id collision.** "Literature Inbox" and `literature-inbox` need to
   not already exist in `community-plugins.json` — check this yourself
   before opening the PR (search the file directly on GitHub); the bot also
   checks this but confirming first avoids a wasted review cycle.
7. **Scope questions on the Zotero angle.** If the local-API proposal ships
   before submission, expect a reviewer to ask why a citation-graph plugin
   talks to a locally running third-party app's API — have the one-paragraph
   answer ready (optional feature, off by default, `requestUrl` to
   `localhost` only, no data leaves the machine).

## 4. What is *not* a concern here

Worth stating plainly so a future re-read of this file doesn't waste time
re-litigating settled ground:

- The core architecture split (`core/` vs `obsidian-adapter.ts`) already
  matches what reviewers look for structurally, even though they don't see
  your source layout directly — it shows up as clean behavior (no
  Vault/network calls from unexpected places).
- Manual-only execution is already correct and needs no changes.
- Mobile compatibility (`isDesktopOnly: false`) is already correct; nothing
  in the codebase does anything desktop-only (no `require('fs')`, no child
  processes).

## 5. After acceptance

Every subsequent release is just: bump `manifest.json` version, add the
matching entry to `versions.json`, tag it (no `v` prefix), push the tag. The
community store auto-updates from the tagged release assets — no new PR
needed unless `minAppVersion` changes in a way that needs a
`community-plugins.json` update (it doesn't, normally).
