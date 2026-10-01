"""Regenerate the small, original PDF fixtures; requires PyMuPDF, not OCR models."""
from pathlib import Path
import pymupdf

root = Path(__file__).resolve().parent
with pymupdf.open() as doc:
    for number in range(4):
        page = doc.new_page(width=500, height=650)
        page.insert_text((36, 36), f'Native typography document, page {number + 1}.',
                         fontname='tiro', fontsize=14)
        if number == 1:
            x = 36
            for text, font in [('He whispered ', 'tiro'), ('remember me', 'tiit'),
                               (', then fell silent.', 'tiro')]:
                page.insert_text((x, 100), text, fontname=font, fontsize=14)
                x += pymupdf.get_text_length(text, fontname=font, fontsize=14)
            page.insert_text((36, 140), 'This sentence is deliberately bold.', fontname='tibo', fontsize=14)
            page.insert_text((36, 180), 'A different voice in monospace.', fontname='cour', fontsize=14)
            page.insert_text((36, 220), 'Another voice in a sans-serif italic face.', fontname='heit', fontsize=14)
            page.insert_text((36, 270), 'A larger heading.', fontname='tibo', fontsize=22)
            page.insert_text((36, 310), 'A smaller footnote.', fontname='tiro', fontsize=10)
    doc.set_toc([[1, 'First chapter', 2], [2, 'Nested section', 3], [1, 'Last chapter', 4]])
    # Exercise a named destination as well as ordinary page-reference destinations.
    destinations = doc.get_new_xref()
    doc.update_object(destinations,
                      f'<< /Names [(nested-section) [{doc.page_xref(2)} 0 R /XYZ 36 614 0]] >>')
    doc.xref_set_key(doc.pdf_catalog(), 'Names', f'<< /Dests {destinations} 0 R >>')
    nested = doc.get_outline_xrefs()[1]
    doc.xref_set_key(nested, 'A', 'null')
    doc.xref_set_key(nested, 'Dest', '(nested-section)')
    doc.save(root / 'typography-outline.pdf')
    doc.set_toc([])
    doc.save(root / 'without-outline.pdf')
print('Created mixed-font PDFs with nested/named destinations and without bookmarks.')
