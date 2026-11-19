# Maintaining this plugin without knowing JavaScript

You know Python. This project is TypeScript (JavaScript with type
annotations bolted on). This file is a map from one to the other, focused on
the thing you'll actually do most: **changing text the user sees** — settings
labels, descriptions, notifications, error messages. It also covers the
minimum you need to run the project and trust that your change didn't break
anything, without having to read or understand most of the code.

Read `CLAUDE.md` first for the architecture rules. This file is about *how*
to make a small, safe change, not about the design.

---

## 1. The absolute minimum translation table

You don't need to learn TypeScript. You need to recognize these shapes when
you see them, so you know what's safe to touch and what isn't.

| TypeScript | Python equivalent | Notes |
|---|---|---|
| `const x = 5;` | `x = 5` | `const` = never reassigned. `let` = can be reassigned. There is no plain `var` in this codebase (obsolete). |
| `function f(x: number): string { ... }` | `def f(x: int) -> str: ...` | The `: number`, `: string` etc. are type annotations, exactly like Python type hints — but here they're *enforced* at build time (`npm run typecheck`), not just documentation. |
| `const f = (x) => x + 1;` | `f = lambda x: x + 1` | An "arrow function." Interchangeable with `function f(x) {...}` for our purposes. |
| `interface Foo { name: string; age?: number }` | A dataclass with an optional field | `?` after a field name means optional (can be missing/`undefined`), like a default of `None`. |
| `async function f() { await g(); }` | `async def f(): await g()` | Same concept as Python's `asyncio`, same keywords even. |
| `` `Hello ${name}` `` | `f"Hello {name}"` | Backtick strings (`` ` ``) are f-strings. Regular `"..."` or `'...'` strings are NOT — no `${}` interpolation inside them. **This is the #1 thing to get right when editing text** (see §3). |
| `a ?? b` | `a if a is not None else b` | "If `a` is null/undefined, use `b`." |
| `a?.b` | `a.b if a is not None else None` | "Only access `.b` if `a` exists." |
| `arr.map(x => x * 2)` | `[x * 2 for x in arr]` | |
| `arr.filter(x => x > 0)` | `[x for x in arr if x > 0]` | |
| `{ ...obj, name: "new" }` | `{**obj, "name": "new"}` | Spread — copy an object/dict with one field overridden. |
| `export function f() {}` | making `f` importable from this file | Roughly like not prefixing a Python name with `_`. |

Whitespace/indentation is **not** meaningful in TypeScript — `{ }` braces
mark blocks, and semicolons end statements. This means you *can* break code
by deleting a brace or a closing paren without deleting the matching visual
indentation, in a way Python wouldn't let you get away with silently. When in
doubt after an edit, run `npm run typecheck` (§4) — it will tell you exactly
which line is unbalanced.

---

## 2. Where things live (the short version)

Full detail is in `CLAUDE.md`. For text changes, you only need this much:

- **`src/settings.ts`** — everything on the settings page: every label,
  every description paragraph, every placeholder.
- **`src/main.ts`** — every toast/notification (the little popup after you
  click a button), every modal dialog (Feed test, Expand outward), and the
  wording of most error messages.
- **`src/core/notes.ts`** — the template for what a generated note looks
  like: the `### Cites` / `### Cited by` headings and frontmatter field names.
- **`src/core/*.ts`** (other files) — the *logic*. You will rarely need to
  touch these for a wording change; if a message you're looking for isn't in
  `settings.ts` or `main.ts`, search for it (§3.1) rather than guessing which
  core file it's in.

---

## 3. Changing a piece of text, step by step

### 3.1 Find it

Use your editor's project-wide search (VS Code: `Ctrl+Shift+F`) for a
distinctive fragment of the exact text you see in Obsidian. Search for
literal words, not the whole sentence — capitalization or a stray character
can differ slightly from what you remember seeing.

Example: to change the notice `"Add a feed URL first."`, search for
`Add a feed URL`. You'll land on one line in `src/main.ts`.

### 3.2 Recognize the string type before editing

Look at the quote character immediately around the text:

- `"..."` or `'...'` → a plain string. Edit freely between the quotes.
- `` `...` `` (backticks) → a **template literal**. It may contain `${...}`
  chunks — those are *code*, not text, and must be left alone (or moved as a
  whole unit) unless you're deliberately changing what value gets inserted.
  Example: `` `${count} arrival(s) not yet indexed` `` — you can reword
  around `${count}`, but don't remove `${count}` unless you mean to drop the
  number from the message.

### 3.3 Edit only the text inside the quotes

Don't touch:
- The quote characters themselves (keep `"..."` as `"..."`, don't turn it
  into `` `...` `` unless you're adding an interpolation, in which case use
  backticks for the *whole* string).
- Anything outside the quotes on that line (`.setName(`, `.setDesc(`,
  `notify(`, the trailing `)` and `;`).

A `Setting` in `src/settings.ts` typically looks like:

```ts
new Setting(containerEl)
  .setName("Library directory")
  .setDesc("Feel free to make subfolders — everything under this directory ...")
```

`setName` is the bold label; `setDesc` is the grey description text below
it. Both are just strings — change the words, leave the structure alone.

### 3.4 Run the tests

```bash
npm test
```

Some tests check exact wording (for example, that the settings page contains
the text `"Update your inbox"` somewhere). If you reword something a test
checks, the test will fail and print **the exact string it expected** next
to what it found — that's not a sign you broke something real, it's the
test being out of date with your intentional change. Open the failing test
file (same search technique as §3.1, search for the old text inside
`tests/`), and update the expected string there to match your new wording.

If a test fails on a string you *didn't* mean to change, that's a real
signal — revert and look again at what you edited.

### 3.5 Build

```bash
npm run build
```

This regenerates `main.js`, the file Obsidian actually loads. Editing
`src/*.ts` alone does nothing until you build. Copy `main.js`,
`manifest.json`, and `styles.css` into your test vault's
`.obsidian/plugins/literature-inbox/` folder (or run
`bash test-vaults/reset.sh <vault-name>`, which does this for you), then
reload the plugin in Obsidian (Community plugins → toggle it off and on, or
`Ctrl+P` → "Reload app without saving").

---

## 4. The commands, translated to what they check

```bash
npm install       # once, or after package.json changes — installs dependencies
npm test          # runs 500+ tests with no network access
npm run typecheck # checks every file's types line up — like running a linter
                   # that Python doesn't have built in. Catches typos in
                   # variable names and mismatched braces/parens.
npm run build     # typecheck, then bundle everything into main.js
```

Run `npm test` after every change, `npm run build` before testing in a real
vault. If either command prints red text, read the first error only — later
errors are often just consequences of the first one and disappear once it's
fixed.

---

## 5. Common ways to break something while editing text (and how it'll tell you)

- **Unmatched quote** (`"Hello` with no closing `"`) → `npm run typecheck`
  fails immediately, usually pointing at the exact line, sometimes the line
  after (the parser gets confused about where the string ends).
- **Straight quote inside a string that uses the same quote character**
  (`"She said "hi""`) → same failure. If your text needs a quote mark inside
  it, either switch the surrounding quotes to the other kind (`'She said "hi"'`)
  or escape it (`"She said \"hi\""`).
- **Deleted a `${...}` that a message relied on** → the message will just
  print literally without the number/name filled in — not a crash, but a
  content bug. `npm test` may or may not catch this depending on whether a
  test checks that string.
- **Changed a string a test also checks, and only edited one of the two
  places** → `npm test` fails with a clear "expected X, got Y" diff. This is
  the *expected*, safe way to find out — just update the test's copy of the
  string to match.

If you get stuck on a typecheck error you don't understand, paste the exact
error text (the file path, line number, and message it prints) — it's
usually a one-line fix even when the error message looks intimidating.
