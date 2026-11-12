"""PDF helper for the Recipes `documents` tool: read (text, optional tables, form values, comments), render,
and export (the outline `convert` builds a Word file from).

python -I pdf.py < request.json   ->   {"text": ..., "details": ...} or {"error": ...}

Text and page images come from pypdfium2. Table cells come from pdfplumber, an
optional extra (`tables`): it is imported only when a read asks for tables, and
a read without it returns the text and says the extra is missing. Nothing is
fetched at run time.
"""

import ctypes
import json
import os
import re
import statistics
import sys
import time
from dataclasses import dataclass, field, replace

STARTED = time.perf_counter()

MAX_IMAGES = 10
SIDE = 1568
TEXT_BUDGET = 50_000
TABLES_MISSING = (
    "Tables were requested, but table extraction needs the PDF adapter's `tables` extra (pdfplumber), "
    "which this Recipe's Python does not have: the text above is all there is. "
    "Add pdfplumber to the Recipe's python environment to get table cells."
)

# Annotations that are not comments: links, form widgets and the popups that hold a comment's window.
NOT_COMMENTS = {"link": 2, "popup": 16, "widget": 20}


def page_numbers(spec, total: int) -> list[int]:
    if not spec:
        return list(range(1, total + 1))
    numbers: list[int] = []
    for part in str(spec).replace(" ", "").split(","):
        first, _, last = part.partition("-")
        numbers += [n for n in range(max(int(first), 1), min(int(last or first), total) + 1) if n not in numbers]
    return numbers


def open_document(path: str):
    import pypdfium2

    try:
        return pypdfium2.PdfDocument(path)
    except pypdfium2.PdfiumError as error:
        if "password" in str(error).lower():
            raise ValueError("This PDF is password-protected: ask the person for an unlocked copy.") from None
        raise


def utf16(call, *args) -> str:
    """Read one of pdfium's UTF-16LE string out-parameters: ask for the size, then fill a buffer."""
    size = call(*args, None, 0)
    if size <= 2:
        return ""
    buffer = ctypes.create_string_buffer(size)
    call(*args, ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ushort)), size)
    return buffer.raw[: size - 2].decode("utf-16-le", errors="replace").strip()


def page_text(page) -> str:
    """The page's text in pdfium's reading order."""
    textpage = page.get_textpage()
    try:
        return textpage.get_text_range().replace("\r\n", "\n").replace("\r", "\n").strip()
    finally:
        textpage.close()


def comments_and_fields(document, numbers: list[int]) -> tuple[list[str], list[str]]:
    import pypdfium2.raw as raw

    comments, fields = [], []
    form = document.formenv.raw if document.formenv else None
    for number in numbers:
        page = document[number - 1]
        for index in range(raw.FPDFPage_GetAnnotCount(page.raw)):
            annot = raw.FPDFPage_GetAnnot(page.raw, index)
            try:
                subtype = raw.FPDFAnnot_GetSubtype(annot)
                if subtype == NOT_COMMENTS["widget"] and form:
                    name = utf16(raw.FPDFAnnot_GetFormFieldName, form, annot)
                    value = utf16(raw.FPDFAnnot_GetFormFieldValue, form, annot)
                    if name and value and value != "Off":
                        fields.append(f"{name}: {value}")
                elif subtype not in NOT_COMMENTS.values():
                    body = utf16(raw.FPDFAnnot_GetStringValue, annot, b"Contents")
                    if body:
                        author = utf16(raw.FPDFAnnot_GetStringValue, annot, b"T") or "unknown author"
                        comments.append(f"page {number}, {author}: {body}")
            finally:
                raw.FPDFPage_CloseAnnot(annot)
    return comments, list(dict.fromkeys(fields))


def tables_from(path: str, numbers: list[int]) -> list[str] | None:
    """Each table as pipe-separated rows, or None when the `tables` extra is not installed."""
    try:
        import pdfplumber
    except ModuleNotFoundError:
        return None
    out = []
    with pdfplumber.open(path) as document:
        for number in numbers:
            for index, table in enumerate(document.pages[number - 1].extract_tables(), 1):
                rows = ["| " + " | ".join(" ".join(str(cell or "").split()) for cell in row) + " |" for row in table]
                out.append(f"--- page {number}, table {index} ({len(table)} rows)\n" + "\n".join(rows))
    return out


def read(request: dict) -> dict:
    path = request["path"]
    document = open_document(path)
    document.init_forms()
    total = len(document)
    numbers = page_numbers(request.get("pages"), total)
    lines, scanned = [f"{total} page(s)."], []
    for number in numbers:
        text = page_text(document[number - 1])
        if text:
            lines.append(f"--- page {number}\n{text}")
        else:
            scanned.append(number)
    comments, fields = comments_and_fields(document, numbers)
    if fields:
        lines.append("--- form fields (filled in)\n" + "\n".join(fields))
    if comments:
        lines.append("--- comments on the pages\n" + "\n".join(comments))

    paths, notes, tables = [], [], []
    texted = [n for n in numbers if n not in scanned]
    if texted:
        paths.append("text")
    if request.get("tables") and texted:
        found = tables_from(path, texted)
        if found is None:
            notes.append(TABLES_MISSING)
        else:
            paths.append("tables")
            tables = found
            lines.append("\n".join(found) if found else "--- tables\nNo tables found on these pages.")
    if scanned:
        paths.append("page images (no text layer)")
        listed = ",".join(map(str, scanned))
        notes.append(
            f"No text layer on page(s) {listed} (a scan): render them with documents render "
            f'(pages "{listed}") and open each PNG it returns with the read tool.'
        )

    text = "\n".join(lines)
    offset = max(int(request.get("offset") or 0), 0)
    budget = int(request.get("budget") or TEXT_BUDGET)
    if offset and offset >= len(text):
        raise ValueError(f"offset {offset:,} is past the end: the text is {len(text):,} characters")
    end = min(offset + budget, len(text))
    part = text[offset:end]
    if end < len(text):
        part += f"\n[... {len(text) - end:,} more characters: pass offset {end}]"
    header = f"Path: {', '.join(paths)}."
    return {
        "text": "\n".join([header, part, *notes]),
        "details": {
            "pages": total,
            "path": paths,
            "scanned": scanned,
            "tables": len(tables),
            "tables_extra": "missing" if TABLES_MISSING in notes else ("used" if "tables" in paths else "not requested"),
        },
    }


def render(request: dict) -> dict:
    path = request["path"]
    directory = request.get("outputDir")
    if not directory:
        raise ValueError("render needs an output directory from the host")
    os.makedirs(directory, exist_ok=True)
    document = open_document(path)
    # Filled form fields and checkboxes are drawn only once the form environment exists.
    document.init_forms()
    total = len(document)
    numbers = page_numbers(request.get("pages"), total)
    stem = os.path.splitext(os.path.basename(path))[0]
    written = []
    for number in numbers[:MAX_IMAGES]:
        page = document[number - 1]
        target = os.path.join(directory, f"{stem}-page-{number}.png")
        page.render(scale=SIDE / max(page.get_size())).to_pil().save(target, format="PNG")
        written.append(target)
    note = f" Only the first {MAX_IMAGES} were rendered: pass pages for the others." if len(numbers) > MAX_IMAGES else ""
    listing = "\n".join(f"page {number}: {target}" for number, target in zip(numbers, written))
    return {
        "text": f"Path: page images. Rendered {len(written)} of {total} page(s) to PNG; open each with the read tool.{note}\n{listing}",
        "details": {"pages": total, "path": ["page images"], "images": written},
    }


# A line that opens with one of these starts a paragraph: 1. 1.2 (a) a) iv. A. and bullets.
ENUMERATOR = re.compile(
    r"^(?:[•●○◦▪■·\-–]\s"
    r"|\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]\s"
    r"|\d{1,3}(?:\.\d{1,3})+\.?\s)"
)
PAGE_NUMBER = re.compile(r"^(?:page\s*)?#(?:\s*(?:of|/)\s*#)?$")
BOLD_NAMES = ("bold", "black", "heavy", "semibold", "demi")
# A gap this many characters wide splits a line into columns (a borderless table, a signature block).
COLUMN_GAP = 3
# The share of the page at the top and bottom where running headers and footers sit.
FURNITURE = 0.1


# PDF font descriptor flags: Italic and ForceBold.
ITALIC_FLAG, BOLD_FLAG = 1 << 6, 1 << 18
ITALIC_NAMES = ("italic", "oblique")
# The standard 14 fonts by the names Word knows them by.
STANDARD_FAMILIES = {"helvetica": "Arial", "times": "Times New Roman", "courier": "Courier New"}


@dataclass(frozen=True)
class Style:
    """How a run of text is set: what `convert` carries into the Word file."""

    family: str
    size: float
    bold: bool
    italic: bool
    color: str  # "#rrggbb"
    underline: bool = False


@dataclass
class Char:
    text: str
    left: float
    bottom: float
    right: float
    top: float
    style: Style
    soft_hyphen: bool = False


@dataclass
class Line:
    page: int
    text: str
    x0: float
    x1: float
    top: float
    size: float
    bold: float
    soft_hyphen: bool
    centered: bool
    segments: list[tuple[float, str]] = field(default_factory=list)
    runs: list[tuple[str, Style]] = field(default_factory=list)
    # Where the text after a leading clause number or bullet starts, when a tab rather than a space set it there.
    tab_x: float | None = None
    # The width of the line's first word: whether it would have fit at the end of the line above.
    first_word: float = 0.0


def family_of(name: str) -> str:
    """A PDF base font name as the family Word knows: `ABCDEF+Arial-BoldMT` is Arial, `TimesNewRomanPSMT` Times New Roman."""
    base = name.split("+", 1)[-1].split(",", 1)[0].split("-", 1)[0]
    base = re.sub(r"(PSMT|MT|PS)$", "", base)
    if base.lower() in STANDARD_FAMILIES:
        return STANDARD_FAMILIES[base.lower()]
    if base.lower().startswith("times"):
        return "Times New Roman"
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base).strip()
    return spaced or "Arial"


def char_style(textpage, index: int, buffer, cache: dict) -> Style:
    import pypdfium2.raw as raw

    flags = ctypes.c_int()
    raw.FPDFText_GetFontInfo(textpage.raw, index, buffer, len(buffer), flags)
    name = buffer.value.decode("latin-1")
    lower = name.lower()
    matrix = raw.FS_MATRIX()
    raw.FPDFText_GetMatrix(textpage.raw, index, matrix)
    # The size as set: pdfium's font size is before the text matrix and the page's scale.
    scale = abs(matrix.a * matrix.d - matrix.b * matrix.c) ** 0.5 or 1.0
    size = round(raw.FPDFText_GetFontSize(textpage.raw, index) * scale * 2) / 2
    rgba = [ctypes.c_uint() for _ in range(4)]
    raw.FPDFText_GetFillColor(textpage.raw, index, *rgba)
    key = (name, flags.value, size, tuple(c.value for c in rgba[:3]))
    if key not in cache:
        cache[key] = Style(
            family=family_of(name),
            size=size,
            bold=raw.FPDFText_GetFontWeight(textpage.raw, index) >= 600
            or bool(flags.value & BOLD_FLAG)
            or any(word in lower for word in BOLD_NAMES),
            italic=bool(flags.value & ITALIC_FLAG) or any(word in lower for word in ITALIC_NAMES),
            color="#{:02x}{:02x}{:02x}".format(*(c.value for c in rgba[:3])),
        )
    return cache[key]


def page_rules(page) -> list[tuple[float, float, float, float]]:
    """Thin horizontal paths on the page (left, bottom, right, top): underlines, and rules a reader sees as lines."""
    import pypdfium2.raw as raw

    rules = []
    for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_PATH], max_depth=3):
        left, bottom, right, top = obj.get_bounds()
        if top - bottom < 2.5 and right - left > 3:
            rules.append((left, bottom, right, top))
    return rules


def underlined(rules, left: float, bottom: float, right: float) -> bool:
    """A rule just below the glyph's box, spanning its middle, underlines it."""
    middle = (left + right) / 2
    return any(r_left - 1 <= middle <= r_right + 1 and bottom - 4 <= r_top <= bottom + 1.5 for r_left, _, r_right, r_top in rules)


def first_word(visible: list[Char], chars: list[Char]) -> float:
    word_end = visible[0].right
    for char in chars[chars.index(visible[0]):]:
        if char.text.isspace():
            break
        word_end = char.right
    return word_end - visible[0].left


def tab_stop(chars: list[Char]) -> float | None:
    """Where the text starts after a leading clause number or bullet set off by more than a space, else None."""
    visible = [c for c in chars if not c.text.isspace()]
    text = "".join(c.text for c in chars).lstrip()
    match = ENUMERATOR.match(text)
    if not match or len(visible) < 3:
        return None
    marker = len(match.group(0).strip())
    if marker >= len(visible):
        return None
    gap = visible[marker].left - visible[marker - 1].right
    # A word space is about 0.28 em: twice that is a tab.
    return visible[marker].left if gap > 0.5 * visible[marker].style.size else None


def line_runs(chars: list[Char], tab: float | None = None) -> list[tuple[str, Style]]:
    """The line's text in runs of one style, whitespace collapsed; a space takes the style before it, and the
    space after a tabbed clause number is a tab."""
    runs: list[list] = []
    for char in chars:
        if tab is not None and runs and not char.text.isspace() and abs(char.left - tab) < 0.5:
            runs[-1][0] = runs[-1][0].rstrip() + "\t"
        if char.text.isspace():
            if runs and not runs[-1][0].endswith((" ", "\t")):
                runs[-1][0] += " "
            continue
        if runs and runs[-1][1] == char.style:
            runs[-1][0] += char.text
        else:
            runs.append([char.text, char.style])
    if runs:
        runs[-1][0] = runs[-1][0].rstrip()
    return [(text, style) for text, style in runs if text]


def page_lines(page, number: int) -> list[Line]:
    """pdfium's lines in reading order, each with its box, size, boldness, columns and styled runs."""
    import pypdfium2.raw as raw

    width, height = page.get_size()
    textpage = page.get_textpage()
    buffer = ctypes.create_string_buffer(128)
    cache: dict = {}
    rules = page_rules(page)
    lines: list[Line] = []
    chars: list[Char] = []
    blank = Style("", 0, False, False, "#000000")

    def flush():
        visible = [c for c in chars if not c.text.isspace()]
        if visible:
            x0 = min(c.left for c in visible)
            x1 = max(c.right for c in visible)
            widths = sorted(c.right - c.left for c in visible)
            gap = COLUMN_GAP * max(widths[len(widths) // 2], 1.0)
            segments, start, run, previous = [], visible[0].left, [], None
            for char in chars:
                if previous is not None and not char.text.isspace() and char.left - previous.right > gap:
                    segments.append((start, " ".join("".join(run).split())))
                    start, run = char.left, []
                run.append(char.text)
                if not char.text.isspace():
                    previous = char
            segments.append((start, " ".join("".join(run).split())))
            lines.append(
                Line(
                    page=number,
                    text=" ".join("".join(c.text for c in chars).split()),
                    x0=x0,
                    x1=x1,
                    top=height - max(c.top for c in visible),
                    size=statistics.mode(c.style.size for c in visible),
                    bold=sum(1 for c in visible if c.style.bold) / len(visible),
                    soft_hyphen=chars[-1].soft_hyphen,
                    centered=abs((x0 + x1) / 2 - width / 2) < 0.01 * width and x1 - x0 < 0.8 * width,
                    segments=segments,
                    runs=line_runs(chars, tab_stop(chars)),
                    tab_x=tab_stop(chars),
                    first_word=first_word(visible, chars),
                )
            )
        chars.clear()

    try:
        for index in range(textpage.count_chars()):
            char = chr(raw.FPDFText_GetUnicode(textpage.raw, index))
            if char in "\r\n":
                flush()
                continue
            if char in "\x02\xad" or raw.FPDFText_IsHyphen(textpage.raw, index):
                if chars:
                    chars[-1].soft_hyphen = True
                continue
            left, bottom, right, top = textpage.get_charbox(index)
            style = blank if char.isspace() else char_style(textpage, index, buffer, cache)
            if not char.isspace() and underlined(rules, left, bottom, right):
                style = replace(style, underline=True)
            chars.append(Char(char, left, bottom, right, top, style))
        flush()
    finally:
        textpage.close()
    return lines


def furniture_keys(pages: list[list[Line]], heights: list[float]) -> set[str]:
    """Lines at the top or bottom of two or more pages (running headers, footers, page numbers), digits folded."""
    seen: dict[str, set[int]] = {}
    for lines, height in zip(pages, heights):
        for line in lines:
            if line.top < FURNITURE * height or line.top > (1 - FURNITURE) * height:
                seen.setdefault(re.sub(r"\d+", "#", line.text.lower()), set()).add(line.page)
    return {key for key, where in seen.items() if len(where) > 1 or PAGE_NUMBER.match(key)}


def column_tables(lines: list[Line]) -> list[tuple[int, int]]:
    """Runs of two or more lines split into the same aligned columns: [start, end) indexes."""
    runs, start = [], None
    for index in range(len(lines) + 1):
        line = lines[index] if index < len(lines) else None
        columns = len(line.segments) if line else 0
        if start is not None:
            first = lines[start]
            aligned = (
                line is not None
                and columns == len(first.segments)
                and all(abs(a[0] - b[0]) < 12 for a, b in zip(line.segments[1:], first.segments[1:]))
            )
            if aligned:
                continue
            if index - start >= 2:
                runs.append((start, index))
            start = None
        if line is not None and columns >= 2:
            start = index
    return runs


def pdfplumber_tables(path: str, numbers: list[int]):
    """Ruled tables by page: (top, bottom, x0, x1, rows), or None without the `tables` extra."""
    try:
        import pdfplumber
    except ModuleNotFoundError:
        return None
    found: dict[int, list] = {}
    with pdfplumber.open(path) as document:
        for number in numbers:
            for table in document.pages[number - 1].find_tables():
                rows = [[" ".join(str(cell or "").split()) for cell in row] for row in table.extract()]
                x0, top, x1, bottom = table.bbox
                found.setdefault(number, []).append((top, bottom, x0, x1, rows))
    return found


def export(request: dict) -> dict:
    path = request["path"]
    document = open_document(path)
    total = len(document)
    numbers = page_numbers(request.get("pages"), total)
    pages, heights, scanned = [], [], []
    for number in numbers:
        page = document[number - 1]
        lines = page_lines(page, number)
        if not lines:
            scanned.append(number)
        pages.append(lines)
        heights.append(page.get_height())
    if scanned:
        listed = ",".join(map(str, scanned))
        raise ValueError(
            f"No text layer on page(s) {listed} (a scan), so convert wrote nothing: a converted copy would be "
            f'missing those pages. Render them with documents render (pages "{listed}") to see them, and tell '
            "the person the PDF needs OCR before it can be converted."
        )

    keys = furniture_keys(pages, heights) if len(numbers) > 1 else set()
    ruled = pdfplumber_tables(path, numbers)
    dropped = 0
    furniture: list[tuple[Line, float]] = []
    # (page, top, kind, value, where the next block's spacing is measured from)
    items: list[tuple] = []
    for lines, height, number in zip(pages, heights, numbers):
        kept = []
        for line in lines:
            in_margin = line.top < FURNITURE * height or line.top > (1 - FURNITURE) * height
            key = re.sub(r"\d+", "#", line.text.lower())
            if in_margin and (key in keys or PAGE_NUMBER.match(key)):
                dropped += 1
                furniture.append((line, height))
            else:
                kept.append(line)
        for top, bottom, _x0, _x1, rows in (ruled or {}).get(number, []):
            inside = [line for line in kept if top - 2 <= line.top <= bottom + 2]
            kept = [line for line in kept if line not in inside]
            table = {"rows": rows, **table_style(inside), "ruled": True}
            items.append((number, top, "table", table, bottom - 0.72 * kept[0].size if kept else bottom))
        claimed: set[int] = set()
        for start, end in column_tables(kept):
            columns = len(kept[start].segments)
            rows = [[text for _, text in line.segments] + [""] * (columns - len(line.segments)) for line in kept[start:end]]
            table = {"rows": rows, **table_style(kept[start:end]), "ruled": False}
            items.append((number, kept[start].top, "table", table, kept[end - 1].top))
            claimed.update(range(start, end))
        items += [(number, line.top, "line", line, line.top) for index, line in enumerate(kept) if index not in claimed]
    items.sort(key=lambda item: (item[0], item[1]))

    body_lines = [item[3] for item in items if item[2] == "line"]
    if not body_lines and not any(item[2] == "table" for item in items):
        raise ValueError("The PDF has no text to convert.")
    weights: dict[float, int] = {}
    for line in body_lines:
        weights[line.size] = weights.get(line.size, 0) + len(line.text)
    body = max(weights, key=weights.get) if weights else 0
    plain = [line for line in body_lines if line.size == body and line.bold < 0.5]
    left = min((line.x0 for line in plain), default=0)
    edges = sorted(line.x1 for line in plain)
    right = edges[int(0.95 * (len(edges) - 1))] if edges else 0
    pitches = [
        b.top - a.top
        for a, b in zip(plain, plain[1:])
        if a.page == b.page and 0 < b.top - a.top < 3 * body
    ]
    steady = [step for step in pitches if step < 1.3 * statistics.median(pitches)] if pitches else []
    pitch = statistics.fmean(steady) if steady else body * 1.2
    families: dict[tuple[str, float], int] = {}
    for line in plain:
        for text, style in line.runs:
            families[(style.family, style.size)] = families.get((style.family, style.size), 0) + len(text)
    font = max(families, key=families.get) if families else ("", 0)

    def extend(block: dict, line: Line, joined: bool) -> None:
        """Add the line's text and runs to the block, a space between lines unless a word was hyphenated."""
        runs = block["runs"]
        if runs and not joined:
            runs[-1][0] += " "
        block["text"] += ("" if joined or not block["text"] else " ") + "".join(text for text, _ in line.runs)
        for text, style in line.runs:
            if runs and runs[-1][1] == style:
                runs[-1][0] += text
            else:
                runs.append([text, style])
        block["centered"] = block.get("centered", True) and line.centered
        if block.get("lines"):
            block.setdefault("x_next", line.x0)
        block["lines"] = block.get("lines", 0) + 1

    def run_dicts(block: dict, heading: bool) -> list[dict] | None:
        """The block's runs, or None when it is all body text: only what differs from the body font is named."""
        out = []
        for text, style in block["runs"]:
            run: dict = {"text": text}
            if style.bold:
                run["bold"] = True
            if style.italic:
                run["italic"] = True
            if style.underline:
                run["underline"] = True
            if heading or style.family != font[0]:
                run["family"] = style.family
            if heading or style.size != font[1]:
                run["size"] = style.size
            if style.color != "#000000":
                run["color"] = style.color
            out.append(run)
        return out if heading or any(len(run) > 1 for run in out) else None

    def heading(line: Line) -> bool:
        words = len(line.text.split())
        return 0 < words <= 20 and not line.text.endswith(",") and (line.size >= body * 1.15 or line.bold >= 0.9)

    def full(line: Line) -> bool:
        return line.x1 > right - 0.12 * (right - left)

    def ended(last: Line, line: Line) -> bool:
        """The next line's first word would have fit on the last one, so the break was meant, not wrapping."""
        average = (line.x1 - line.x0) / max(len(line.text), 1)
        return right - last.x1 > (len(line.text.split()[0]) + 1) * average

    blocks: list[dict] = []
    current: dict | None = None
    last: Line | None = None
    # For each wrapped line, where its paragraph's next word would have ended had it stayed on it.
    wraps: list[float] = []
    previous: tuple[int, float] | None = None  # (page, top) the next block's space before is measured from

    bottoms = {number: height for number, height in zip(numbers, heights)}

    def page_break(line: Line) -> bool:
        """A block opening a page after one that ended well short of its foot: the source broke the page there."""
        if previous is None or previous[0] == line.page:
            return False
        return previous[1] < 0.7 * bottoms[previous[0]]

    def space_before(line: Line) -> float:
        """The gap above the line beyond its own line pitch, in points; none at the top of a page."""
        if previous is None or previous[0] != line.page:
            return 0
        extra = line.top - previous[1] - pitch * line.size / body
        # Line-to-line jitter in the source is not spacing: only a gap of a quarter line or more is.
        return round(extra) if extra > 0.25 * pitch else 0

    for page, _top, kind, value, end in items:
        if kind == "table":
            blocks.append({"type": "table", **value, "page": page})
            current, last = None, None
            previous = (page, end)
            continue
        line: Line = value
        # A bold line that carries on the paragraph above (no gap, no clause number, the line above ran to the
        # margin) is that paragraph's, such as a closing sentence set in bold.
        continues = (
            current is not None
            and current["type"] == "paragraph"
            and last is not None
            and last.page == line.page
            and not ENUMERATOR.match(line.text)
            and not ended(last, line)
            and line.top - last.top <= 1.35 * pitch
        )
        if heading(line) and not continues:
            key = (line.size, line.centered)
            if (
                current is not None
                and current["type"] == "heading"
                and current["key"] == key
                and last is not None
                and last.page == line.page
                and full(last)
                and line.top - last.top < 2 * pitch
            ):
                extend(current, line, False)
            else:
                current = {"type": "heading", "key": key, "text": "", "runs": [], "page": page, "x0": line.x0, "tab_x": line.tab_x}
                current["before"] = space_before(line)
                current["break"] = page_break(line)
                extend(current, line, False)
                blocks.append(current)
            last = line
            previous = (page, end)
            continue
        starts = (
            current is None
            or current["type"] != "paragraph"
            or last is None
            or bool(ENUMERATOR.match(line.text))
        )
        if not starts:
            # A line set at an enumerated item's hanging indent continues it, however short the line above.
            hanging = bool(ENUMERATOR.match(current["text"])) and line.x0 > current["x0"] + 4
            starts = (ended(last, line) and not hanging) or (
                last.page == line.page
                and (line.top - last.top > 1.35 * pitch or (line.x0 < last.x0 - 8 and line.x0 < current["x0"] - 8))
            )
        if starts:
            current = {"type": "paragraph", "text": "", "runs": [], "page": page, "x0": line.x0, "tab_x": line.tab_x}
            current["before"] = space_before(line)
            current["break"] = page_break(line)
            extend(current, line, False)
            blocks.append(current)
        else:
            if last.page == line.page:
                wraps.append(last.x1 + 0.28 * line.size + line.first_word)
            extend(current, line, last.soft_hyphen)
        last = line
        previous = (page, end)

    levels = sorted({b["key"] for b in blocks if b["type"] == "heading"}, key=lambda k: (-k[0], not k[1]))
    outline = []
    for block in blocks:
        if block["type"] == "heading":
            item = {"type": "heading", "level": min(levels.index(block["key"]) + 1, 3), "text": block["text"], "page": block["page"]}
        elif block["type"] == "paragraph":
            item = {"type": "paragraph", "text": block["text"], "page": block["page"]}
        else:
            outline.append(block)
            continue
        if not block.get("centered"):
            # Wrapped lines, or the text after a tabbed clause number, set the left indent; a first line out
            # of line with them is a hanging or first-line indent.
            wrapped = block.get("x_next", block.get("tab_x") or block["x0"])
            if round(wrapped - left) > 1:
                item["indent"] = round(wrapped - left)
            if abs(block["x0"] - wrapped) > 1:
                item["first_line"] = round(block["x0"] - wrapped)
        runs = run_dicts(block, item["type"] == "heading")
        if runs:
            item["runs"] = runs
        if block.get("centered"):
            item["align"] = "center"
        if block.get("before"):
            item["space_before"] = block["before"]
        if block.get("break"):
            item["page_break_before"] = True
        outline.append(item)

    count = lambda kind: sum(1 for block in outline if block["type"] == kind)
    notes = []
    if dropped:
        notes.append(f"Dropped {dropped} running header, footer or page-number line(s).")
    if ruled is None:
        notes.append(
            "Ruled tables came over only where their columns line up: the `tables` extra (pdfplumber) "
            "is not installed. Check each table against the PDF."
        )
    return {
        "text": " ".join(notes),
        "details": {
            "pages": len(numbers),
            "headings": count("heading"),
            "paragraphs": count("paragraph"),
            "tables": count("table"),
            "dropped": dropped,
            "tables_extra": "missing" if ruled is None else "used",
        },
        "outline": {
            "source": os.path.basename(path),
            **({"font": {"family": font[0], "size": font[1]}} if font[0] else {}),
            "page": page_layout(document, numbers, body_lines, pitch, left, text_edge(plain, wraps)),
            "line_pitch": round(pitch, 1),
            **running_lines(furniture, numbers, total),
            "blocks": outline,
        },
    }


def text_edge(plain: list[Line], wraps: list[float]) -> float:
    """The right margin the source wrapped at: past its longest line, short of every word it pushed down."""
    longest = max((line.x1 for line in plain), default=0)
    pushed = sorted(edge for edge in wraps if edge > longest)
    # A word pushed down only just past the longest line bounds the margin; split the difference.
    return (longest + pushed[0]) / 2 if pushed else longest


def table_style(lines: list[Line]) -> dict:
    """The cells' text size, and whether the first row is bold, from the lines a table took."""
    if not lines:
        return {}
    style: dict = {"size": statistics.mode(line.size for line in lines)}
    if lines[0].bold >= 0.9 and any(line.bold < 0.5 for line in lines[1:]):
        style["header"] = True
    return style


def page_layout(document, numbers: list[int], lines: list[Line], pitch: float, left: float, right: float) -> dict:
    """Page size and margins, from the first page and where body text sits on each page."""
    width, height = document[numbers[0] - 1].get_size()
    firsts, lasts = {}, {}
    for line in lines:
        firsts[line.page] = min(firsts.get(line.page, height), line.top)
        lasts[line.page] = max(lasts.get(line.page, 0), line.top + line.size)
    size = statistics.mode(line.size for line in lines) if lines else 11
    # Word sets a line's first baseline about 0.8 of its pitch below the top margin; a glyph's top is
    # about 0.72 of its size above its baseline.
    top = statistics.median(firsts.values()) - (0.8 * pitch - 0.72 * size) if firsts else 72
    bottom = height - max(lasts.values()) if lasts else 72
    return {
        "width": round(width, 1),
        "height": round(height, 1),
        "margins": {
            "top": max(round(top), 0),
            "bottom": max(round(bottom) - 2, 0),
            # To a tenth of a point: a point either way moves a word between lines.
            "left": round(left, 1),
            "right": max(round(width - right, 1), 0),
        },
    }


def running_lines(furniture: list[tuple[Line, float]], numbers: list[int], total: int) -> dict:
    """The running header and footer as the first page that has them shows them, page numbers as fields."""
    out: dict = {}
    if not furniture:
        return out
    first_page = min(line.page for line, _ in furniture)
    for line, height in furniture:
        if line.page != first_page:
            continue
        zone = "header" if line.top < height / 2 else "footer"
        texts = []
        for _, text in line.segments:
            # The page's own number and the page count become fields, so every page shows its own.
            if re.search(r"\bpage\b|^\d+$", line.text.lower()):
                text = re.sub(rf"\b{line.page}\b", "{PAGE}", text, count=1)
                text = re.sub(rf"(?<=of ){total}\b", "{NUMPAGES}", text)
            texts.append(text)
        entry = {"text": "\t".join(texts) if len(texts) == 2 else " ".join(texts)}
        if len(texts) == 2:
            entry["split"] = True
        if line.bold >= 0.9:
            entry["bold"] = True
        if line.size:
            entry["size"] = line.size
        out.setdefault(zone, []).append(entry)
        out.setdefault(f"{zone}_distance", round(line.top - 2 if zone == "header" else height - line.top - line.size))
        if zone == "footer":
            out["footer_distance"] = min(out["footer_distance"], round(height - line.top - line.size))
    return out


COMMANDS = {"read": read, "render": render, "export": export}


def main() -> int:
    try:
        request = json.load(sys.stdin)
        command = COMMANDS.get(request.get("command"))
        if command is None:
            raise ValueError(f"the PDF adapter has no command {request.get('command')!r}")
        result = command(request)
        result.setdefault("details", {})["timing"] = {"python_ms": round((time.perf_counter() - STARTED) * 1000, 1)}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        print(json.dumps({"error": f"This Recipe's Python has no {error.name}: the PDF adapter needs pypdfium2 and pillow"}))
        return 1
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
