---
name: documents
description: How to read Word, PDF and HTML files, check an HTML page's charts, and mark up Word files with the documents tool. Load it before opening, editing, commenting on or responding to any document.
---

# Documents

The `documents` tool does every change to a document. It finds the text, keeps the
formatting, signs every change with `author`, and never touches the original.

## Choose the command

Always `read` first, every part: pass `offset` from the previous part until it ends. Then:

| You want to | Use |
| --- | --- |
| Change a few words: a figure, a term, a short phrase | `propose_edits`: `{op: "replace", quote, new, rationale}`; `delete`; or `insert_after` with `new` |
| Rewrite most of a paragraph, or make several changes in one | `revise`: `{paragraph: "p-012", text: <its full new text>, rationale}` |
| Remove a whole numbered section and keep the numbering | `remove_section`: `{from, through, keep, rationale}` |
| Comment without changing text, or reply on a thread | `comment`: `{quote, text}`, or `{thread, text}` |
| Answer markup already there | `respond`: accept or reject by change number, reply on a thread, or counter with your own change |
| See a PDF page as an image (a scan, a signature, a chart) | `render`, then open the image it returns |
| Check that each chart on an HTML page makes sense | `render` the page, then open each chart image it returns; `pages: "2"` renders chart 2 alone |

Every change carries its `rationale`, which becomes a margin comment.

## Paths

The first change takes `path` (the file you were given) and `output` (a new file under
`outputs/`). Every later change takes `path` set to that output and no `output`. Never
rebuild a file from scratch.

## Quoting

Copy quotes from the text after the paragraph id in `read`, within one paragraph, and
pass that `paragraph` id. Quote only enough to find the place once; `near` or
`occurrence` picks one match when it repeats. Spacing, curly quotes and dashes are
forgiven; words and capitalization are not. With `revise` there is nothing to quote:
copy the paragraph's current text and change only what must change.

## When something fails

Each item reports `applied` or `FAILED` with a reason; a failed item changed nothing and
the rest still went in. Resubmit only the failed ones, with `path` set to the saved file:

- `not_found`: use the `closest` text it lists, or `read` again; your earlier changes may
  have moved the text. If the paragraph changed a lot, `revise` it by id.
- `ambiguous`: add `paragraph`, `near` or `occurrence`.
- `crosses_marker` or `unaddressable`: the change crosses something Word keeps (a tab, a
  field, a content control). Change the words on each side separately, or `revise` the
  paragraph with its full new text.
- `change_not_found` or `invalid_changes`: take change numbers from a fresh `read`;
  resolving changes renumbers the rest.

Never resubmit an applied item: it would apply twice.

## Don't drop to a script

Don't write Python or shell to change a document, and don't edit its XML: the tool covers
the changes above, keeps the file valid and records who changed what. If it truly can't do
something, say so in your reply rather than working around it. Read the result back with
`read` before you finish.

A profile may add hints for one kind of work, as a skill beside this one; follow both.
