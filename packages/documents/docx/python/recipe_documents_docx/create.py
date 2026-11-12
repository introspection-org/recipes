"""A new Word file built from another format's outline: the creating side of `documents convert`.

Headings become Heading 1-3, paragraphs Normal with their indent, and tables Table Grid tables.
Clause numbers and bullets stay as the text the source shows, never Word list numbering, so they
never renumber under an edit.
"""

import os

import docx
from docx.shared import Pt


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
    counts = {"heading": 0, "paragraph": 0, "table": 0}
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            document.add_heading(block["text"], level=min(max(int(block.get("level") or 1), 1), 3))
        elif kind == "paragraph":
            paragraph = document.add_paragraph(block["text"])
            if block.get("indent"):
                paragraph.paragraph_format.left_indent = Pt(block["indent"])
        elif kind == "table":
            rows = [list(row) for row in block["rows"] if row]
            if not rows:
                continue
            columns = max(len(row) for row in rows)
            table = document.add_table(rows=len(rows), cols=columns)
            table.style = "Table Grid"
            for row, cells in zip(table.rows, rows):
                for cell, value in zip(row.cells, cells + [""] * (columns - len(cells))):
                    cell.text = value
        else:
            raise ValueError(f"The outline has a block of unknown type {kind!r}")
        counts[kind] += 1
    document.save(output)
    return {
        "text": (
            f"Converted {source} to {os.path.basename(output)}: {counts['heading']} heading(s), "
            f"{counts['paragraph']} paragraph(s), {counts['table']} table(s). The layout was rebuilt, not copied: "
            "read it and check clause numbers and tables against the source, then change it in place "
            "(path set to it, no output)."
        ),
        "details": {"blocks": counts},
    }
