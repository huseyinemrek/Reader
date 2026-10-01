import { nativeBlocks, nativePdfLinks } from './pdf-layout-core.mjs';
import { nativeTextContent } from './pdf-fonts.mjs';

function graphicsOperations(OPS) {
    return new Set([
        OPS.paintImageXObject, OPS.paintImageXObjectRepeat,
        OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
        OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask,
        OPS.constructPath, OPS.rawFillPath, OPS.shadingFill
    ].filter(Number.isInteger));
}

const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function imageOperations(OPS) {
    return new Set([
        OPS.paintImageXObject, OPS.paintImageXObjectRepeat,
        OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
        OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask
    ].filter(Number.isInteger));
}

function graphicRegions(page, operators, OPS, width, height, scale, hasText, links = []) {
    const graphics = graphicsOperations(OPS);
    const images = imageOperations(OPS);
    const bounds = page.recordedBBoxes;
    if (!bounds) throw new Error('PDF renderer did not record source graphics bounds.');
    const regions = [];
    const gap = Math.max(1, scale * 2);
    let fillColor = '#000000';
    const fillColors = [];
    for (let index = 0; index < operators.fnArray.length; index++) {
        const operation = operators.fnArray[index];
        if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(operation)) fillColors.push(fillColor);
        else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(operation)) fillColor = fillColors.pop() ?? '#000000';
        else if (operation === OPS.setFillRGBColor) fillColor = operators.argsArray[index][0];
        else if (operation === OPS.setFillColorN || operation === OPS.setFillTransparent) fillColor = null;
        if (!graphics.has(operation) || bounds.isEmpty(index)) continue;
        if (operation === OPS.constructPath && operators.argsArray[index][0] === OPS.endPath) continue;
        if (operation === OPS.constructPath && fillColor === '#ffffff' &&
            [OPS.fill, OPS.eoFill].includes(operators.argsArray[index][0])) continue;
        let box = {
            x0: Math.max(0, Math.floor(bounds.minX(index) * width)),
            y0: Math.max(0, Math.floor(bounds.minY(index) * height)),
            x1: Math.min(width, Math.ceil(bounds.maxX(index) * width)),
            y1: Math.min(height, Math.ceil(bounds.maxY(index) * height)),
            hasImage: images.has(operation)
        };
        if (box.x1 <= box.x0 || box.y1 <= box.y0) continue;
        // Page-background fills must not turn otherwise reflowable prose into
        // a full-page screenshot. Full-page raster illustrations are retained.
        if (hasText && [OPS.constructPath, OPS.shadingFill].includes(operation) &&
            box.x1 - box.x0 >= width * 0.95 && box.y1 - box.y0 >= height * 0.95) continue;
        for (let other = 0; other < regions.length;) {
            const candidate = regions[other];
            if (box.x0 <= candidate.x1 + gap && box.x1 + gap >= candidate.x0 &&
                box.y0 <= candidate.y1 + gap && box.y1 + gap >= candidate.y0) {
                box = { x0: Math.min(box.x0, candidate.x0), y0: Math.min(box.y0, candidate.y0),
                    x1: Math.max(box.x1, candidate.x1), y1: Math.max(box.y1, candidate.y1),
                    hasImage: candidate.hasImage || box.hasImage };
                regions.splice(other, 1);
                other = 0;
            } else other++;
        }
        regions.push(box);
    }
    // Isolated hairlines/underlines are not figures; connected chart strokes
    // remain part of their larger source crop.
    // Recorded bounds can expand by two 1/256-page cells.
    return regions.filter(box => {
        if (box.x1 - box.x0 <= scale * 3 + Math.ceil(width / 128) ||
            box.y1 - box.y0 <= scale * 3 + Math.ceil(height / 128)) return false;
        if (!box.hasImage && links.some(link => overlaps(link.bbox, box))) return false;
        return true;
    }).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** Extract native text and source-rendered illustrations without invoking OCR.
 * The caller owns the returned full-page canvas; temporary crops are released here.
 */
export async function extractNativePdfPage(page, pdfDocument, { OPS, viewport, createCanvas, imageUrl }) {
    const content = await nativeTextContent(page);
    const links = await nativePdfLinks(page, pdfDocument, viewport);
    const textBlocks = nativeBlocks(content, viewport, links);
    const operators = await page.getOperatorList();
    const graphics = graphicsOperations(OPS);
    if (!operators.fnArray.some(operation => graphics.has(operation))) return { blocks: textBlocks, canvas: null };
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    let retained = false;
    try {
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport,
            recordOperations: true, background: 'rgb(255,255,255)' }).promise;
        const regions = graphicRegions(page, operators, OPS, width, height, viewport.scale, textBlocks.length > 0, links);
        const figures = [];
        for (const bbox of regions) {
            const crop = createCanvas(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
            try {
                crop.getContext('2d').drawImage(canvas, bbox.x0, bbox.y0, crop.width, crop.height,
                    0, 0, crop.width, crop.height);
                figures.push({ type: 'image', kind: 'figure', bbox, width: crop.width, height: crop.height,
                    pageWidth: width, imageUrl: await imageUrl(crop, figures.length + 1),
                    alt: `PDF sayfa ${page.pageNumber} görseli ${figures.length + 1}` });
            } finally { crop.width = 0; crop.height = 0; }
        }
        if (!figures.length) return { blocks: textBlocks, canvas: null };
        const blocks = nativeBlocks(content, viewport, links, figures);
        retained = true;
        return { blocks, canvas };
    } finally {
        if (!retained) { canvas.width = 0; canvas.height = 0; }
    }
}
