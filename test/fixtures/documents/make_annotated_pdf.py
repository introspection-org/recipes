"""A one-page PDF with a filled form field and a page comment, written by hand (no PDF library)."""

import sys
objs = [
 b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>",
 b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
 b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R 7 0 R] >>",
 None,
 b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
 b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Licensee) /V (GiantCo Ltd) /Rect [100 600 300 620] /P 3 0 R >>",
 b"<< /Type /Annot /Subtype /Text /Rect [50 700 70 720] /Contents (Check the cap) /T (Counsel) /P 3 0 R >>",
]
stream = b"BT /F1 12 Tf 72 720 Td (Clause 1. Fees are due in thirty days.) Tj ET"
objs[3] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
out = bytearray(b"%PDF-1.7\n"); offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
x = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs)+1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs)+1, x)
open(sys.argv[1], "wb").write(out)
