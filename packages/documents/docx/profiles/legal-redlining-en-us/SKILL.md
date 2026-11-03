---
name: legal-redlining-en-us
description: How to use the documents tool for a contract redline, or a response to the other side's redline (profile legal-redlining-en-US). Read it with the documents skill before changing a contract.
---

# Documents for legal redlining

This profile layers on the core `documents` skill. Every change is a tracked change with
its rationale as a margin comment, written for the other side's lawyer to read.

## A first markup

1. `read` the brief and the whole contract, every part.
2. Plan by priority before editing: what moves a right, an obligation or a risk. Leave
   drafting preferences alone unless the brief asks for them.
3. Make the changes in one `revise` batch, or as few as possible, in document order. For
   each paragraph give its `paragraph` id, its full revised `text` (copy the current text
   from `read` and change only what must move) and the `rationale`.
4. Revise table cells by their ids (`p-105.r2c3`); a short rationale is fine for the cells
   of a row that share a reason.
5. Use `propose_edits` for a small fix after a batch, such as one figure, quoted from a
   fresh `read`.
6. Remove a whole numbered clause with `remove_section`: it strikes `from`..`through` and
   leaves `Reserved.` after `keep` (the heading), so the numbering after it still lines
   up. Strike a clause's words with `revise` only when the clause stays.

## A response turn

Tracked changes and comments in a file aren't always the other side's. Sort them by
author first: some can be your own side's earlier turn, or your own edits from this
session. Treat it as a response turn only when the request says the file came back from
the other side, or the authors show it did. Then, for the other side's markup:

- Leave their changes in place and layer yours on top, so they see what you did.
- `respond` with `counter` answers one of their changes with your own tracked change,
  inside their language, with the rationale on its `thread` when the point has one.
  Prefer it to rejecting: a counter keeps the discussion visible.
- Agree with `respond` `{action: "reply", thread, text: "Accepted."}`. Accept or reject
  only when the request asks to resolve changes for good, such as cleaning a draft
  before it goes out; those leave no trace.
- Changes the tool says it can't accept or reject here are for the lawyer to resolve in
  Word: list them in the open decisions.

## Rationale

Write each rationale as the reason, in one or two sentences, in your side's voice: what
the change protects and why the original doesn't work for you. Never narrate the edit
("Changed thirty to sixty"); the tracked change already shows it.

## When an edit fails

Fix that edit from its reason and the closest text, and resubmit only it. An edit that
fails twice is skipped: list it under "Edits not applied" in the open decisions, and never
retry it by widening it to more text. Read the redline back once before you finish and
check every change has its rationale.
