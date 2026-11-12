"""A new Word file built from another format's outline: the creating side of `documents convert`.

The outline's page size, margins, line pitch and body font set the section and the Normal style;
a block's runs carry what differs from the body font (bold, italic, underline, family, size,
colour), its indents and its space before. A heading's runs override the Heading style's theme
font and colour. The running header and footer go into Word's own, the page number and count as
fields. Clause numbers and bullets stay as the text the source shows, never Word list numbering,
so they never renumber under an edit.
"""

import os

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

FIELDS = {"{PAGE}": "PAGE", "{NUMPAGES}": "NUMPAGES"}


def styled(paragraph, block: dict) -> None:
    """The block's runs with their formatting, or its plain text in the paragraph's style."""
    for run in block.get("runs") or [{"text": block["text"]}]:
        added = paragraph.add_run(run["text"])
        if run.get("bold"):
            added.bold = True
        if run.get("italic"):
            added.italic = True
        if run.get("underline"):
            added.underline = True
        if run.get("family"):
            added.font.name = run["family"]
        if run.get("size"):
            added.font.size = Pt(run["size"])
        if run.get("color"):
            added.font.color.rgb = RGBColor.from_string(run["color"].lstrip("#").upper())
    layout(paragraph, block)


def layout(paragraph, block: dict) -> None:
    """Alignment, indents and space before from the block; no space after, as the source measured it."""
    if block.get("align") == "center":
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    form = paragraph.paragraph_format
    if block.get("indent"):
        form.left_indent = Pt(block["indent"])
    if block.get("first_line"):
        form.first_line_indent = Pt(block["first_line"])
    form.space_before = Pt(block.get("space_before") or 0)
    form.space_after = Pt(0)
    if block.get("page_break_before"):
        form.page_break_before = True


def field(paragraph, name: str) -> None:
    """A PAGE or NUMPAGES field, which Word fills in on each page."""
    simple = OxmlElement("w:fldSimple")
    simple.set(qn("w:instr"), name)
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "1"
    run.append(text)
    simple.append(run)
    paragraph._p.append(simple)


def running(part, entries: list[dict], width: float) -> None:
    """The header's or footer's lines; a line in two parts puts the second at the right margin."""
    for index, entry in enumerate(entries):
        paragraph = part.paragraphs[0] if index == 0 and part.paragraphs else part.add_paragraph()
        paragraph.paragraph_format.space_before = Pt(0)
        paragraph.paragraph_format.space_after = Pt(0)
        if entry.get("split"):
            stops = paragraph.paragraph_format.tab_stops
            stops.add_tab_stop(Pt(width), WD_TAB_ALIGNMENT.RIGHT)
        for piece in [p for p in _pieces(entry["text"]) if p]:
            if piece in FIELDS:
                field(paragraph, FIELDS[piece])
                continue
            run = paragraph.add_run(piece)
            run.bold = bool(entry.get("bold")) or None
            if entry.get("size"):
                run.font.size = Pt(entry["size"])
        for node in paragraph._p.findall(qn("w:fldSimple")):
            for run in node.findall(qn("w:r")):
                properties = OxmlElement("w:rPr")
                if entry.get("bold"):
                    properties.append(OxmlElement("w:b"))
                if entry.get("size"):
                    size = OxmlElement("w:sz")
                    size.set(qn("w:val"), str(int(entry["size"] * 2)))
                    properties.append(size)
                run.insert(0, properties)


def _pieces(text: str) -> list[str]:
    pieces, rest = [], text
    while rest:
        found = min(((rest.find(token), token) for token in FIELDS if token in rest), default=None)
        if found is None:
            pieces.append(rest)
            break
        at, token = found
        pieces += [rest[:at], token]
        rest = rest[at + len(token):]
    return pieces


def create(request: dict) -> dict:
    outline = request["outline"]
    output = request["output"]
    if os.path.exists(output):
        raise ValueError(f"{os.path.basename(output)} already exists: convert writes a new file")
    blocks = outline.get("blocks") or []
    if not blocks:
        raise ValueError("The outline is empty: there is nothing to convert")
    document = docx.Document()
    source = outline.get("source") or "the source"
    title = next((block["text"] for block in blocks if block["type"] == "heading"), "")
    document.core_properties.title = title or os.path.splitext(source)[0]
    document.core_properties.comments = f"Converted from {source} by the documents tool"

    section = document.sections[0]
    page = outline.get("page") or {}
    if page.get("width") and page.get("height"):
        section.page_width, section.page_height = Pt(page["width"]), Pt(page["height"])
    for side, value in (page.get("margins") or {}).items():
        setattr(section, f"{side}_margin", Pt(value))
    if outline.get("header_distance") is not None:
        section.header_distance = Pt(outline["header_distance"])
    if outline.get("footer_distance") is not None:
        section.footer_distance = Pt(outline["footer_distance"])

    font = outline.get("font") or {}
    normal = document.styles["Normal"]
    if font.get("family"):
        normal.font.name = font["family"]
    if font.get("size"):
        normal.font.size = Pt(font["size"])
    if outline.get("line_pitch"):
        # At least the source's pitch, so a larger heading or inserted text still gets its own height.
        normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.AT_LEAST
        normal.paragraph_format.line_spacing = Pt(outline["line_pitch"])
    normal.paragraph_format.space_after = Pt(0)

    width = (section.page_width - section.left_margin - section.right_margin) / 12700
    if outline.get("header"):
        running(section.header, outline["header"], width)
    if outline.get("footer"):
        running(section.footer, outline["footer"], width)

    counts = {"heading": 0, "paragraph": 0, "table": 0}
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            heading = document.add_heading("", level=min(max(int(block.get("level") or 1), 1), 3))
            styled(heading, block)
            heading.paragraph_format.keep_with_next = True
            if block.get("runs"):
                # The source's heading colour, black unless it said otherwise, not the theme's blue.
                for run, wanted in zip(heading.runs, block["runs"]):
                    if not wanted.get("color"):
                        run.font.color.rgb = RGBColor(0, 0, 0)
        elif kind == "paragraph":
            styled(document.add_paragraph(), block)
        elif kind == "table":
            rows = [list(row) for row in block["rows"] if row]
            if not rows:
                continue
            columns = max(len(row) for row in rows)
            table = document.add_table(rows=len(rows), cols=columns)
            # A table drawn without lines, such as a signature block, stays without borders.
            table.style = "Table Grid" if block.get("ruled", True) else "Normal Table"
            for index, (row, cells) in enumerate(zip(table.rows, rows)):
                for cell, value in zip(row.cells, cells + [""] * (columns - len(cells))):
                    paragraph = cell.paragraphs[0]
                    paragraph.paragraph_format.space_before = Pt(0 if block.get("ruled", True) else 6)
                    run = paragraph.add_run(value)
                    if block.get("size"):
                        run.font.size = Pt(block["size"])
                    if index == 0 and block.get("header"):
                        run.bold = True
        else:
            raise ValueError(f"The outline has a block of unknown type {kind!r}")
        counts[kind] += 1
    document.save(output)
    return {
        "text": (
            f"Converted {source} to {os.path.basename(output)}: {counts['heading']} heading(s), "
            f"{counts['paragraph']} paragraph(s), {counts['table']} table(s). Fonts, spacing, indents and the "
            "running header and footer were rebuilt from the source; page breaks and exact wrapping may differ. "
            "Read it and check clause numbers and tables against the source, then change it in place "
            "(path set to it, no output)."
        ),
        "details": {"blocks": counts},
    }
