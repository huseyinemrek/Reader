import { nativeBlocks, nativePdfLinks } from './pdf-layout-core.mjs';
import { nativeTextContent } from './pdf-fonts.mjs';

/** Extract source paragraphs and per-run typography from a PDF.js page. */
export async function getNativePdfBlocks(page, pdfDocument) {
    const content = await nativeTextContent(page);
    return nativeBlocks(content, page.getViewport({ scale: 1 }), await nativePdfLinks(page, pdfDocument));
}

/** Return reflowable DOM. Reader CSS owns user family, base size, and color. */
export function renderNativePdfBlocks(blocks, targetDocument = globalThis.document, { onNavigate } = {}) {
    const text = targetDocument.createElement('div');
    text.className = 'pdf-native-text';
    for (const block of blocks) {
        const paragraph = targetDocument.createElement('p');
        paragraph.className = 'pdf-text-block';
        paragraph.dataset.ttsText = block.text;
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
