"""The Word document as the `documents` tool shows it: paragraphs with stable ids and their current text.

Paragraph ids are body-block positions: `p-012` is the 13th block of the body, and a paragraph in a
table cell is `p-012.r2c3` (`.2` after it for the cell's second paragraph, a nested table's included). A block-level content
control is one block: its paragraphs are `p-012`, `p-012.2`, `p-012.3` and so on. Edits never add or remove
blocks, so the ids hold for the whole redline.

The inline markup walk and the margin, change and thread listings are from recipe-redlining's
lib/view_docx.py and skills/reading-a-redline/read_markup.py (Apache-2.0, Introspection).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from itertools import groupby

from docx.commentops import comment_thread
from docx.numbering import list_numbering

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
ADDED = {f"{W}ins": "+", f"{W}moveTo": "+"}
REMOVED = {f"{W}del": "-", f"{W}moveFrom": "-"}
CONTAINERS = (f"{W}hyperlink", f"{W}smartTag", f"{W}sdt", f"{W}sdtContent", f"{W}fldSimple", f"{W}customXml")
BODY = "word/document.xml"


@dataclass
class Unit:
    """One paragraph: its id, the live element, Word's list label and the text a quote matches."""

    id: str
    element: object
    text: str
    style: str = ""
    label: str = ""
    marked: bool = False
    extras: dict = field(default_factory=dict)


def signed(author, date) -> str:
    return f"{author or 'unknown author'}, {str(date or 'no date')[:10]}"


def run_text(run) -> str:
    parts = []
    for node in run:
        if node.tag in (f"{W}t", f"{W}delText"):
            parts.append(node.text or "")
        elif node.tag == f"{W}tab":
            parts.append("\t")
        elif node.tag in (f"{W}br", f"{W}cr"):
            parts.append("\n")
        elif node.tag == f"{W}noBreakHyphen":
            parts.append("-")
    return "".join(parts)


def current_text(element) -> str:
    """The paragraph as it reads with every tracked change accepted: what a quote is matched against."""
    parts = []
    for node in element:
        if node.tag == f"{W}r":
            parts.append(run_text(node))
        elif node.tag in ADDED or node.tag in CONTAINERS:
            parts.append(current_text(node))
    return "".join(parts)


INLINE_COMMENT = 60


def walk(element, comments: dict, seen: set) -> str:
    """Read only: the order of runs, changes and comment ranges in a paragraph."""
    parts = []
    for node in element:
        if node.tag == f"{W}r":
            parts.append(run_text(node))
        elif node.tag in ADDED or node.tag in REMOVED:
            mark = ADDED.get(node.tag) or REMOVED[node.tag]
            who = signed(node.get(f"{W}author"), node.get(f"{W}date"))
            parts.append(f"[{mark}{walk(node, comments, seen)}{mark}]({who})")
        elif node.tag == f"{W}commentRangeStart":
            parts.append("«")
        elif node.tag == f"{W}commentRangeEnd":
            number = int(node.get(f"{W}id"))
            seen.add(number)
            comment = comments.get(number)
            who = signed(comment.author, comment.timestamp) if comment else "unknown author"
            body = " ".join((comment.text if comment else "").split())
            # The full text is in the thread listing, which pages; inline keeps a paragraph's line bounded.
            if len(body) > INLINE_COMMENT:
                body = body[:INLINE_COMMENT].rstrip() + "… (see its thread)"
            parts.append(f"»[comment {number}, {who}: {body}]")
        elif node.tag in CONTAINERS:
            parts.append(walk(node, comments, seen))
    return "".join(parts)


def has_markup(element) -> bool:
    for tag in (*ADDED, *REMOVED, f"{W}commentRangeStart", f"{W}commentReference"):
        if next(element.iter(tag), None) is not None:
            return True
    return False


ROMAN = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]


def formatted(number: int, fmt: str | None) -> str:
    if fmt in ("lowerLetter", "upperLetter"):
        letters = ""
        n = number
        while n > 0:
            n, rest = divmod(n - 1, 26)
            letters = chr(97 + rest) + letters
        return letters.upper() if fmt == "upperLetter" else letters
    if fmt in ("lowerRoman", "upperRoman"):
        out, n = "", number
        for value, digits in ROMAN:
            while n >= value:
                out, n = out + digits, n - value
        return out.upper() if fmt == "upperRoman" else out
    if fmt in ("bullet", "none"):
        return ""
    return str(number)


def list_labels(document) -> dict[tuple, str]:
    """Approximate list numbers ("1.2.") by block position. Restarts and overrides are not modelled."""
    try:
        report = list_numbering(document)
    except Exception:  # an unreadable numbering part only costs the labels
        return {}
    definitions = {d.num_id: d for d in report.definitions}
    counters: dict[int, list[int]] = {}
    labels: dict[tuple, str] = {}
    for paragraph in report.numbered_paragraphs:
        if paragraph.story != BODY:
            continue
        definition = definitions.get(paragraph.num_id)
        if definition is None:
            continue
        levels = {level.level: level for level in definition.levels}
        level = levels.get(paragraph.level)
        if level is None or level.num_fmt in ("bullet", "none"):
            continue
        counts = counters.setdefault(definition.abstract_num_id, [0] * 9)
        counts[paragraph.level] += 1
        for deeper in range(paragraph.level + 1, 9):
            counts[deeper] = 0
        text = level.lvl_text or ""
        for n in range(1, 10):
            source = levels.get(n - 1)
            value = counts[n - 1] or 1
            text = text.replace(f"%{n}", formatted(value, source.num_fmt if source else "decimal"))
        key = (paragraph.index, paragraph.table_cell) if paragraph.table_cell else (paragraph.index,)
        labels[key] = text.strip()
    return labels


def units(document, labels: bool = False) -> list[Unit]:
    """Every body paragraph, table cells included, in reading order. List labels only for read: they cost a numbering walk."""
    labels = list_labels(document) if labels else {}
    out: list[Unit] = []
    body = document.element.body
    index = -1
    for block in body.iterchildren():
        if block.tag == f"{W}p":
            index += 1
            style = style_name(document, block)
            out.append(Unit(f"p-{index:03d}", block, current_text(block), style, labels.get((index,), ""), has_markup(block)))
        elif block.tag == f"{W}tbl":
            index += 1
            # Only this table's own rows and cells: a table nested in a cell is part of that cell, and its
            # paragraphs follow the cell's own as `.2`, `.3` ..., each visited once.
            for r, row in enumerate(direct(block, f"{W}tr"), 1):
                for c, cell in enumerate(direct(row, f"{W}tc"), 1):
                    for k, p in enumerate(cell.iter(f"{W}p"), 1):
                        suffix = f".{k}" if k > 1 else ""
                        out.append(Unit(f"p-{index:03d}.r{r}c{c}{suffix}", p, current_text(p), "", "", has_markup(p)))
        elif block.tag == f"{W}sdt":
            index += 1
            # A block-level content control can hold several paragraphs: each gets the control's id,
            # with `.2`, `.3` ... after it for the second and later, as in a table cell.
            for k, p in enumerate(block.iter(f"{W}p"), 1):
                suffix = f".{k}" if k > 1 else ""
                out.append(Unit(f"p-{index:03d}{suffix}", p, current_text(p), style_name(document, p), "", has_markup(p)))
    return out


def direct(parent, tag: str):
    """`parent`'s own `tag` children, through any content control or custom XML wrapping them, not deeper."""
    for child in parent.iterchildren():
        if child.tag == tag:
            yield child
        elif child.tag in (f"{W}sdt", f"{W}sdtContent", f"{W}customXml"):
            yield from direct(child, tag)


def style_name(document, element) -> str:
    p_pr = element.find(f"{W}pPr")
    style = p_pr.find(f"{W}pStyle") if p_pr is not None else None
    if style is None:
        return ""
    style_id = style.get(f"{W}val")
    try:
        return document.styles.get_by_id(style_id, 1).name or style_id  # WD_STYLE_TYPE.PARAGRAPH
    except Exception:
        return style_id or ""


def margin_lines(document, kind: str) -> list[str]:
    even_pages = document.settings.odd_and_even_pages_header_footer
    lines = []
    shown = set()
    for number, section in enumerate(document.sections, 1):
        where = f", section {number}" if number > 1 else ""
        variants = [("", getattr(section, kind))]
        if section.different_first_page_header_footer:
            variants.append(("first-page ", getattr(section, f"first_page_{kind}")))
        if even_pages:
            variants.append(("even-page ", getattr(section, f"even_page_{kind}")))
        for variant, margin in variants:
            if margin.part.partname not in shown:
                shown.add(margin.part.partname)
                lines += [f"[{variant}{kind}{where}] {p.text}" for p in margin.paragraphs if p.text.strip()]
    return lines


def day(value) -> str:
    return str(value or "no date")[:10]


def change_lines(document) -> list[str]:
    """Word splits one edit into many revisions, so neighbours of one kind and author read as one."""

    def key(item):
        _, r = item
        return r.revision_type, r.author, r.story, r.anchor.index, r.is_paragraph_mark

    lines = []
    for (kind, author, story, _, mark), group in groupby(enumerate(document.revisions), key):
        group = list(group)
        first, last = group[0][0], group[-1][0]
        number = str(first) if first == last else f"{first}-{last}"
        text = "(paragraph mark)" if mark else "".join(r.text for _, r in group)
        where = "" if story == BODY else f" in {story}"
        lines.append(f"{number} {kind}{where}, {author}, {day(group[0][1].date)}: {text}")
    return lines


def thread_lines(document) -> list[str]:
    comments = comment_thread(document)
    parents = {c["comment_id"]: c["parent_id"] for c in comments}

    def root(number):
        while parents.get(number) is not None:
            number = parents[number]
        return number

    lines = []
    for comment in comments:
        if comment["parent_id"] is None:
            state = "resolved" if comment["resolved"] else "open"
            anchor = " ".join((comment.get("anchored_text") or "").split())[:120]
            lines.append(f"thread {comment['comment_id']} ({state}) on: {anchor}")
            for entry in comments:
                if root(entry["comment_id"]) == comment["comment_id"]:
                    found = document.comments.get(entry["comment_id"])
                    when = day(found.timestamp if found is not None else None)
                    lines.append(f"  {entry['comment_id']}, {entry['author']}, {when}: {entry['text'].strip()}")
    return lines


def census(document) -> Counter:
    counts = Counter(f"{r.author}: {r.revision_type}" for r in document.revisions)
    counts.update(f"{c['author']}: comment" for c in comment_thread(document))
    return counts
