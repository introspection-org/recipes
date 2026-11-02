"""The Word commands of the `documents` tool, on paper-docx.

Every write reads `source`, applies what it can, and saves to `output` with patch_save, so parts it
did not touch stay byte for byte. One failed edit never stops the rest: it is rolled back and
reported with its reason. The accept/reject/reply logic is recipe-redlining's
skills/responding-to-a-redline/respond.py; the "Reserved." section removal follows RedlineBench's
redline_engine/reserved.py (MIT, see LICENSE-redline-bench).
"""

from __future__ import annotations

import io
import re
from collections import defaultdict

import docx
from docx.commentops import comment_thread, parent_of, reply
from docx.package import patch_save
from docx.revision import _move_units  # no public API pairs a move's sites; paper-docx is pinned
from docx.search import find_text

from .anchors import AnchorFailure, Located, fold, locate, snippet
from .model import ADDED, BODY, CONTAINERS, REMOVED, W, census, change_lines, margin_lines, run_text, thread_lines, units, walk

TEXT_BUDGET = 50_000


def initials_of(author: str) -> str:
    letters = "".join(word[0] for word in author.replace("(", " ").split()[:2] if word[0].isalnum())
    return letters.upper() or "A"


# --- read -------------------------------------------------------------------------------------


def read(request: dict) -> dict:
    document = docx.Document(request["path"])
    offset = max(int(request.get("offset") or 0), 0)
    budget = int(request.get("budget") or TEXT_BUDGET)
    found = units(document, labels=True)
    comments = {c.comment_id: c for c in document.comments}
    revisions = list(document.revisions)

    # After the paragraphs come the footer and the listings, paged under the same budget: offsets
    # past the last paragraph continue into them, so a heavily marked-up document still reads in parts.
    tail: list[str] = list(margin_lines(document, "footer"))
    changes = change_lines(document)
    if changes:
        tail.append("\n## Tracked changes (numbers for respond; they change when the file changes)")
        tail += changes
        for kind, count in revisions.remaining_unsupported().items() if hasattr(revisions, "remaining_unsupported") else []:
            tail.append(f"  {count} {kind} can't be accepted or rejected here: the lawyer resolves those in Word")
    threads = thread_lines(document)
    if threads:
        tail.append("\n## Comment threads (thread numbers for comment and respond)")
        tail += threads
    total = len(found) + len(tail)
    if offset and offset >= total:
        raise ValueError(f"offset {offset} is past the end: the read has {total} entries ({len(found)} paragraphs, then the listings)")

    lines: list[str] = []
    if offset == 0:
        authors = census(document)
        summary = ", ".join(f"{key} {count}" for key, count in sorted(authors.items()))
        lines.append(
            f"{len(found)} paragraphs ({found[0].id if found else '-'}..{found[-1].id if found else '-'}), "
            f"{len(revisions)} tracked change(s), {len(comments)} comment(s)" + (f": {summary}" if summary else "") + "."
        )
        lines.append(
            "Quote from the text after each id. §1.2. is Word's list number (approximate), not part of the text."
            " A 'markup:' line shows [+inserted+] and [-deleted-] text and «commented» text, by author."
        )
        lines += margin_lines(document, "header")
    used = sum(len(line) + 1 for line in lines)
    seen: set[int] = set()
    next_offset = None
    for position in range(offset, total):
        if position < len(found):
            unit = found[position]
            if not unit.text.strip() and not unit.marked:
                continue
            head = unit.id + (f" §{unit.label}" if unit.label else "")
            style = f" ({unit.style})" if unit.style and unit.style not in ("Normal", "List Paragraph", "Body Text") else ""
            line = f"[{head}]{style} {unit.text.strip()}"
            if unit.marked:
                line += f"\n    markup: {walk(unit.element, comments, seen).strip()}"
        else:
            line = tail[position - len(found)]
        if used + len(line) > budget and position > offset:
            next_offset = position
            break
        lines.append(line)
        used += len(line) + 1
    if next_offset is not None:
        where = found[next_offset].id if next_offset < len(found) else "the tracked-change and comment listings"
        lines.append(f"[... more: pass offset {next_offset} to read from {where}]")
    return {
        "text": "\n".join(lines),
        "details": {"paragraphs": len(found), "next_offset": next_offset, "changes": len(revisions), "comments": len(comments)},
    }


# --- anchoring to live spans ------------------------------------------------------------------


def span_at(document, located: Located):
    """The live paper-docx span for a located quote: same paragraph, same occurrence of the raw text."""
    text = located.text
    if not text:
        raise AnchorFailure("empty_quote", "the quote is empty after normalization")
    target = located.unit.element
    before = located.unit.text[: located.start]
    count, start = 0, before.find(text)
    while start != -1:
        count += 1
        start = before.find(text, start + len(text))
    spans = [s for s in find_text(document, text, story=BODY) if s._atoms and s._atoms[0].paragraph is target]
    if len(spans) > count:
        return spans[count]
    raise AnchorFailure(
        "unaddressable",
        f"the library can't edit {snippet(text, 80)!r} in {located.unit.id} (inside a field, content control or "
        "text box?): edit the plain text around it, or name it in the open decisions",
    )


SEPARATORS = {f"{W}tab": "tab", f"{W}br": "line break", f"{W}cr": "line break", f"{W}noBreakHyphen": "no-break hyphen"}
SEPARATOR_KINDS = set(SEPARATORS.values())
TEXT_NODES = {f"{W}rPr", f"{W}t", f"{W}delText"}


def split_text(text: str, kinds: list[str]) -> list[str]:
    """New text for each segment between separators.

    Cut at the separator's own character (a tab, a line break, a hyphen). When the new text uses a
    space instead, cut there only if it is the one space left, so no word moves across the mark.
    """
    exact = {"tab": "\t", "line break": "\n"}
    parts, rest = [], text
    for kind in kinds:
        if kind == "no-break hyphen":
            match = re.search(r"-|\u2011", rest)
        elif exact[kind] in rest:
            match = re.search(re.escape(exact[kind]), rest)
        else:
            spaces = list(re.finditer(r"\s+", rest))
            if len(spaces) > 1:
                raise AnchorFailure(
                    "crosses_marker",
                    f"the change crosses a {kind} and the new text doesn't show where it goes: "
                    f"keep the {kind} in the new text, or edit the text on each side of it separately",
                )
            match = spaces[0] if spaces else None
        if not match:
            raise AnchorFailure(
                "crosses_marker",
                f"the change crosses a {kind} and the new text has nothing to keep on its other side: "
                f"edit the text on each side of the {kind} separately",
            )
        parts.append(rest[: match.start()])
        rest = rest[match.end():]
    return parts + [rest]


def marker_offsets(element) -> list[tuple[int, str]]:
    """Current-text offsets of the markers between runs (bookmarks, proofing marks, comment ranges, fields), with their tag."""
    offsets: list[tuple[int, str]] = []
    position = 0

    def visit(parent) -> None:
        nonlocal position
        for node in parent:
            if node.tag == f"{W}r":
                for child in node:
                    if child.tag in SEPARATORS:
                        offsets.append((position, SEPARATORS[child.tag]))
                    elif child.tag not in TEXT_NODES:
                        # lastRenderedPageBreak, fldChar, sym and the like: positional, no text
                        offsets.append((position, child.tag.split("}")[-1]))
                    position += len(run_text([child])) if child.tag != f"{W}rPr" else 0
            elif node.tag in ADDED:
                # paper-docx does not match or edit across a tracked change's edge
                offsets.append((position, "tracked insertion"))
                visit(node)
                offsets.append((position, "tracked insertion"))
            elif node.tag in CONTAINERS:
                visit(node)
            elif node.tag in REMOVED:
                offsets.append((position, "tracked deletion"))
            elif node.tag == f"{W}pPr":
                continue
            else:
                offsets.append((position, node.tag.split("}")[-1]))

    visit(element)
    return offsets


def replace_range(document, located: Located, text: str, author: str, tracked: bool = True) -> None:
    """Tracked replace; a span across a bookmark or proofing mark is done in parts between the marks.

    The parts are struck right to left so the earlier offsets still hold, and the new text goes on
    the first part. The marks stay where they were.
    """
    try:
        span_at(document, located).replace(text, tracked=tracked, author=author if tracked else None)
        return
    except Exception as error:
        unaddressable = isinstance(error, AnchorFailure) and error.reason == "unaddressable"
        # A tab or break typed in the new text: fine when the quote crosses the same separator, which stays.
        typed_separator = isinstance(error, ValueError) and "control character" in str(error)
        if type(error).__name__ not in ("UnsupportedStructureError", "BoundaryViolationError") and not (unaddressable or typed_separator):
            raise
        markers = [
            (o, tag) for o, tag in marker_offsets(located.unit.element)
            if located.start < o < located.end or (tag in SEPARATOR_KINDS and located.start <= o < located.end)
        ]
        if not markers:
            raise
    # Segments between the marks. A separator (tab, break, no-break hyphen) is one character and
    # stays untouched; a positional marker has no width.
    separators = sorted((o, tag) for o, tag in markers if tag in SEPARATOR_KINDS)
    texts = split_text(text, [tag for _, tag in separators])
    pieces: list[tuple[int, int, str]] = []
    bounds = [located.start - 1] + [o for o, _ in separators] + [located.end]
    positional = sorted({o for o, tag in markers if tag not in SEPARATOR_KINDS})
    for index in range(len(bounds) - 1):
        seg_start, seg_end = bounds[index] + 1, bounds[index + 1]
        inner = [o for o in positional if seg_start < o < seg_end]
        edges = [seg_start, *inner, seg_end]
        for k in range(len(edges) - 1):
            pieces.append((edges[k], edges[k + 1], texts[index] if k == 0 else ""))
    try:
        for a, b, piece_text in reversed(pieces):
            if b <= a and not piece_text:
                continue
            piece = fresh(document, Located(located.unit, a, b, located.notes))
            if b <= a:
                insert_at(document, piece.unit, a, piece_text, author, tracked)
            elif piece_text or piece.text.strip():
                span_at(document, piece).replace(piece_text, tracked=tracked, author=author if tracked else None)
    except Exception as error:
        unit = located.unit
        raise AnchorFailure(
            "crosses_marker",
            f"the change crosses {', '.join(sorted({tag for _, tag in markers}))} in {unit.id} and the library refused the parts "
            f"({type(error).__name__}): edit each side separately",
            [{"paragraph": unit.id, "text": snippet(unit.text[a:b], 100)} for a, b, _ in pieces if b > a],
        ) from error


def insert_at(document, unit, k: int, text: str, author: str, tracked: bool = True, split: bool = True) -> None:
    """Tracked insertion of text at offset k of a paragraph's current text.

    paper-docx inserts by replacing an anchor with the anchor plus the text, and refuses when the
    alignment is ambiguous (the text starts or ends like its anchor). So try the word before, the
    word after, then both, until one is accepted.
    """
    current = unit.text
    before = current[:k]
    after = current[k:]
    prev_start = before.rstrip().rfind(" ") + 1 if before.strip() else k
    next_end = k + (len(after) - len(after.lstrip())) + len(after.lstrip().split(" ", 1)[0]) if after.strip() else k
    # An anchor never crosses a mark (a tracked change's edge, a bookmark, a layout hint).
    marks = [o for o, _ in marker_offsets(unit.element)]
    prev_start = max([prev_start, *[o for o in marks if o < k]])
    next_end = min([next_end, *[o for o in marks if o > k]])
    options = []
    # "at |twice |the" is the same insertion as "at| twice|the": anchoring on "at" without its space
    # gives an alignment paper-docx accepts when "at " -> "at twice " would be ambiguous.
    if text[-1:].isspace() and before[-1:].isspace() and prev_start < k - 1:
        rotated = before[-1] + text[:-1]
        options.append((prev_start, k - 1, lambda a: a + rotated))
    if prev_start < k:
        options.append((prev_start, k, lambda a: a + text))
    if next_end > k:
        options.append((k, next_end, lambda a: text + a))
    if prev_start < k and next_end > k:
        options.append((prev_start, next_end, lambda a: a[: k - prev_start] + text + a[k - prev_start:]))
    last = None
    for start, end, build in options:
        anchor = Located(unit, start, end)
        try:
            span_at(document, anchor).replace(build(anchor.text), tracked=tracked, author=author if tracked else None)
            return
        except Exception as error:  # refused before any change: try the next anchor
            if type(error).__name__ not in ("UnsupportedStructureError", "AmbiguousTargetError", "BoundaryViolationError"):
                raise
            last = error
            unit = fresh(document, Located(unit, start, end)).unit
    if split and len(text) > 1 and last is not None:
        # "Agreement." + " More text." is ambiguous because both end in ".": insert all but the
        # last character, then that character after it, each against a boundary that differs.
        for head, tail in ((text[:-1], text[-1:]), (text[:1], text[1:])):
            saved = snapshot(document)
            try:
                insert_at(document, unit, k, head, author, tracked, split=False)
                unit = fresh(document, Located(unit, k, k)).unit
                insert_at(document, unit, k + len(head), tail, author, tracked, split=False)
                return
            except Exception:
                restored = docx.Document(saved)
                document.element.replace(document.element.body, restored.element.body)
                if hasattr(document, "_Document__body"):
                    document._Document__body = None  # python-docx caches the body wrapper
                unit = fresh(document, Located(unit, k, k)).unit
    raise last or AnchorFailure("unaddressable", "no text beside the insertion point to anchor it")


def swap(document, located: Located, text: str, author: str):
    """A tracked replacement Word shows word by word: strike the old words, then insert the new ones.

    paper-docx aligns a replacement letter by letter ("[-thir-][+six+]ty"), which reads as noise in
    a redline, and refuses ambiguous alignments. So the old words are deleted and the new ones
    inserted beside them. If that is refused, the document is restored and the same minimal span
    is replaced in one step; the span is never widened.
    """
    if not text:
        replace_range(document, located, "", author)
        return document
    saved = snapshot(document)
    try:
        if located.text:
            replace_range(document, located, "", author)
        unit = fresh(document, Located(located.unit, located.start, located.start)).unit
        insert_at(document, unit, located.start, text, author)
        return document
    except Exception:
        # Never widen: retry the same minimal span as one replacement, or report why not.
        document = docx.Document(saved)
        if not located.text:
            raise
        replace_range(document, fresh(document, located), text, author)
        return document


def comment_at(document, located: Located, text: str, author: str, initials: str) -> None:
    """A comment on the located text, or on its longest part between marks when the whole can't be addressed."""
    try:
        span_at(document, located).comment(text, author=author, initials=initials)
        return
    except Exception as error:
        unaddressable = isinstance(error, AnchorFailure) and error.reason == "unaddressable"
        # A tab or break typed in the new text: fine when the quote crosses the same separator, which stays.
        typed_separator = isinstance(error, ValueError) and "control character" in str(error)
        if type(error).__name__ not in ("UnsupportedStructureError", "BoundaryViolationError") and not (unaddressable or typed_separator):
            raise
        failure = error
    cuts = sorted({o for o, _ in marker_offsets(located.unit.element) if located.start < o < located.end})
    bounds = [located.start, *cuts, located.end]
    pieces = sorted(((b - a, a, b) for a, b in zip(bounds, bounds[1:]) if located.unit.text[a:b].strip()), reverse=True)
    for _, a, b in pieces:
        try:
            span_at(document, Located(located.unit, a, b)).comment(text, author=author, initials=initials)
            return
        except Exception:
            continue
    raise failure


def fresh(document, located: Located) -> Located:
    """Re-locate after a comment or edit changed the element tree (the text offsets still hold)."""
    for unit in units(document):
        if unit.id == located.unit.id:
            return Located(unit, located.start, located.end, located.notes)
    raise AnchorFailure("paragraph_not_found", f"paragraph {located.unit.id} disappeared")


def snapshot(document) -> io.BytesIO:
    buffer = io.BytesIO()
    document.save(buffer)
    buffer.seek(0)
    return buffer


def failure(error: Exception) -> dict:
    if isinstance(error, AnchorFailure):
        return error.as_dict()
    return {"reason": "refused", "message": f"{type(error).__name__}: {error}"}


def change_summary(paragraph: str, old: str, new: str) -> str:
    return f"{paragraph}: {snippet(old, 70)!r} -> {snippet(new, 70)!r}"


# --- propose_edits ------------------------------------------------------------------------------


def same(a: str, b: str) -> bool:
    # Case-sensitive: capitalization can mark a defined term, so a case change is a real change.
    return fold(a)[0] == fold(b)[0]


def narrowed_change(located: Located, replacement: str) -> tuple[Located, str]:
    """narrowed(), refusing a replacement that differs from the text only in typography."""
    target, text = narrowed(located, replacement)
    if target.start == target.end and not text:
        raise AnchorFailure("no_change", "new differs from the quoted text only in punctuation or spacing, so there is nothing to change")
    return target, text


def narrowed(located: Located, replacement: str) -> tuple[Located, str]:
    """Only the words that change: an unchanged lead-in or tail keeps the document's own characters.

    Compared after folding, so retyping a curly quote as a straight one doesn't strike the quote.
    Cut at word boundaries, and a pure insertion keeps the word before it, so Word shows a clean
    change rather than a letter-level one.
    """
    old = located.text
    p = 0
    while p < len(old) and p < len(replacement) and same(old[p], replacement[p]):
        p += 1

    def mid_word(left: str, right_old: str, right_new: str) -> bool:
        return left.isalnum() and (right_old.isalnum() or right_new.isalnum())

    while p > 0 and mid_word(old[p - 1], old[p:p + 1], replacement[p:p + 1]):
        p -= 1
    s = 0
    while s < len(old) - p and s < len(replacement) - p and same(old[len(old) - 1 - s], replacement[len(replacement) - 1 - s]):
        s += 1
    while s > 0 and mid_word(old[len(old) - s], old[len(old) - s - 1:len(old) - s], replacement[len(replacement) - s - 1:len(replacement) - s]):
        s -= 1
    middle = Located(located.unit, located.start + p, located.end - s, located.notes)
    return middle, replacement[p: len(replacement) - s]


def apply_edit(document, edit: dict, author: str, initials: str) -> dict:
    op = edit.get("op")
    new = edit.get("new")
    if op not in ("replace", "delete", "insert_after"):
        raise AnchorFailure("invalid_edit", f"unknown op {op!r}")
    if op == "replace" and new is None:
        raise AnchorFailure("invalid_edit", "replace needs new (use op delete to strike)")
    if op == "insert_after" and not new:
        raise AnchorFailure("invalid_edit", "insert_after needs new text, with its leading space")
    if not (edit.get("rationale") or "").strip():
        raise AnchorFailure("invalid_edit", "every edit needs a rationale")
    located = locate(units(document), edit["quote"], edit.get("paragraph"), edit.get("near"), edit.get("occurrence"))
    old = located.text
    replacement = "" if op == "delete" else (old + new if op == "insert_after" else new)
    if replacement == old:
        raise AnchorFailure("no_change", "new is the same as the quoted text: to comment without a change, use the comment command")
    # The comment goes on first so it covers the struck and the new text however they align.
    comment_at(document, located, edit["rationale"], author, initials)
    located = fresh(document, located)
    target, text = narrowed_change(located, replacement)
    document = swap(document, target, text, author)
    result = {"status": "applied", "paragraph": located.unit.id, "change": change_summary(located.unit.id, old, replacement)}
    if located.notes:
        result["note"] = "; ".join(located.notes)
    return document, result


def write(source: str, document, output: str) -> None:
    patch_save(source, document, output)


def propose_edits(request: dict) -> dict:
    document = docx.Document(request["source"])
    author = request["author"]
    initials = initials_of(author)
    before = census(document)
    results = []
    for number, edit in enumerate(request["edits"]):
        saved = snapshot(document)
        try:
            document, result = apply_edit(document, edit, author, initials)
            results.append({"edit": number, **result})
        except Exception as error:  # rolled back; the batch goes on
            document = docx.Document(saved)
            results.append({"edit": number, "status": "failed", **failure(error)})
    write(request["source"], document, request["output"])
    return report(results, before, docx.Document(request["output"]), "edit")


def report(results: list[dict], before, after_document, noun: str) -> dict:
    after = census(after_document)
    applied = sum(1 for r in results if r["status"] == "applied")
    lines = [f"{applied} of {len(results)} {noun}(s) applied; saved."]
    for r in results:
        label = f"{noun} {r[noun]}" if noun in r else noun
        if r["status"] == "applied":
            line = f"{label}: applied {r.get('change', '')}".rstrip()
            if r.get("note"):
                line += f" ({r['note']})"
        else:
            line = f"{label}: FAILED {r['reason']}: {r['message']}"
            for candidate in r.get("candidates", []):
                line += f"\n    closest: [{candidate['paragraph']}] {candidate['text']}"
        lines.append(line)
    changed = [f"{key}: {before[key]} -> {after[key]}" for key in sorted(set(before) | set(after)) if before[key] != after[key]]
    if changed:
        lines.append("Counts: " + "; ".join(changed))
    if applied < len(results):
        retry = f"Resubmit only the failed {noun}(s), with path set to the saved file"
        if noun == "response":
            retry += f"; for an accept or reject, {RENUMBERED}"
        lines.append(retry + ".")
    return {"text": "\n".join(lines), "details": {"results": results, "applied": applied, "failed": len(results) - applied}}


# --- comment ------------------------------------------------------------------------------------


def thread_root(document, number: int):
    """Word shows one flat list under a thread, so every reply hangs off its first comment."""
    comment = document.comments.get(number)
    if comment is None:
        raise AnchorFailure("thread_not_found", f"there is no comment {number}: use a thread number from read")
    while (parent := parent_of(document, comment)) is not None:
        comment = document.comments.get(parent)
    return comment


def comment(request: dict) -> dict:
    document = docx.Document(request["source"])
    author = request["author"]
    before = census(document)
    try:
        if request.get("thread") is not None:
            reply(document, thread_root(document, int(request["thread"])), request["text"], author=author,
                  initials=initials_of(author))
            result = {"status": "applied", "change": f"reply on thread {request['thread']}"}
        else:
            if not request.get("quote"):
                raise AnchorFailure("invalid_comment", "pass quote (a new comment) or thread (a reply)")
            located = locate(units(document), request["quote"], request.get("paragraph"), request.get("near"),
                             request.get("occurrence"))
            comment_at(document, located, request["text"], author, initials_of(author))
            result = {"status": "applied", "paragraph": located.unit.id, "change": f"comment on {located.unit.id}: {snippet(located.text, 60)!r}"}
    except Exception as error:
        write(request["source"], docx.Document(request["source"]), request["output"])
        return {"text": f"comment: FAILED {failure(error)['reason']}: {failure(error)['message']}" + "".join(
            f"\n    closest: [{c['paragraph']}] {c['text']}" for c in failure(error).get("candidates", [])),
            "details": {"results": [{"status": "failed", **failure(error)}], "applied": 0, "failed": 1}}
    write(request["source"], document, request["output"])
    return report([result], before, docx.Document(request["output"]), "comment")


# --- respond ------------------------------------------------------------------------------------


def numbers(spec: str) -> list[int]:
    found: list[int] = []
    for part in str(spec).replace(" ", "").split(","):
        first, _, last = part.partition("-")
        start, end = int(first), int(last or first)
        if end < start:
            # A range like 2-0 selects nothing; reading it as empty would report success for changes left alone.
            raise ValueError(f"the range {part} ends before it starts")
        found += range(start, end + 1)
    return found


RENUMBERED = "change numbers shift once changes are resolved: take them from a fresh read of the saved file"


class Midway(Exception):
    """A validated response that still failed while resolving: the batch is redone without it."""

    def __init__(self, index: int, message: str):
        super().__init__(message)
        self.index = index


def resolve_selected(document, responses: list[dict], results: dict):
    """Accept and reject the selected changes by their numbers as read. Returns the document.

    Each response is all or nothing. Every number it selects is checked before anything changes, and a
    response that still fails midway is rolled back: the batch starts again from the file as read
    without it, so the other responses keep the numbering they were written against.
    """
    selected: dict[int, list[int]] = {}
    for index, response in enumerate(responses):
        if response["action"] not in ("accept", "reject"):
            continue
        try:
            selected[index] = numbers(response["changes"])
        except ValueError as error:
            why = f" ({error})" if "ends before it starts" in str(error) else ""
            results[index] = refused("invalid_changes", f"can't read change numbers {response['changes']!r}{why}")
    count = len(document.revisions)
    for index in list(selected):
        missing = [number for number in selected[index] if number >= count]
        if missing:
            results[index] = refused("change_not_found", "; ".join(f"there is no change {n}" for n in missing))
            del selected[index]
    unit_of = change_units(document)
    kinds: dict[int, set[str]] = defaultdict(set)
    for index, chosen in selected.items():
        for number in chosen:
            kinds[unit_of(number)].add(responses[index]["action"])
    for index in list(selected):
        both = [number for number in selected[index] if len(kinds[unit_of(number)]) > 1]
        if both:
            results[index] = refused("refused", "; ".join(f"change {n} is selected for both accept and reject" for n in both))
            del selected[index]
    saved = snapshot(document)
    while selected:
        try:
            resolve_all(document, responses, selected)
            break
        except Midway as error:
            results[error.index] = refused("refused", str(error))
            del selected[error.index]
            saved.seek(0)
            document = docx.Document(saved)
    for index in selected:
        results[index] = {"status": "applied", "change": f"{responses[index]['action']}ed change(s) {responses[index]['changes']}"}
    return document


def refused(reason: str, message: str) -> dict:
    return {"status": "failed", "reason": reason, "message": f"{message}. None of this response was applied; {RENUMBERED}"}


def change_units(document):
    """Change number -> the change it resolves with: both sites of a move are one."""
    changes = list(document.revisions)
    moves = {id(element): unit for unit in _move_units(document)[0] for element in unit.elements}

    def unit_of(number: int) -> int:
        element = changes[number]._element
        return id(moves.get(id(element), element))

    return unit_of


def resolve_all(document, responses: list[dict], selected: dict[int, list[int]]) -> None:
    """Resolve each selected change once, last first, finding it by its element and not its number."""
    changes = list(document.revisions)
    unit_of = change_units(document)
    wanted: dict[int, int] = {}
    for index, chosen in selected.items():
        for number in chosen:
            wanted.setdefault(number, index)
    done: set[int] = set()
    for number in sorted(wanted, reverse=True):
        index = wanted[number]
        unit = unit_of(number)
        if unit in done:
            continue
        element = changes[number]._element
        revision = next((r for r in document.revisions if r._element is element), None)
        if revision is None:
            raise Midway(index, f"change {number} went with another selected change")
        try:
            getattr(revision, responses[index]["action"])()
        except Exception as error:
            raise Midway(index, f"change {number}: {error}") from error
        done.add(unit)


def counter(document, response: dict, author: str, initials: str) -> dict:
    located = locate(units(document), response["quote"], response.get("paragraph"), response.get("near"),
                     response.get("occurrence"))
    old = located.text
    if response.get("thread") is not None:
        thread_root(document, int(response["thread"]))  # refuse an unknown thread before editing
        target, text = narrowed_change(located, response["new"])
        document = swap(document, target, text, author)
        reply(document, thread_root(document, int(response["thread"])), response["rationale"], author=author, initials=initials)
    else:
        comment_at(document, located, response["rationale"], author, initials)
        located = fresh(document, located)
        target, text = narrowed_change(located, response["new"])
        document = swap(document, target, text, author)
    return document, {"status": "applied", "paragraph": located.unit.id, "change": change_summary(located.unit.id, old, response["new"])}


def respond(request: dict) -> dict:
    document = docx.Document(request["source"])
    author = request["author"]
    initials = initials_of(author)
    responses = request["responses"]
    before = census(document)
    results: dict[int, dict] = {}
    document = resolve_selected(document, responses, results)
    for index, response in enumerate(responses):
        if response["action"] in ("accept", "reject"):
            continue
        saved = snapshot(document)
        try:
            if response["action"] == "counter":
                document, results[index] = counter(document, response, author, initials)
            elif response["action"] == "reply":
                reply(document, thread_root(document, int(response["thread"])), response["text"], author=author, initials=initials)
                results[index] = {"status": "applied", "change": f"reply on thread {response['thread']}"}
            else:
                raise AnchorFailure("invalid_response", f"unknown action {response['action']!r}")
        except Exception as error:
            document = docx.Document(saved)
            results[index] = {"status": "failed", **failure(error)}
    write(request["source"], document, request["output"])
    ordered = [{"response": index, **results[index]} for index in range(len(responses))]
    return report(ordered, before, docx.Document(request["output"]), "response")


# --- remove_section -------------------------------------------------------------------------------


def remove_section(request: dict) -> dict:
    document = docx.Document(request["source"])
    author = request["author"]
    initials = initials_of(author)
    before = census(document)
    result: dict
    try:
        found = units(document)
        ids = [u.id for u in found]
        for key in ("from", "through"):
            if request[key] not in ids:
                raise AnchorFailure("paragraph_not_found", f"there is no paragraph {request[key]}: use an id from read")
        first, last = ids.index(request["from"]), ids.index(request["through"])
        if first > last:
            raise AnchorFailure("invalid_range", "from comes after through")
        targets = [u.id for u in found[first: last + 1] if u.text.strip()]
        if not targets:
            raise AnchorFailure("invalid_range", "the range has no text")
        head = next(u for u in found if u.id == targets[0])
        keep_end = 0
        if request.get("keep"):
            kept = locate([head], request["keep"])
            if head.text[: kept.start].strip():
                raise AnchorFailure("keep_not_at_start", f"keep must be the start of {head.id}'s text")
            keep_end = kept.end
        body_start = keep_end + (len(head.text[keep_end:]) - len(head.text[keep_end:].lstrip()))
        whole = Located(head, len(head.text) - len(head.text.lstrip()), len(head.text.rstrip()))
        comment_at(document, whole, request["rationale"], author, initials)
        struck = 0
        for pid in reversed(targets):
            unit = next(u for u in units(document) if u.id == pid)
            if pid == head.id:
                body = Located(unit, body_start, len(unit.text.rstrip()))
                if body.start >= body.end:
                    raise AnchorFailure("invalid_range", "nothing after keep to replace with Reserved.")
                replace_range(document, body, "Reserved.", author)
            else:
                replace_range(document, Located(unit, len(unit.text) - len(unit.text.lstrip()), len(unit.text.rstrip())), "", author)
            struck += 1
        result = {"status": "applied", "paragraph": head.id,
                  "change": f"{head.id}..{targets[-1]}: {struck} paragraph(s) struck, 'Reserved.' in {head.id}"}
    except Exception as error:
        document = docx.Document(request["source"])
        result = {"status": "failed", **failure(error)}
        write(request["source"], document, request["output"])
        return report([result], before, document, "remove_section")
    write(request["source"], document, request["output"])
    return report([result], before, docx.Document(request["output"]), "remove_section")


# --- revise ---------------------------------------------------------------------------------------

MERGE_GAP = 12
TOKEN = re.compile(r"\s+|\w+|[^\w\s]")


def word_changes(old: str, new: str) -> list[tuple[int, int, int, int]]:
    """Changed (old_start, old_end, new_start, new_end) character ranges, word by word, compared after folding."""
    from difflib import SequenceMatcher

    def tokens(text):
        return [(m.start(), m.end(), fold(m.group())[0] or " ") for m in TOKEN.finditer(text)]

    a, b = tokens(old), tokens(new)
    changes = []
    matcher = SequenceMatcher(None, [t[2] for t in a], [t[2] for t in b], autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        o1 = a[i1][0] if i1 < len(a) else len(old)
        o2 = a[i2 - 1][1] if i2 > i1 else o1
        n1 = b[j1][0] if j1 < len(b) else len(new)
        n2 = b[j2 - 1][1] if j2 > j1 else n1
        changes.append((o1, o2, n1, n2))
    # Changes a word or two apart read better, and cost far fewer library operations, as one.
    merged: list[tuple[int, int, int, int]] = []
    for change in changes:
        if merged and change[0] - merged[-1][1] <= MERGE_GAP and old[merged[-1][1]:change[0]] == new[merged[-1][3]:change[2]]:
            merged[-1] = (merged[-1][0], change[1], merged[-1][2], change[3])
        else:
            merged.append(change)
    return merged


def apply_changes(document, unit_id: str, new: str, author: str, tracked: bool):
    """Apply one paragraph's word changes, right to left so earlier offsets hold. Returns the document."""
    unit = next(u for u in units(document) if u.id == unit_id)
    for o1, o2, n1, n2 in reversed(word_changes(unit.text, new)):
        unit = fresh(document, Located(unit, o1, o2)).unit
        text = new[n1:n2]
        if o2 > o1:
            if tracked:
                document = swap(document, Located(unit, o1, o2), text, author)
            else:
                replace_range(document, Located(unit, o1, o2), text, author, tracked=False)
        elif text:
            insert_at(document, unit, o1, text, author, tracked)
    return document


def comment_changes(document, unit_id: str, new: str, old: str, rationale: str, author: str, initials: str) -> None:
    """Anchor the rationale on the paragraph's changed text, first change to last."""
    unit = next(u for u in units(document) if u.id == unit_id)
    changes = word_changes(old, new)
    start, end = changes[0][2], changes[-1][3]
    if end <= start:  # only deletions: anchor on the word before them, else the word after
        before = unit.text[:start].rstrip()
        start = before.rfind(" ") + 1 if before else start
        end = len(before) if before else start + len(unit.text[start:].split(" ", 1)[0])
    while start < end and unit.text[start].isspace():
        start += 1
    end = len(unit.text[:end].rstrip())
    comment_at(document, Located(unit, start, max(end, start + 1)), rationale, author, initials)


def revise(request: dict) -> dict:
    """Paragraph-level revisions with no quoting: the agent gives each paragraph's revised text.

    On a file with no pending changes, the edits are made untracked on a working copy and paper-docx's
    compare() builds the redline (word granularity, proven to accept and reject cleanly). A paragraph
    compare refuses, and every paragraph of a file that already carries changes, is applied as
    targeted tracked edits instead, and the result says which.
    """
    from docx.package import compare

    source = request["source"]
    author = request["author"]
    initials = initials_of(author)
    document = docx.Document(source)
    before = census(document)
    found = {u.id: u for u in units(document)}
    results: list[dict] = []
    todo: list[tuple[int, dict, str]] = []
    comment_only: list[tuple[int, dict, str]] = []
    for number, item in enumerate(request["revisions"]):
        unit = found.get(item.get("paragraph"))
        if unit is None:
            results.append({"revision": number, "status": "failed", "reason": "paragraph_not_found",
                            "message": f"there is no paragraph {item.get('paragraph')}: use an id from read"})
            continue
        if not (item.get("rationale") or "").strip():
            results.append({"revision": number, "status": "failed", "reason": "invalid_revision", "message": "every revision needs a rationale"})
            continue
        if not word_changes(unit.text, item["text"]):
            comment_only.append((number, item, unit.text))  # unchanged text: a comment on the paragraph
            continue
        if any(other[1]["paragraph"] == item["paragraph"] for other in todo):
            results.append({"revision": number, "status": "failed", "reason": "duplicate_paragraph",
                            "message": f"{item['paragraph']} is revised twice in this batch: give its whole revised text once"})
            continue
        todo.append((number, item, unit.text))

    def working_copy(items):
        working = docx.Document(source)
        for _, item, _ in items:
            working = apply_changes(working, item["paragraph"], item["text"], author, tracked=False)
        buffer = io.BytesIO()
        working.save(buffer)
        return buffer.getvalue()

    compared, tracked_items, notes = [], [], {}
    result = None
    if todo and not list(document.revisions):
        candidates = list(todo)
        result = None
        try:
            result = compare(source, working_copy(candidates), author=author, granularity="word")
            shape = [child.tag for child in document.element.body]
            if [child.tag for child in result.document.element.body] != shape:
                # Paragraph ids are block positions: a redline that adds or removes blocks would
                # move every id after it, so it is not used.
                raise ValueError("compare changed the paragraph structure")
            compared = candidates
        except Exception as error:
            result = None
            # One compare per batch: isolating the refused clause costs a compare per paragraph
            # (seconds each on a long contract), so the whole batch takes the tracked path instead.
            reason = f"compare refused the batch ({type(error).__name__}: {str(error)[:100]}); applied as tracked edits"
            for entry in candidates:
                tracked_items.append(entry)
                notes[entry[0]] = reason
        if result is not None:
            document = result.document
    else:
        tracked_items = list(todo)
        if todo:
            for entry in todo:
                notes[entry[0]] = "the file already has tracked changes; applied as tracked edits"

    applied: dict[int, dict] = {}
    for number, item, old in compared:
        applied[number] = {"revision": number, "status": "applied", "paragraph": item["paragraph"], "via": "compare"}
    for number, item, old in sorted(tracked_items):
        saved = snapshot(document)
        try:
            document = apply_changes(document, item["paragraph"], item["text"], author, tracked=True)
            applied[number] = {"revision": number, "status": "applied", "paragraph": item["paragraph"], "via": "tracked"}
        except Exception as error:
            document = docx.Document(saved)
            applied[number] = {"revision": number, "status": "failed", **failure(error)}
    for number, item, old in todo:
        entry = applied[number]
        if entry["status"] != "applied":
            continue
        try:
            comment_changes(document, item["paragraph"], item["text"], old, item["rationale"], author, initials)
        except Exception as error:
            entry["note"] = f"the change went in but its comment could not be anchored ({type(error).__name__})"
        changes = word_changes(old, item["text"])
        o1, o2, n1, n2 = changes[0]
        entry["change"] = change_summary(item["paragraph"], old[o1:o2], item["text"][n1:n2]) + (
            f" (+{len(changes) - 1} more)" if len(changes) > 1 else "")
        if number in notes:
            entry["note"] = "; ".join(filter(None, [entry.get("note"), notes[number]]))
    for number, item, old in comment_only:
        try:
            unit = next(u for u in units(document) if u.id == item["paragraph"])
            text = unit.text
            comment_at(document, Located(unit, len(text) - len(text.lstrip()), len(text.rstrip())), item["rationale"], author, initials)
            applied[number] = {"revision": number, "status": "applied", "paragraph": item["paragraph"], "via": "comment",
                               "change": f"comment on {item['paragraph']} (text unchanged)"}
        except Exception as error:
            applied[number] = {"revision": number, "status": "failed", **failure(error)}
    results += list(applied.values())
    results.sort(key=lambda r: r["revision"])
    write(source, document, request["output"])
    return report(results, before, docx.Document(request["output"]), "revision")


COMMANDS = {
    "revise": revise,
    "read": read,
    "propose_edits": propose_edits,
    "comment": comment,
    "respond": respond,
    "remove_section": remove_section,
}
