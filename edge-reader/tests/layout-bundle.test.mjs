import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.JSZip = require('../public/libs/jszip.min.js');
const source = await readFile(new URL('../public/layout-bundle.js', import.meta.url), 'utf8');
const { imageDimensions, buildLayoutBundle, readLayoutBundle } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function png(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

test('reads PNG, GIF and SVG geometry without an image decoder', () => {
    assert.deepEqual(imageDimensions(png(1200, 1800)), { width: 1200, height: 1800, type: 'image/png' });
    const gif = Buffer.alloc(10);
    gif.write('GIF89a');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    assert.deepEqual(imageDimensions(gif), { width: 320, height: 200, type: 'image/gif' });
    assert.deepEqual(imageDimensions(Buffer.from('<svg viewBox="0 0 600 800"/>'), 'book.svg'), { width: 600, height: 800, type: 'image/svg+xml' });
    assert.deepEqual(imageDimensions(Buffer.from('<svg width="2in" viewBox="0 0 600 800"/>'), 'book.svg'), { width: 192, height: 256, type: 'image/svg+xml' });
});

test('reads ordinary, extended and lossless WebP geometry', () => {
    function webp(type, data) {
        const bytes = Buffer.alloc(20 + data.length);
        bytes.write('RIFF');
        bytes.writeUInt32LE(bytes.length - 8, 4);
        bytes.write('WEBP', 8);
        bytes.write(type, 12);
        bytes.writeUInt32LE(data.length, 16);
        data.copy(bytes, 20);
        return bytes;
    }
    const extended = Buffer.alloc(10);
    extended.writeUIntLE(1023, 4, 3);
    extended.writeUIntLE(2047, 7, 3);
    assert.deepEqual(imageDimensions(webp('VP8X', extended)), { width: 1024, height: 2048, type: 'image/webp' });
    const regular = Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 0x80, 0x02, 0xe0, 1]);
    assert.deepEqual(imageDimensions(webp('VP8 ', regular)), { width: 640, height: 480, type: 'image/webp' });
    const lossless = Buffer.alloc(5);
    lossless[0] = 0x2f;
    lossless.writeUInt32LE(799 | (599 << 14), 1);
    assert.deepEqual(imageDimensions(webp('VP8L', lossless)), { width: 800, height: 600, type: 'image/webp' });
});

test('reads JPEG SOF geometry and applies EXIF orientation', () => {
    const start = Buffer.from([0xff, 0xd8]);
    const frame = Buffer.from([0xff, 0xc2, 0, 11, 8, 0x04, 0xb0, 0x03, 0x20, 1, 1, 0x11, 0]);
    assert.deepEqual(imageDimensions(Buffer.concat([start, frame, Buffer.from([0xff, 0xd9])])), { width: 800, height: 1200, type: 'image/jpeg' });
    const exif = Buffer.alloc(36);
    exif[0] = 0xff;
    exif[1] = 0xe1;
    exif.writeUInt16BE(34, 2);
    exif.write('Exif\0\0', 4);
    exif.write('II', 10);
    exif.writeUInt16LE(42, 12);
    exif.writeUInt32LE(8, 14);
    exif.writeUInt16LE(1, 18);
    exif.writeUInt16LE(0x0112, 20);
    exif.writeUInt16LE(3, 22);
    exif.writeUInt32LE(1, 24);
    exif.writeUInt16LE(6, 28);
    assert.deepEqual(imageDimensions(Buffer.concat([start, exif, frame, Buffer.from([0xff, 0xd9])])), { width: 1200, height: 800, type: 'image/jpeg' });
});

test('rejects corrupt and truncated image headers without reading out of bounds', () => {
    for (let length = 0; length < 24; length++) assert.equal(imageDimensions(png(10, 20).subarray(0, length)), null);
    assert.equal(imageDimensions(png(0, 20)), null);
    assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), null);
    assert.equal(imageDimensions(Buffer.from('not an image'), 'cover.jpeg'), null);
});

test('round trips a compressed layout bundle while excluding image and font bytes', async () => {
    const zip = new globalThis.JSZip();
    const chapter = '<html><body><p>Türkçe metin</p><img src="../images/pic.png"/></body></html>';
    zip.file('META-INF/container.xml', '<container/>');
    zip.file('OEBPS/package.opf', '<package/>');
    zip.file('OEBPS/text/chapter.xhtml', chapter);
    zip.file('OEBPS/style.css', 'p {font-size:1em}');
    zip.file('OEBPS/images/pic.png', png(900, 1600));
    zip.file('OEBPS/images/cover.svg', '<svg width="100" height="200"/>');
    zip.file('OEBPS/font.woff2', new Uint8Array(1024));
    const progress = [];
    const { blob, index } = await buildLayoutBundle(zip, { onProgress: value => progress.push(value) });
    const restored = await readLayoutBundle(await blob.arrayBuffer());
    assert.deepEqual(restored, index);
    assert.equal(restored.texts['OEBPS/text/chapter.xhtml'], chapter);
    assert.equal(Object.keys(restored.texts).length, 4);
    assert.equal(restored.images['OEBPS/images/pic.png'].height, 1600);
    assert.equal(restored.images['OEBPS/images/cover.svg'].width, 100);
    assert.equal(restored.texts['OEBPS/images/cover.svg'], undefined);
    assert.equal(restored.texts['OEBPS/font.woff2'], undefined);
    assert.equal(progress.at(-1).processed, 7);
    assert.equal(progress.at(-1).total, 7);
    const bundled = await globalThis.JSZip.loadAsync(await blob.arrayBuffer());
    assert.deepEqual(Object.keys(bundled.files), ['manifest.json']);
    assert.equal(bundled.file('manifest.json')._data.compression.magic, '\x08\x00');
});

test('rejects traversal in archive filenames, including names JSZip sanitized', async () => {
    for (const path of ['../bad.xhtml', '/bad.xhtml', 'book/../bad.xhtml', 'book/%2e%2e/bad.xhtml', 'C:/bad.xhtml']) {
        const zip = new globalThis.JSZip();
        zip.file(path, '<html/>');
        await assert.rejects(buildLayoutBundle(zip), /dosya yolu/);
    }
    const zip = new globalThis.JSZip();
    zip.file('../bad.xhtml', '<html/>');
    const sanitized = await globalThis.JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(buildLayoutBundle(sanitized), /dosya yolu/);
});

test('validates remote manifests and rejects declared oversized entries before expansion', async () => {
    async function bundle(raw) {
        return new globalThis.JSZip().file('manifest.json', JSON.stringify(raw)).generateAsync({ type: 'uint8array' });
    }
    await assert.rejects(readLayoutBundle(await bundle({ version: 2, texts: {}, images: {} })), /biçimi/);
    await assert.rejects(readLayoutBundle(await bundle({ version: 1, texts: { '../chapter.html': 'bad' }, images: {} })), /metin kaydı/);
    await assert.rejects(readLayoutBundle(await bundle({ version: 1, texts: {}, images: { 'image.png': { width: -1, height: 2, type: 'image/png' } } })), /resim kaydı/);
    let expanded = false;
    const fake = { files: { 'book.html': { name: 'book.html', _data: { uncompressedSize: 17 * 1024 * 1024 }, async() { expanded = true; } } } };
    await assert.rejects(buildLayoutBundle(fake), /boyutu sınırı/);
    assert.equal(expanded, false);
});
