import { extractNativePdfPage } from './pdf-graphics.mjs';

/** Extract source paragraphs, typography and illustrations without OCR. */
export async function getNativePdfBlocks(page, pdfDocument, pdfjs = globalThis.pdfjsLib) {
    const unit = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, 3200 / Math.max(unit.width, unit.height)) });
    const { blocks, canvas } = await extractNativePdfPage(page, pdfDocument, {
        OPS: pdfjs.OPS, viewport,
        createCanvas: (width, height) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
        },
        imageUrl: crop => crop.toDataURL('image/png')
    });
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    return blocks;
}

/** Return reflowable DOM. Reader CSS owns user family, base size, and color. */
export function renderNativePdfBlocks(blocks, targetDocument = globalThis.document, { onNavigate, assetUrl = url => url } = {}) {
    const text = targetDocument.createElement('div');
    text.className = 'pdf-native-text';
    for (const block of blocks) {
        if (block.type === 'image') {
            const figure = targetDocument.createElement('figure');
            figure.className = 'pdf-figure';
            if (block.pageWidth > 0) {
                figure.style.width = Math.min(100, block.width / block.pageWidth * 100) + '%';
                figure.style.marginLeft = block.bbox.x0 / block.pageWidth * 100 + '%';
            }
            const graphic = targetDocument.createElement('img');
            graphic.src = assetUrl(block.imageUrl);
            graphic.width = block.width;
            graphic.height = block.height;
            graphic.alt = block.alt;
            figure.appendChild(graphic);
            text.appendChild(figure);
            continue;
        }
        const paragraph = targetDocument.createElement('p');
        paragraph.className = 'pdf-text-block';
        paragraph.dataset.ttsText = block.text;
        if (block.indented) paragraph.classList.add('pdf-text-indented');
        if (block.preserveWhitespace) paragraph.dataset.preserveWhitespace = 'true';
        for (const run of block.runs) {
            const span = targetDocument.createElement('span');
            span.style.fontSize = run.fontScale + 'em';
            if (run.fontFamily) span.style.fontFamily = run.fontFamily;
            if (run.fontStyle) span.style.fontStyle = run.fontStyle;
            if (run.fontWeight !== undefined) span.style.fontWeight = String(run.fontWeight);
            if (run.fontName) span.dataset.sourceFont = run.fontName;
            span.textContent = run.text;
            const link = run.link;
            if (link) {
                const anchor = targetDocument.createElement('a');
                anchor.className = 'pdf-source-link';
                if (link.page !== undefined) {
                    anchor.dataset.pdfPage = String(link.page);
                    anchor.href = pageHref(link.page, targetDocument);
                    if (onNavigate) anchor.addEventListener('click', event => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        onNavigate(link.page, event);
                    });
                } else {
                    anchor.href = link.url;
                    anchor.target = '_blank';
                    anchor.rel = 'noopener noreferrer';
                }
                anchor.appendChild(span);
                paragraph.appendChild(anchor);
            } else paragraph.appendChild(span);
        }
        text.appendChild(paragraph);
    }
    return text;
}

function pageHref(page, targetDocument) {
    const base = targetDocument.defaultView?.location?.href;
    if (!base) return `#pdf-page-${page}`;
    const url = new URL(base);
    url.searchParams.set('page', String(page));
    url.searchParams.delete('ch');
    url.searchParams.delete('local');
    url.hash = '';
    return url.href;
}
