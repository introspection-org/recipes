"""Lay out headings, paragraphs and ruled tables as a paged PDF, written by hand (no PDF library).

python make_text_pdf.py <blocks.json> <out.pdf> [--header TEXT]

blocks.json is a list of {"type": "heading", "level": 1-3, "text"}, {"type": "paragraph", "text"}
and {"type": "table", "rows": [[cell, ...], ...], "ruled"?: false}, the shape `convert` exports. An
unruled table is laid out in columns with no lines, as a signature block is. Every page gets
the running header and a "Page N of M" footer, which a conversion should drop. Paragraphs wrap
at the margin and run across page breaks, so a conversion has to join them back.
"""

import json
import sys

WIDTH, HEIGHT, MARGIN = 612, 792, 72
BODY, LEADING, GAP = 11, 14, 8
HEADING = {1: 18, 2: 14, 3: 12}
CELL, ROW = 10, 18


# Helvetica's advance widths (1/1000 em) for printable ASCII, from its AFM.
HELVETICA = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]


# The punctuation the fixtures use outside ASCII: curly quotes, dashes and the bullet.
HELVETICA_EXTRA = {"\u2018": 222, "\u2019": 222, "\u201c": 333, "\u201d": 333, "\u2013": 556, "\u2014": 1000, "\u2022": 350}


def width(text: str, size: float) -> float:
    return sum(HELVETICA[ord(c) - 32] if 32 <= ord(c) < 127 else HELVETICA_EXTRA.get(c, 556) for c in text) * size / 1000


def wrap(text: str, size: float, room: float) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and width(trial, size) > room:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line] if line else lines


def literal(text: str) -> bytes:
    raw = text.encode("cp1252", errors="replace")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


class Pages:
    def __init__(self, header: str):
        self.header = header
        self.pages: list[list[bytes]] = []
        self.new_page()

    def new_page(self):
        self.pages.append([])
        self.y = HEIGHT - MARGIN

    def room(self, needed: float):
        if self.y - needed < MARGIN:
            self.new_page()

    def text(self, x: float, y: float, value: str, size: float, bold: bool = False):
        font = b"F2" if bold else b"F1"
        self.pages[-1].append(b"BT /%s %g Tf %g %g Td %s Tj ET" % (font, size, x, y, literal(value)))

    def rule(self, x: float, y: float, w: float, h: float):
        self.pages[-1].append(b"%g %g %g %g re S" % (x, y, w, h))

    def heading(self, level: int, value: str):
        size = HEADING[level]
        self.room(size * 3)
        self.y -= size * 0.6
        for line in wrap(value, size, WIDTH - 2 * MARGIN):
            self.y -= size * 1.25
            self.text(MARGIN, self.y, line, size, bold=True)
        self.y -= GAP

    def paragraph(self, value: str):
        for line in wrap(value, BODY, WIDTH - 2 * MARGIN):
            self.room(LEADING)
            self.y -= LEADING
            self.text(MARGIN, self.y, line, BODY)
        self.y -= GAP

    def table(self, rows: list[list[str]], ruled: bool = True):
        columns = max(len(row) for row in rows)
        cell = (WIDTH - 2 * MARGIN) / columns
        height = ROW if ruled else ROW * 1.6
        self.room(height * len(rows) + GAP)
        self.y -= 0 if ruled else GAP
        for index, row in enumerate(rows):
            top = self.y
            for column in range(columns):
                x = MARGIN + column * cell
                if ruled:
                    self.rule(x, top - height, cell, height)
                value = row[column] if column < len(row) else ""
                self.text(x + 4, top - height + 5, value, CELL if ruled else BODY, bold=index == 0)
            self.y -= height
        self.y -= GAP * 2

    def finish(self) -> list[bytes]:
        total = len(self.pages)
        streams = []
        for number, body in enumerate(self.pages, 1):
            furniture = [
                b"BT /F1 9 Tf %g %g Td %s Tj ET" % (MARGIN, HEIGHT - 40, literal(self.header)),
                b"BT /F1 9 Tf %g %g Td %s Tj ET" % (WIDTH / 2 - 25, 36, literal(f"Page {number} of {total}")),
            ]
            streams.append(b"\n".join(furniture + body))
        return streams


def write(streams: list[bytes], path: str) -> None:
    count = len(streams)
    font = b"<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % (5 + 2 * i) for i in range(count)), count),
        font % b"Helvetica",
        font % b"Helvetica-Bold",
    ]
    for index, stream in enumerate(streams):
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents %d 0 R "
            b"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>" % (WIDTH, HEIGHT, 6 + 2 * index)
        )
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    with open(path, "wb") as handle:
        handle.write(out)


def main() -> None:
    source, target = sys.argv[1], sys.argv[2]
    header = sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == "--header" else "Confidential"
    with open(source, encoding="utf-8") as handle:
        blocks = json.load(handle)
    pages = Pages(header)
    for block in blocks:
        if block["type"] == "heading":
            pages.heading(block["level"], block["text"])
        elif block["type"] == "paragraph":
            pages.paragraph(block["text"])
        else:
            pages.table(block["rows"], ruled=block.get("ruled", True))
    write(pages.finish(), target)


if __name__ == "__main__":
    main()
