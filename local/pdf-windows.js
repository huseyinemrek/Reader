'use strict';

const { createCanvas } = require('@napi-rs/canvas');

const MAX_WINDOW_PIXELS = 1600000;
const MAX_WINDOW_EDGE = 2400;
const WHITE_BORDER = 12;

// Inspect row bands, not individual OCR glyphs. This estimates a useful input
// resolution; it never invents font sizes or changes recognized text.
function rowHeight(pixels, width, box) {
    const heights = [];
    let start = -1;
    const threshold = Math.max(2, Math.ceil((box.x1 - box.x0) * 0.008));
    for (let y = box.y0; y < box.y1; y++) {
        let ink = 0;
        for (let x = box.x0; x < box.x1; x++) {
            const offset = (y * width + x) * 4;
            if (pixels[offset + 3] && Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 190) ink++;
        }
        if (ink >= threshold && start < 0) start = y;
        if ((ink < threshold || y === box.y1 - 1) && start >= 0) {
            const height = (ink < threshold ? y : y + 1) - start;
            if (height >= 3) heights.push(height);
            start = -1;
        }
    }
    heights.sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)] || box.y1 - box.y0;
}

// Every crop is re-rendered from the PDF operator list. The page stays open until
// all layout/text/inline-formula jobs finish; no enlarged bitmap is used here.
function createSourceWindowRenderer(page, viewport, sourceCanvas) {
    const width = sourceCanvas.width, height = sourceCanvas.height;
    let pixels;
    const stats = { windows: 0, textWindows: 0, formulaWindows: 0, pixels: 0, maxPixels: 0 };
    const renderRegion = async ({ bbox, kind }) => {
        if (!bbox || !['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(bbox[key])) ||
            bbox.x0 < 0 || bbox.y0 < 0 || bbox.x1 > width || bbox.y1 > height ||
            bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) {
            throw new Error('Invalid PDF source-window coordinates.');
        }
        pixels ||= sourceCanvas.getContext('2d').getImageData(0, 0, width, height).data;
        const box = { x0: Math.floor(bbox.x0), y0: Math.floor(bbox.y0), x1: Math.ceil(bbox.x1), y1: Math.ceil(bbox.y1) };
        const cropWidth = box.x1 - box.x0, cropHeight = box.y1 - box.y0;
        const desiredHeight = kind === 'formula' ? 64 : 48;
        const maximumEdge = MAX_WINDOW_EDGE - WHITE_BORDER * 2;
        // Account for the border and ceil() in both dimensions in the area cap.
        const border = WHITE_BORDER * 2 + 1;
        const a = cropWidth * cropHeight, b = border * (cropWidth + cropHeight);
        const areaZoom = (Math.sqrt(b * b + 4 * a * (MAX_WINDOW_PIXELS - border * border)) - b) / (2 * a);
        const zoom = Math.min(4, Math.max(1, desiredHeight / rowHeight(pixels, width, box)),
            maximumEdge / Math.max(cropWidth, cropHeight), areaZoom);
        const canvas = createCanvas(Math.ceil(cropWidth * zoom) + WHITE_BORDER * 2,
            Math.ceil(cropHeight * zoom) + WHITE_BORDER * 2);
        try {
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            // Clip before translating so nearby source ink cannot enter the white
            // context border. Fractions/limits must be inside the layout window.
            context.save();
            context.beginPath();
            context.rect(WHITE_BORDER, WHITE_BORDER, cropWidth * zoom, cropHeight * zoom);
            context.clip();
            await page.render({ canvasContext: context, viewport,
                transform: [zoom, 0, 0, zoom, WHITE_BORDER - box.x0 * zoom, WHITE_BORDER - box.y0 * zoom],
                background: '#fff' }).promise;
            context.restore();
            const buffer = canvas.toBuffer('image/png');
            stats.windows++;
            stats[kind === 'formula' ? 'formulaWindows' : 'textWindows']++;
            stats.pixels += canvas.width * canvas.height;
            stats.maxPixels = Math.max(stats.maxPixels, canvas.width * canvas.height);
            return buffer;
        } finally {
            canvas.width = 0;
            canvas.height = 0;
        }
    };
    renderRegion.stats = stats;
    return renderRegion;
}

module.exports = { createSourceWindowRenderer };
