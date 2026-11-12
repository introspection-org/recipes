"""Print a Word file's body as the blocks `convert` uses: python dump_docx.py <in.docx> [--layout].

Headings by their Heading N style, paragraphs by their text with tracked changes accepted (what
the file reads as once reviewed), tables as rows of cell text. With --layout, the page, the Normal
font, the footer (fields as {PAGE} and {NUMPAGES}) and each heading's run formatting instead.
"""

import json
import sys

import docx
from docx.table import Table
from docx.text.paragraph import Paragraph

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def current(element) -> str:
    """The text with insertions kept and deletions dropped."""
    parts = []
    for node in element.iter(f"{W}t", f"{W}tab"):
        if any(parent.tag in (f"{W}del", f"{W}moveFrom") for parent in node.iterancestors()):
            continue
        parts.append("\t" if node.tag == f"{W}tab" else node.text or "")
    return " ".join("".join(parts).split())


def layout(document) -> dict:
    section = document.sections[0]
    normal = document.styles["Normal"].font
    footer = []
    for paragraph in section.footer.paragraphs:
        parts = []
        for node in paragraph._p.iterchildren():
            if node.tag == f"{W}fldSimple":
                parts.append("{" + node.get(f"{W}instr").strip() + "}")
            elif node.tag == f"{W}r":
                parts += ["\t" if t.tag == f"{W}tab" else t.text or "" for t in node.iter(f"{W}t", f"{W}tab")]
        footer.append("".join(parts))
    headings = []
    for paragraph in document.paragraphs:
        if paragraph.style.name.startswith("Heading "):
            headings.append(
                [
                    {"text": run.text, "bold": run.bold, "size": run.font.size.pt if run.font.size else None,
                     "family": run.font.name, "color": str(run.font.color.rgb) if run.font.color.rgb else None}
                    for run in paragraph.runs
                ]
            )
    return {
        "page": {
            "width": section.page_width.pt,
            "height": section.page_height.pt,
            "left": section.left_margin.pt,
            "right": section.right_margin.pt,
        },
        "font": {"family": normal.name, "size": normal.size.pt if normal.size else None},
        "footer": footer,
        "headings": headings,
    }


document = docx.Document(sys.argv[1])
if "--layout" in sys.argv:
    print(json.dumps(layout(document), ensure_ascii=False))
    sys.exit()
blocks = []
for child in document.element.body.iterchildren():
    if child.tag == f"{W}p":
        paragraph = Paragraph(child, document)
        text = current(child)
        if not text:
            continue
        style = paragraph.style.name if paragraph.style is not None else ""
        if style.startswith("Heading "):
            blocks.append({"type": "heading", "level": int(style.split()[-1]), "text": text})
        else:
            blocks.append({"type": "paragraph", "text": text})
    elif child.tag == f"{W}tbl":
        table = Table(child, document)
        blocks.append({"type": "table", "rows": [[current(cell._tc) for cell in row.cells] for row in table.rows]})
print(json.dumps(blocks, ensure_ascii=False))
