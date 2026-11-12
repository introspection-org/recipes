# Document tools

A Recipe that reads or marks up documents declares the **document formats** it
works with. The host then registers one `documents` tool with a `command`
discriminator, shaped identically for every format. Each format is a package
that supplies the mechanics and a capability descriptor; the commands, their
schemas and the rules about where files may be written live in the host.

Two properties follow, as for [channels](../channels/README.md):

- **A command a format cannot support is absent for that format, not
  failing.** Each format package declares what it supports, and the tool
  routes by file extension. `render` exists when some declared format
  renders; calling it on a `.docx` fails before any work and names the
  formats that support it.
- **The original is never changed.** Every write takes the document to read
  (`path`) and a new file under `outputs/` to save (`output`). Later calls
  edit that saved file in place by passing it as `path`. The tool refuses to
  write outside `outputs/` or over a file it did not save.

Agents select `tools: [documents]`.

## Declare document formats

```json
{
  "pi": {
    "documents": [{ "format": "docx" }, { "format": "pdf" }]
  }
}
```

```yaml
tools: [documents]
```

Each declaration names a format, served by the package
`@introspection-ai/recipe-documents-<format>`. Recipes installs the docx,
pdf and html packages alongside itself (they are `optionalDependencies` of
`@introspection-ai/recipes`), so a Recipe that does not list them uses the
copy beside the running Recipes, Python environment and profiles included.
Declare it in `peerDependencies` by default, which says so explicitly: the
platform provides it.

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-documents-docx": ">=X.Y.Z",
    "@introspection-ai/recipe-documents-pdf": ">=X.Y.Z"
  },
  "pi": {
    "documents": [
      { "format": "docx", "profile": "legal-redlining-en-US" },
      { "format": "pdf" }
    ]
  }
}
```

To pin an exact version, list the package in `dependencies` instead, and the
Recipe's copy wins:

```json
{
  "dependencies": {
    "@introspection-ai/recipe-documents-docx": "X.Y.Z"
  }
}
```

`X.Y.Z` stands for a released version (`npm view @introspection-ai/recipe-documents-docx version`): a peer takes an open floor, `>=X.Y.Z`, and a pin an exact version.

Any other format must be declared, in `dependencies` (the
Recipe brings it) or `peerDependencies` (the platform provides it, and the
runtime image build fails without it); `recipes check` and the runtime both
reject a declaration with neither. Whichever copy loads must implement the
format contract the running Recipes implements (`apiVersion`, below), and a
package that declares a Recipes peer range must admit the running version, or
the Recipe fails to load naming the package and the fix. When neither the
Recipe nor the Recipes install has the package, add it to `dependencies` or
reinstall Recipes with `introspection upgrade`. An
optional `commands` allowlist narrows what that format may do, for every agent:

```json
{ "pi": { "documents": [{ "format": "docx", "commands": ["read", "comment"] }] } }
```

`read` is always available for a declared format; an empty list disables the
format. Unknown commands fail `recipes check`; a command the format does not
support fails when the runtime loads the package.

Unlike channels, where each provider owns its own `channels` tool, formats
share one tool: a Recipe reads a PDF brief and edits a Word contract in the
same turn, and two `documents` tools would collide.

## Skills and profiles

Every agent that selects `documents` is offered a core `documents` skill: which
command fits which change, how to quote, and what each failure means. It is
generic, with nothing about any one kind of work.

A **profile** is a skill for one kind of work, offered beside the core skill.
A declaration selects at most one, either shipped by the format, by name, or the
Recipe's own, by a relative path:

```json
{ "pi": { "documents": [{ "format": "docx", "profile": "legal-redlining-en-US" }] } }
```

```json
{ "pi": { "documents": [{ "format": "docx", "profile": "./profiles/house-style-en-gb" }] } }
```

The docx package ships `legal-redlining-en-US`
(`packages/documents/docx/profiles/`): planning a first markup of a contract,
answering the other side's redline with counters and replies, and writing each
rationale in your side's voice. A name matches regardless of case.

A profile changes what the agent is told, never what the tool does: commands,
schemas and the path policy are the same with or without one. Nothing in a
profile runs; it is only read.

### Write your own profile

A profile is a folder holding a `SKILL.md`, anywhere inside the Recipe:

```text
profiles/
  house-style-en-gb/
    SKILL.md
```

Name a profile `<use-case>-<locale>`: a kebab-case use case, which may be a
domain and a task (`legal-redlining`, `house-style`), then a BCP 47 locale
with its region (`en-US`, `en-GB`), because spelling and conventions, legal
ones above all, differ by region. Use the language alone (`-en`) only when
the guidance doesn't depend on region. The folder and the frontmatter `name`
are the name in lower case (`house-style-en-gb`); a `profile` declaration
matches it in any case.

The `SKILL.md` starts with frontmatter. `name` must be the folder's name, in
lower case; `description` says when to read it:

```markdown
---
name: house-style-en-gb
description: How we edit internal memos in Word. Read it with the documents skill before changing a memo.
---

# Editing memos

This profile layers on the core `documents` skill.

## When it applies
Internal memos and policies in Word. Not contracts: those go to legal.

## Planning
Read the whole memo first. Change only what's wrong or unclear; keep the
author's structure and voice.

## Making the changes
- Rewrite a paragraph with `revise`: its `paragraph` id, its full new `text`,
  and a `rationale`.
- Fix a word or a figure with `propose_edits`, quoting from a fresh `read`.
- Raise a question without changing the text with `comment`.

## Comments
Each rationale says why in one sentence, in plain British English. Never
narrate the edit; the tracked change already shows it.

## When an edit fails
Fix that edit from its reason and the closest text, and resubmit only it. After
two failures, list it for the author instead.
```

Then point the declaration at the folder, or at its `SKILL.md`. The path must
stay inside the Recipe, by its real path too: a symlink to a folder outside it
is refused.

What a profile should say:

- **When it applies,** and when it doesn't, so the agent reads it at the right time.
- **How to plan the work** before editing: what to change, what to leave alone.
- **Which `documents` commands to use for which change,** and how: `revise` for
  rewriting paragraphs, `propose_edits` for small fixes, `comment`, `respond`,
  `remove_section`.
- **How to write rationales and comments:** voice, length, what they explain.
- **What to do when an edit fails,** and when to stop and hand it to a person.

What belongs in the Recipe's own skills instead: a team's or a client's
positions, playbooks, approvals and facts about a deal. A profile describes a
kind of work; the Recipe knows the particular case.

`recipes check` validates the shape: a name, or a relative path inside the
Recipe. For a path it also checks that the `SKILL.md` exists, resolves inside
the Recipe, and has a matching `name` and a `description`. A name the format
doesn't ship fails when the Recipe loads, with the names it does ship.

## Commands

| Command (`documents` + `command`) | Arguments | Requires |
| --- | --- | --- |
| `read` | `path`, `offset?`, `budget?`, `pages?`, `tables?` | always | The page as markdown (`.html`, `.htm`; an `.svg` file is one chart): headings, lists and GFM tables, scripts and styles dropped, each chart (an outermost `<figure>` or `<svg>`) a `[chart N: label]` line. Paged by character. |
| `revise` | `path`, `output?`, `author`, `revisions[]` (`paragraph`, `text`, `rationale`) | `revise` | not registered |
| `propose_edits` | `path`, `output?`, `author`, `edits[]` | `proposeEdits` | not registered |
| `comment` | `path`, `output?`, `author`, `text`, and `quote` (`paragraph?`, `near?`, `occurrence?`) or `thread` | `comment` | not registered |
| `respond` | `path`, `output?`, `author`, `responses[]` | `respond` | not registered |
| `remove_section` | `path`, `output?`, `author`, `from`, `through`, `keep?`, `rationale` | `removeSection` | not registered |
| `render` | `path`, `pages?` | `render` | With a browser, the full page light and dark and each chart as its own element screenshot, at 2x; without one, each inline `<svg>` chart through resvg, naming what it could not draw. `pages` picks charts. |

An edit is `{ op: "replace" | "delete" | "insert_after", quote, paragraph?,
near?, occurrence?, new?, rationale }`. A response is `{ action: "accept" |
"reject", changes }`, `{ action: "reply", thread, text }` or `{ action:
"counter", quote, new, rationale, paragraph?, near?, occurrence?, thread? }`.

Results are compact text for the model: a write reports each edit as applied,
with a one-line before/after, or failed, with a reason and the closest
candidate paragraphs. It never returns the whole document; `read` does that.

## What each format registers

| Command | docx (`@introspection-ai/recipe-documents-docx`) | PDF (`@introspection-ai/recipe-documents-pdf`) | HTML (`@introspection-ai/recipe-documents-html`) |
| --- | --- | --- | --- |
| `read` | Paragraphs with stable ids (`p-031`, `p-012.r2c3` in tables) and their current text, Word's list numbers, a `markup:` line with tracked changes and comments by author, then numbered changes and comment threads. Paged by paragraph. | The path used (text, tables or page images), then pypdfium2's text page by page in reading order, filled form fields and page comments. `tables: true` adds table cells with the `tables` extra. Pages with no text layer are named, to render. Paged by character. | The page as markdown (`.html`, `.htm`; an `.svg` file is one chart): headings, lists and GFM tables, scripts and styles dropped, each chart (an outermost `<figure>` or `<svg>`) a `[chart N: label]` line. Paged by character. |
| `revise` | Each paragraph's revised text: on a file with no pending changes, untracked edits on a working copy and paper-docx `compare(granularity="word")` build the redline; if compare refuses the batch, or the file already has changes, the same word-level changes go in as targeted tracked edits. The rationale is a comment on the changed text. | not registered | not registered |
| `propose_edits` | Tracked changes signed by `author`, each with its rationale as a comment, saved with `patch_save` | not registered | not registered |
| `comment` | New comment on a quote, or a reply under a thread's first comment | not registered | not registered |
| `respond` | Accept or reject by change number (tracked moves resolve as a pair), reply, or counter | not registered | not registered |
| `remove_section` | Strikes the paragraphs, leaves `Reserved.` after `keep`, keeps numbering | not registered | not registered |
| `render` | not registered | PNG files of pages, at most 10 per call; returns their paths for Pi's `read` tool | With a browser, the full page light and dark and each chart as its own element screenshot, at 2x; without one, each inline `<svg>` chart through resvg, naming what it could not draw. `pages` picks charts. |

### docx: revise or propose_edits

`revise` takes no quotes: the agent gives a paragraph id and that paragraph's
full revised text, and the tool works out the changed words. It is the path for
a first markup, where most failures in practice came from quoting. One
`compare` runs per batch; on a contract full of proofing marks and layout hints
it often refuses, and the batch then takes the tracked path, which handles those
marks. `propose_edits` remains for small fixes and response turns, where an edit
sits inside someone else's change. A revision whose text is unchanged becomes a
comment on that paragraph, and a revision without a rationale fails alone rather
than failing the batch's schema check.

`compare` is used only when its result keeps the body's block structure:
paper-docx 0.2.0 inserts empty paragraphs for some multi-paragraph batches, which
would move every later paragraph id, so such a result is discarded for the
tracked path.

### docx: anchors

A quote is matched against the paragraph's current text, the text `read`
shows. Matching forgives runs of whitespace, non-breaking and thin spaces,
curly quotes and apostrophes, dashes and soft hyphens, then case. When a
quote only matches without a leading list number such as `5.2` or `(a)`, the
number is ignored and the result says so. `paragraph` restricts the search to
one paragraph; `near` ranks repeats by distance to nearby text; `occurrence`
picks the nth.

The edit lands on the original runs. Unchanged words at either end of the
quote are kept out of the change, compared after the same folding, so retyping
a curly quote as a straight one does not strike it. A replacement is written
as a deletion of the old words and an insertion of the new ones, so Word shows
whole words rather than paper-docx's letter-level alignment. A span that
crosses a bookmark, proofing mark, layout hint (`lastRenderedPageBreak`), the
edge of a tracked change, a tab, a line break or a no-break hyphen is edited in
parts between the marks; a tab, break or hyphen stays as it was. paper-docx does
not match text across a tracked deletion, so the same split applies to finding
text. When the parts are refused too, the result is `crosses_marker`, naming the
marks and the safe parts. The tool never retries by widening an edit.

A failed anchor is reported, never guessed: `not_found` (with the closest
paragraphs and their most similar text), `ambiguous` (with every match),
`paragraph_not_found`, `occurrence_out_of_range`, `unaddressable` (inside a
field, content control or text box), or `refused` with the library's reason.
The failed edit is rolled back and the rest of the batch still applies.

The anchoring and the `Reserved.` removal follow RedlineBench's redline
engine (MIT, Crosby Legal; the licence ships beside the helpers).

### docx: not registered

`render` is absent for Word: page images need a layout engine such as
LibreOffice, which the runtime image does not carry. Table structure, fields,
content controls, headers and footers, footnotes and formatting changes are
not commands. The core `documents` skill tells the agent to say so in its
reply rather than work around the tool with a script or by editing the XML.

### PDF: text, tables and page images

Every PDF `read` starts with `Path:` and the route it took:

- **text**: pypdfium2's text for each page, in reading order. This is the
  default and suits prose: on legal deal briefs it got every key fact in about
  5 ms a brief, against about 55 ms for pypdf.
- **tables**: with `tables: true`, each table also comes back as rows of cells
  from pdfplumber. Ask for tables on contracts with fee schedules, SLA grids or
  price tables: plain text runs a row's cells together, and pdfplumber was the
  only library tried that returned a fee table as real cells. It needs the
  adapter's `tables` extra (below); without it, `read` returns the text and a
  note that the extra is missing.
- **page images (no text layer)**: a page with no text is a scan. `read` names
  those pages and suggests `render`, which writes each page as a PNG file and
  returns its path; the agent opens it with Pi's `read` tool. Render also to
  check signatures, stamps, charts or layout.
  The images go to a new directory per call under the system temp
  directory, or under `pagesDir` when the host passes one to
  `registerDocumentTools`.

PDFs are never changed: every write command is absent for `.pdf`.

#### The `tables` extra

pdfplumber is optional because of its size: about 41 MB installed, since it
brings pdfminer.six, cryptography, Pillow and cffi, against 7.7 MB for
pypdfium2. To enable tables, add it to the Recipe's Python environment and lock
it:

```toml
# python/pyproject.toml
dependencies = ["pypdfium2==5.14.0", "pillow==13.0.0", "pdfplumber==0.11.10"]
```

then `uv lock`. The helper imports pdfplumber only when a read asks for tables,
and nothing is fetched at run time. A profile for contract or pricing work may
recommend the extra; a Recipe that only reads briefs can leave it out.

## Limits

- `read` returns about 50,000 characters per part; pass the `offset` it gives.
- A batch takes at most 60 edits or responses.
- Paragraph ids are body-block positions. Edits never add or remove blocks, so
  ids hold for a whole redline; a document edited elsewhere gets new ids.
- Change numbers for `respond` are positions in the file as read: read again
  after any change. Each accept or reject response applies whole or not at
  all, so a bad number leaves its response's other changes unresolved.
- List numbers in `read` are approximate: restarts and overrides are not
  modelled.

## Python

The Word and PDF helpers are small Python programs (HTML runs in Node and needs none). Each format package
declares its own `pi.runtime.python` environment, locked by the package's
`python/uv.lock`: paper-docx for Word, pypdfium2 and pillow for PDF. The host
prepares that environment for the installed package, as it does every
package's (see [Runtime requirements](../recipe-format.md#runtime-requirements)),
and passes its interpreter to the adapter. A Recipe declaring `pi.documents`
declares and locks none of these packages itself; its own
`pi.runtime.python`, if any, stays its shell environment. The helpers use
`RECIPE_DOCUMENTS_PYTHON` first when it is set (tests, custom hosts), then the
interpreter the host passes, then `VIRTUAL_ENV`, then `python3`. An extension
that needs one of these interpreters itself reads it with
`packagePython("@introspection-ai/recipe-documents-docx")` on its session
context (see [Package declarations](../recipe-format.md#package-declarations)). Package
environments are synced without extras, so PDF `tables: true` needs
pdfplumber from an environment synced with `--extra tables` and named by
`RECIPE_DOCUMENTS_PYTHON`.

## How a Recipe's skills should use it

Skills say what good work is; the tool does the mechanics. A skill names the
command and what goes in it (`documents propose_edits`, one edit per change,
the rationale as the comment) and spends its words on judgement: what to
change, how to word the comment, which bucket a counterparty change falls in.
It does not print scripts, explain library calls or describe file copying.
Tell the agent to copy quotes from `read`, give the paragraph id, resubmit
only failed edits, and read the result back before finishing. For PDFs, a skill
says when tables matter (fee schedules, SLA grids, price tables) so the agent
passes `tables: true`, and that a page with no text layer is rendered and
looked at with `read`.

## Write a format

A format supplies an adapter and a capability descriptor; it writes no tool
schemas. It exports a plain object, `RecipeDocumentFormatModule`, and
everything it needs from Recipes at run time arrives through `createAdapter`,
so the package imports only Recipes' types and needs no run-time dependency on
`@introspection-ai/recipes` (keep it in `devDependencies`):

```ts
import type { RecipeDocumentFormatModule } from "@introspection-ai/recipes/documents";

const pdf: RecipeDocumentFormatModule = {
  kind: "documents",
  apiVersion: 1,
  format: "pdf",
  extensions: [".pdf"],
  capabilities: { read: true, render: true },
  createAdapter: ({ env, python, runHelper }) => new PdfDocumentAdapter({ env, python, runHelper }),
};

export default pdf;
```

`apiVersion` names the contract the format was written against; the host
refuses a different one, naming the package, both versions and the fix.
`createDocumentFormatModule` from `@introspection-ai/recipes/documents` builds
the same object, for a format that depends on Recipes anyway.

`createAdapter` also receives `python`: the interpreter of the environment the
format package's own `pi.runtime.python` declares, which the host prepares
(see [Runtime requirements](../recipe-format.md#runtime-requirements)). It is
absent when the package declares none; an adapter that ignores it keeps
working.

A Python helper runs with `runHelper(script, request, { env, cwd, python,
signal })`, which the host passes to `createAdapter`: its
`runDocumentHelper`. It is
`runPythonJson` from `@introspection-ai/recipes/python` with the document
contract on top: the interpreter order above, including
`RECIPE_DOCUMENTS_PYTHON`; a helper that prints `{ "error": "..." }` fails the
call with that message; and the result is a `DocumentResult` (`text`,
`details`, `images`) whose `details.timing.call_ms` records the round trip.
The Word and PDF packages run every command through it.

Registration checks that the adapter implements every method its
capabilities claim, and that the adapter returns the declared capabilities.
A format package ships its code and its profiles (see Skills and profiles), so
a profile resolves the same from the copy installed alongside Recipes as from
a pinned one.
A skill that teaches a format library, such as Paper's `docx` skill, is a
dependency of the Recipe that uses it, installed when the runtime is baked.

## After review: sending for signature

The document tools never send a file anywhere. Once a person has reviewed the
redline and every change is resolved, the [signatures tool](../signatures/README.md)
sends the final `.docx` under `outputs/` for e-signature, and refuses one that
still has tracked changes or comments.

## Format pages

- Word: this page; `packages/documents/docx/README.md`.
- PDF: this page; `packages/documents/pdf/README.md`.
- HTML: this page; `packages/documents/html/README.md`.
