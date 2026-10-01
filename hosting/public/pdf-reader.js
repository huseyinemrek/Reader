import { nativeBlocks } from './pdf-layout-core.mjs';
import { nativeTextContent } from './pdf-fonts.mjs';

/** Extract source paragraphs and per-run typography from a PDF.js page. */
export async function getNativePdfBlocks(page) {
    const content = await nativeTextContent(page);
    return nativeBlocks(content, page.getViewport({ scale: 1 }));
}

/** Return reflowable DOM. Reader CSS owns user family, base size, and color. */
export function renderNativePdfBlocks(blocks, targetDocument = globalThis.document) {
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
            paragraph.appendChild(span);
        }
        text.appendChild(paragraph);
    }
    return text;
}
