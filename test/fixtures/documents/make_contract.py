"""Write the small contract the documents tests mark up: python make_contract.py <out.docx>."""

import sys

import docx
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

document = docx.Document()
document.add_heading("Services Agreement", level=1)
document.add_paragraph("1. Term. This Agreement lasts thirty days from the Effective Date.")
document.add_paragraph("2. Fees. Customer pays the fees within thirty days of each invoice.")
document.add_paragraph("3. Liability. Provider’s liability is unlimited for any claim.")
document.add_paragraph("4. Audit. Customer may audit Provider at any time on notice.")
document.add_paragraph("5. Notices. Notices go to the addresses on the order form.")
document.add_paragraph("6. Payment. Each payment is due on the payment date stated in the order.")
# A bookmark between runs, as Word leaves around cross-reference targets.
records = document.add_paragraph("7. Records. Provider keeps ")
start = OxmlElement("w:bookmarkStart")
start.set(qn("w:id"), "7")
start.set(qn("w:name"), "_Ref7")
records._p.append(start)
records.add_run("records for three")
end = OxmlElement("w:bookmarkEnd")
end.set(qn("w:id"), "7")
records._p.append(end)
records.add_run(" years after termination.")
# A proofing mark between runs, as Word leaves around a flagged word.
audit = document.add_paragraph("8. Inspections. Customer inspects ")
mark = OxmlElement("w:proofErr")
mark.set(qn("w:type"), "spellStart")
audit._p.append(mark)
audit.add_run("the premises yearly.")
# A tab between a clause number and its title, and a no-break hyphen inside a defined term.
heading = document.add_paragraph()
heading.add_run("9.")._r.append(OxmlElement("w:tab"))
heading.add_run("Confidentiality. The ")
heading.add_run("Non")._r.append(OxmlElement("w:noBreakHyphen"))
heading.add_run("Party keeps all information secret.")
# Word's layout hint inside a run: a non-text node between words.
survival = document.add_paragraph("10. Survival. Sections 3 and 4 survive ")
hinted = survival.add_run()
hinted._r.append(OxmlElement("w:lastRenderedPageBreak"))
hinted.add_text("termination of this Agreement.")
document.save(sys.argv[1])
