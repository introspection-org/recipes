"""Print a Word file's body as the blocks `convert` uses: python dump_docx.py <in.docx>.

Headings by their Heading N style, paragraphs by their text with tracked changes accepted (what
the file reads as once reviewed), tables as rows of cell text.
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


document = docx.Document(sys.argv[1])
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
