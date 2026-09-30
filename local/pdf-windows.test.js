'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { createSourceWindowRenderer } = require('./pdf-windows');

function vectorPdf() {
    const stream = '0 0 0 rg 50 540 .25 10 re f 60 540 2 10 re f\n1 0 0 rg 30 540 9 10 re f 80 540 9 10 re f';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << >> /Contents 4 0 R >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let data = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(data.length);
        data += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const start = data.length;
    data += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return new Uint8Array(Buffer.from(data));
}

async function sourceWindows(run) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: vectorPdf() });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const source = createCanvas(600, 600);
    try {
        await page.render({ canvasContext: source.getContext('2d'), viewport }).promise;
        await run(createSourceWindowRenderer(page, viewport, source));
    } finally {
        source.width = 0; source.height = 0;
        await task.destroy();
    }
}

async function windowPixels(buffer) {
    const image = await loadImage(buffer);
    const canvas = createCanvas(image.width, image.height);
    try {
        canvas.getContext('2d').drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height,
            pixels: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data };
    } finally { canvas.width = 0; canvas.height = 0; }
}

test('source windows preserve subpixel vectors and exclude neighboring ink from the white context', async () => {
    await sourceWindows(async render => {
        const { width, height, pixels } = await windowPixels(await render({
            bbox: { x0: 40, y0: 40, x1: 80, y1: 80 }, kind: 'text' }));
        let black = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                if (x < 12 || y < 12 || x >= width - 12 || y >= height - 12) {
                    assert.equal(pixels[i], 255);
                    assert.equal(pixels[i + 1], 255);
                    assert.equal(pixels[i + 2], 255);
                }
                assert.equal(pixels[i], pixels[i + 1], 'red neighboring vectors must not enter this window');
                if (x === 52 && pixels[i] < 30) black++;
            }
        }
        // A .25-pixel source stroke must become a black 1-pixel stroke, not an
        // enlarged gray sample from the original page bitmap.
        assert.ok(black >= 30, `missing high-resolution vector stroke (${black} black pixels)`);
    });
});

test('large windows respect physical pixel limits and invalid source bounds fail', async () => {
    await sourceWindows(async render => {
        const image = await loadImage(await render({ bbox: { x0: 0, y0: 0, x1: 600, y1: 600 }, kind: 'formula' }));
        assert.ok(image.width <= 2400 && image.height <= 2400);
        assert.ok(image.width * image.height <= 1600000);
        await assert.rejects(render({ bbox: { x0: -1, y0: 0, x1: 80, y1: 80 }, kind: 'text' }), /coordinates/);
        await assert.rejects(render({ bbox: { x0: 40, y0: 40, x1: 40, y1: 80 }, kind: 'text' }), /coordinates/);
    });
});
