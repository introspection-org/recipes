"""PDF helper for the Recipes `documents` tool: read (text, optional tables, form values, comments) and render.

python -I pdf.py < request.json   ->   {"text": ..., "details": ...} or {"error": ...}

Text and page images come from pypdfium2. Table cells come from pdfplumber, an
optional extra (`tables`): it is imported only when a read asks for tables, and
a read without it returns the text and says the extra is missing. Nothing is
fetched at run time.
"""

import ctypes
import json
import os
import sys
import time

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


COMMANDS = {"read": read, "render": render}


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
