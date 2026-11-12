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
from dataclasses import dataclass, field

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


def font_name(textpage, index: int, buffer) -> str:
    import pypdfium2.raw as raw

    flags = ctypes.c_int()
    raw.FPDFText_GetFontInfo(textpage.raw, index, buffer, len(buffer), flags)
    return buffer.value.decode("latin-1").lower()


def page_lines(page, number: int) -> list[Line]:
    """pdfium's lines in reading order, each with its box, font size, boldness and column segments."""
    import pypdfium2.raw as raw

    width, height = page.get_size()
    textpage = page.get_textpage()
    buffer = ctypes.create_string_buffer(128)
    lines: list[Line] = []
    chars: list[tuple] = []

    def flush():
        visible = [c for c in chars if not c[0].isspace()]
        if visible:
            x0 = min(c[1] for c in visible)
            x1 = max(c[3] for c in visible)
            top = height - max(c[4] for c in visible)
            sizes = [round(c[5] * 2) / 2 for c in visible]
            widths = sorted(c[3] - c[1] for c in visible)
            gap = COLUMN_GAP * max(widths[len(widths) // 2], 1.0)
            segments, start, run = [], visible[0][1], []
            previous = None
            for char in chars:
                if previous is not None and not char[0].isspace() and char[1] - previous[3] > gap:
                    segments.append((start, " ".join("".join(run).split())))
                    start, run = char[1], []
                run.append(char[0])
                if not char[0].isspace():
                    previous = char
            segments.append((start, " ".join("".join(run).split())))
            text = " ".join("".join(c[0] for c in chars).split())
            lines.append(
                Line(
                    page=number,
                    text=text,
                    x0=x0,
                    x1=x1,
                    top=top,
                    size=statistics.mode(sizes),
                    bold=sum(1 for c in visible if c[6]) / len(visible),
                    soft_hyphen=bool(chars) and chars[-1][7],
                    centered=abs((x0 + x1) / 2 - width / 2) < 0.05 * width,
                    segments=segments,
                )
            )
        chars.clear()

    try:
        for index in range(textpage.count_chars()):
            char = chr(raw.FPDFText_GetUnicode(textpage.raw, index))
            if char in "\r\n":
                flush()
                continue
            if char in "\x02\xad":
                if chars:
                    chars[-1] = chars[-1][:7] + (True,)
                continue
            left, bottom, right, top = textpage.get_charbox(index)
            name = font_name(textpage, index, buffer) if not char.isspace() else ""
            bold = raw.FPDFText_GetFontWeight(textpage.raw, index) >= 600 or any(b in name for b in BOLD_NAMES)
            hyphen = bool(raw.FPDFText_IsHyphen(textpage.raw, index))
            if hyphen:
                if chars:
                    chars[-1] = chars[-1][:7] + (True,)
                continue
            chars.append((char, left, bottom, right, top, raw.FPDFText_GetFontSize(textpage.raw, index), bold, False))
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
    items: list[tuple] = []  # (page, top, kind, value)
    for lines, height, number in zip(pages, heights, numbers):
        kept = []
        for line in lines:
            in_margin = line.top < FURNITURE * height or line.top > (1 - FURNITURE) * height
            key = re.sub(r"\d+", "#", line.text.lower())
            if in_margin and (key in keys or PAGE_NUMBER.match(key)):
                dropped += 1
            else:
                kept.append(line)
        for top, bottom, _x0, _x1, rows in (ruled or {}).get(number, []):
            kept = [line for line in kept if not top - 2 <= line.top <= bottom + 2]
            items.append((number, top, "table", rows))
        claimed: set[int] = set()
        for start, end in column_tables(kept):
            columns = len(kept[start].segments)
            rows = [[text for _, text in line.segments] + [""] * (columns - len(line.segments)) for line in kept[start:end]]
            items.append((number, kept[start].top, "table", rows))
            claimed.update(range(start, end))
        items += [(number, line.top, "line", line) for index, line in enumerate(kept) if index not in claimed]
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
    pitch = statistics.median(pitches) if pitches else body * 1.2

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
    for page, _top, kind, value in items:
        if kind == "table":
            blocks.append({"type": "table", "rows": value, "page": page})
            current, last = None, None
            continue
        line: Line = value
        if heading(line):
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
                current["text"] += " " + line.text
            else:
                current = {"type": "heading", "key": key, "text": line.text, "page": page}
                blocks.append(current)
            last = line
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
            current = {"type": "paragraph", "text": line.text, "page": page, "x0": line.x0}
            blocks.append(current)
        else:
            current["text"] += line.text if last.soft_hyphen else " " + line.text
        last = line

    levels = sorted({b["key"] for b in blocks if b["type"] == "heading"}, key=lambda k: (-k[0], not k[1]))
    outline = []
    for block in blocks:
        if block["type"] == "heading":
            outline.append(
                {"type": "heading", "level": min(levels.index(block["key"]) + 1, 3), "text": block["text"], "page": block["page"]}
            )
        elif block["type"] == "paragraph":
            item = {"type": "paragraph", "text": block["text"], "page": block["page"]}
            indent = round((block["x0"] - left) / 9) * 9
            if indent > 0:
                item["indent"] = indent
            outline.append(item)
        else:
            outline.append(block)

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
        "outline": {"source": os.path.basename(path), "blocks": outline},
    }


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
