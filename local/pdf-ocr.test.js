'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
// Native-only policy must work without installing or starting a recognition model.
process.env.OCR_PYTHON = path.join(os.tmpdir(), `reader-policy-no-python-${require('crypto').randomUUID()}`);
const createPdfOcr = require('./pdf-ocr');
const createOcrQueue = require('./ocr-queue');
const { nativeFontStyle } = require('../hosting/public/pdf-fonts.mjs');
const { validBlocks } = require('../hosting/public/pdf-layout-core.mjs');

function textStream(text, y = 170) {
    return `BT /F1 5 Tf 12 ${y} Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
}
const body = 'This short digital document contains searchable native prose.';
const imageStream = 'q 200 0 0 200 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID 000000> EI Q';
const colorImageStream = 'q 80 0 0 40 40 80 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /I false /F /AHx ID FF00000000FF> EI Q';
const graphStream = '0 0 0 rg 20 20 2 100 re f 20 20 150 2 re f\n' +
    textStream('Average reward', 180) + '\n' + textStream('Time steps', 40) + '\n' + textStream('x y Q 0 1 2', 100);

function pdf(streams, fonts = ['Helvetica']) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
    const fontRefs = fonts.map(font => {
        const id = objects.length + 1;
        if (typeof font === 'string') {
            objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`);
        } else {
            const file = fs.readFileSync(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts', font.file));
            objects.push(`<< /Type /Font /Subtype /TrueType /BaseFont /${font.name} /Encoding /WinAnsiEncoding ` +
                `/FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(500).join(' ')}] /FontDescriptor ${id + 1} 0 R >>`,
                `<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [-600 -300 1400 1100] ` +
                `/ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${id + 2} 0 R >>`,
                Buffer.concat([Buffer.from(`<< /Length ${file.length} /Length1 ${file.length} >>\nstream\n`), file, Buffer.from('\nendstream')]));
        }
        return id;
    });
    const firstPageId = objects.length + 1;
    objects[1] = `<< /Type /Pages /Kids [${streams.map((_, index) => `${firstPageId + index * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`;
    for (const stream of streams) {
        const pageId = objects.length + 1;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << ${fontRefs.map((id, index) => `/F${index + 1} ${id} 0 R`).join(' ')} >> >> /Contents ${pageId + 1} 0 R >>`,
            `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    }
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets = [0];
    let length = chunks[0].length;
    objects.forEach((object, index) => {
        offsets.push(length);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]);
        chunks.push(chunk);
        length += chunk.length;
    });
    chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
    return Buffer.concat(chunks);
}

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-pdf-policy-'));
    const uploads = path.join(directory, 'uploads');
    fs.mkdirSync(uploads);
    const cleanup = [];
    t.after(async () => {
        for (const release of cleanup.reverse()) await release();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    function add(bookId, streams, fonts) {
        const fileName = `${bookId}_fixture.pdf`;
        const pdfPath = path.join(uploads, fileName);
        fs.writeFileSync(pdfPath, pdf(streams, fonts));
        return { bookId, pdfPath, record: { id: bookId, fileName, bookUrl: `/uploads/${fileName}`, computeMode: 'compute' } };
    }
    return { directory, uploads, add, cleanup };
}

function workerPage(width, height, content) {
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').fillRect(0, 0, width, height);
    const image = canvas.toBuffer('image/png').toString('base64');
    canvas.width = 0; canvas.height = 0;
    return { image, result: { width, height, engine: 'fixture-worker', device: 'cpu', modelRevision: 'isolated',
        elapsedMs: 1, qualityLimits: [], regions: [{ kind: 'text', bbox: { x0: 10, y0: 10, x1: width - 10, y1: 100 }, content }] } };
}

async function pixels(uploads, url) {
    const image = await loadImage(fs.readFileSync(path.join(uploads, url.slice('/uploads/'.length))));
    const canvas = createCanvas(image.width, image.height);
    try {
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height,
            data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    } finally {
        canvas.width = 0; canvas.height = 0;
    }
}

function pixel(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return Array.from(image.data.slice(offset, offset + 4));
}

test('native mixed and image-only pages retain raster pixels and source reading order without OCR', async t => {
    const { uploads, add, cleanup } = fixture(t);
    const service = createPdfOcr(uploads);
    cleanup.push(() => service.shutdown());
    const below = 'The paragraph follows the source illustration.';
    const source = add('native_figures', [
        `${textStream(body)}\n${colorImageStream}\n${textStream(below, 40)}`,
        colorImageStream
    ]);
    const descriptor = await service.describePdf(source);
    assert.equal(descriptor.textLayer, 'native');
    const mixed = await service.getPdfPage({ ...source, page: 1 });
    assert.equal(mixed.source, 'native');
    assert.equal(mixed.text, `${body}\n\n${below}`);
    assert.deepEqual(mixed.blocks.map(block => block.type), ['text', 'image', 'text']);
    assert.equal(mixed.blocks[0].text, body);
    assert.equal(mixed.blocks[2].text, below);
    const figure = mixed.blocks[1];
    assert.equal(validBlocks(mixed.blocks, mixed.text), true);
    assert.equal(figure.kind, 'figure');
    // Conservative upper bounds include both the rounded-up cell and its end.
    for (const [coordinate, expected] of Object.entries({ x0: 100, y0: 200, x1: 300, y1: 300 })) {
        const dimension = coordinate.startsWith('x') ? mixed.width : mixed.height;
        const quantization = Math.ceil(dimension * (coordinate.endsWith('1') ? 2 : 1) / 256) + 1;
        assert.ok(Math.abs(figure.bbox[coordinate] - expected) <= quantization,
            `${coordinate}: ${figure.bbox[coordinate]} must stay within ${quantization}px of the source ${expected}`);
    }
    assert.ok(figure.bbox.x0 <= 100 && figure.bbox.y0 <= 200 && figure.bbox.x1 >= 300 && figure.bbox.y1 >= 300);
    assert.equal(figure.width, figure.bbox.x1 - figure.bbox.x0);
    assert.equal(figure.height, figure.bbox.y1 - figure.bbox.y0);
    assert.ok(mixed.blocks[0].bbox.y1 < figure.bbox.y0);
    assert.ok(figure.bbox.y1 < mixed.blocks[2].bbox.y0);
    const crop = await pixels(uploads, figure.imageUrl);
    assert.deepEqual(pixel(crop, 50, 50), [255, 0, 0, 255]);
    assert.deepEqual(pixel(crop, 150, 50), [0, 0, 255, 255]);
    const full = await pixels(uploads, mixed.imageUrl);
    assert.deepEqual(pixel(full, 20, 250), [255, 255, 255, 255]);
    assert.deepEqual(pixel(full, 150, 250), pixel(crop, 50, 50));
    assert.deepEqual(pixel(full, 250, 250), pixel(crop, 150, 50));
    const imageOnly = await service.getPdfPage({ ...source, page: 2 });
    assert.equal(imageOnly.source, 'native');
    assert.equal(imageOnly.text, '');
    assert.equal(validBlocks(imageOnly.blocks, ''), true);
    assert.deepEqual(imageOnly.blocks.map(block => block.type), ['image']);
    const imageOnlyCrop = await pixels(uploads, imageOnly.blocks[0].imageUrl);
    assert.deepEqual(pixel(imageOnlyCrop, 50, 50), [255, 0, 0, 255]);
    assert.deepEqual(pixel(imageOnlyCrop, 150, 50), [0, 0, 255, 255]);
    const reopened = createPdfOcr(uploads);
    cleanup.push(() => reopened.shutdown());
    const nativeCachePath = path.join(uploads, 'pdf', source.bookId, `page-1-v${service.pipelineVersion}-native.json`);
    const legacyCache = JSON.parse(fs.readFileSync(nativeCachePath, 'utf8'));
    delete legacyCache.nativeLayoutVersion;
    legacyCache.text = '';
    legacyCache.blocks = [figure];
    fs.writeFileSync(nativeCachePath, JSON.stringify(legacyCache));
    assert.deepEqual((await reopened.getPdfPage({ ...source, page: 1, nativeOnly: true })).blocks, mixed.blocks);
    const cropPath = path.join(uploads, figure.imageUrl.slice('/uploads/'.length));
    fs.writeFileSync(cropPath, 'invalid PNG');
    const repaired = await reopened.getPdfPage({ ...source, page: 1, nativeOnly: true });
    assert.deepEqual(pixel(await pixels(uploads, repaired.blocks[1].imageUrl), 50, 50), [255, 0, 0, 255]);
});

test('native illustration cache stays independent of OCR output and invalidates when source pixels change', async t => {
    const { uploads, add, cleanup } = fixture(t);
    const source = add('separate_figures', [`${textStream(body)}\n${colorImageStream}`]);
    const service = createPdfOcr(uploads);
    cleanup.push(() => service.shutdown());
    const descriptor = await service.describePdf({ ...source, page: 1 });
    const native = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    const originalCrop = fs.readFileSync(path.join(uploads, native.blocks[1].imageUrl.slice('/uploads/'.length)));
    const recognized = 'Recognized page selected only by OCR policy.';
    await service.saveComputedPage({ ...source, page: 1, ...workerPage(descriptor.width, descriptor.height, recognized),
        expectedSourceVersion: descriptor.sourceVersion, isCurrent: () => true });
    service.cancelBookOcr(source.bookId);
    const nativeAgain = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    assert.deepEqual(nativeAgain.blocks, native.blocks);
    assert.deepEqual(fs.readFileSync(path.join(uploads, nativeAgain.blocks[1].imageUrl.slice('/uploads/'.length))), originalCrop);
    const ocr = await service.getPdfPage({ ...source, page: 1, nativeOnly: false, forceOcr: true, regenerate: false });
    assert.equal(ocr.source, 'ocr');
    assert.equal(ocr.text, recognized);
    assert.notEqual(ocr.imageUrl, native.imageUrl);
    assert.equal((await service.getCachedPage({ ...source, page: 1 })).text, recognized);
    fs.writeFileSync(source.pdfPath, pdf([`${textStream(body)}\n${colorImageStream.replace('FF00000000FF', '00FF00FFFF00')}`]));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(source.pdfPath, future, future);
    await assert.rejects(service.getPdfPage({ ...source, page: 1, nativeOnly: true,
        expectedSourceVersion: descriptor.sourceVersion }), error => error.statusCode === 409);
    const updated = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    const updatedCrop = await pixels(uploads, updated.blocks[1].imageUrl);
    assert.deepEqual(pixel(updatedCrop, 50, 50), [0, 255, 0, 255]);
    assert.deepEqual(pixel(updatedCrop, 150, 50), [255, 255, 0, 255]);
    assert.equal(await service.getCachedPage({ ...source, page: 1 }), null);
    await service.deleteBookCache(source.bookId);
    assert.equal(fs.existsSync(path.join(uploads, 'pdf', source.bookId)), false);
});

test('classification finds prose after long blank/image front matter, recognizes short prose and rejects graph glyphs', async t => {
    const { uploads, add, cleanup } = fixture(t);
    const service = createPdfOcr(uploads);
    cleanup.push(() => service.shutdown());
    const native = add('native', ['', imageStream, ...Array(9).fill(textStream('Front matter')), textStream(body)]);
    const shortText = 'A short native PDF.';
    const short = add('short', [textStream(shortText)]);
    const title = add('title', ['', textStream('Hello')]);
    const scanned = add('scanned', [imageStream, graphStream, '']);
    assert.equal((await service.describePdf(native)).textLayer, 'native');
    assert.equal((await service.describePdf(short)).textLayer, 'native');
    assert.equal((await service.describePdf(title)).textLayer, 'native');
    assert.equal((await service.describePdf(scanned)).textLayer, 'scanned');
    const cover = await service.getPdfPage({ ...native, page: 1 });
    assert.equal(cover.source, 'native');
    assert.equal(cover.text, '');
    assert.deepEqual(cover.blocks, []);
    assert.equal(cover.imageUrl, undefined);
    assert.equal((await service.getPdfPage({ ...short, page: 1 })).text, shortText);
    const reopened = createPdfOcr(uploads);
    cleanup.push(() => reopened.shutdown());
    assert.equal((await reopened.describePdf(native)).textLayer, 'native');
    fs.writeFileSync(native.pdfPath, pdf([graphStream]));
    assert.equal((await reopened.describePdf(native)).textLayer, 'scanned');
});

test('native extraction preserves source face names and regular, italic, oblique, bold and distinct-family text', async t => {
    const { uploads, add, cleanup } = fixture(t);
    const service = createPdfOcr(uploads);
    cleanup.push(() => service.shutdown());
    const faces = ['Helvetica', 'Times-Italic', 'Helvetica-Oblique', 'Helvetica-Bold', 'Courier'];
    const words = ['Regular', 'Italic', 'Oblique', 'Bold', 'Mono'];
    const source = add('styled_native', [`BT 12 170 Td ${words.map((word, index) => `/F${index + 1} 5 Tf (${word}) Tj ( ) Tj`).join(' ')} ET`], faces);
    const page = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    assert.equal(page.source, 'native');
    assert.equal(page.text, words.join(' '));
    const runs = page.blocks[0].runs;
    assert.deepEqual(runs.map(run => run.text.trim()), words);
    assert.deepEqual(runs.map(run => run.fontName), faces);
    assert.deepEqual(runs.map(run => run.fontStyle), ['normal', 'italic', 'oblique', 'normal', 'normal']);
    assert.ok(runs[3].fontWeight >= 600 && runs[0].fontWeight < 600);
    assert.match(runs[0].fontFamily, /sans-serif/u);
    assert.match(runs[1].fontFamily, /serif/u);
    assert.match(runs[4].fontFamily, /monospace/u);
    assert.notEqual(runs[0].fontFamily, runs[1].fontFamily);
    assert.equal(page.imageUrl, undefined);
    const fresh = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    assert.deepEqual(fresh.blocks, page.blocks);
});

test('embedded native typography comes from font tables even when source names have no style words', async t => {
    const { uploads, add, cleanup } = fixture(t);
    const service = createPdfOcr(uploads);
    cleanup.push(() => service.shutdown());
    const fonts = [
        { name: 'ABCDEF+SourceA', file: 'LiberationSans-Regular.ttf' },
        { name: 'GHIJKL+SourceB', file: 'LiberationSans-Italic.ttf' },
        { name: 'MNOPQR+SourceC', file: 'LiberationSans-Bold.ttf' }
    ];
    const source = add('embedded_native', ['BT 12 170 Td /F1 5 Tf (Regular ) Tj /F2 5 Tf (Italic ) Tj /F3 5 Tf (Bold) Tj ET'], fonts);
    const page = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    assert.equal(page.text, 'Regular Italic Bold');
    assert.deepEqual(page.blocks[0].runs.map(run => [run.fontName, run.fontStyle, run.fontWeight]), [
        ['ABCDEF+SourceA', 'normal', 400], ['GHIJKL+SourceB', 'italic', 400], ['MNOPQR+SourceC', 'normal', 700]
    ]);
    assert.equal(page.imageUrl, undefined);
});

test('native font tables take precedence over misleading face labels and retain real families', () => {
    const directory = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
    const regular = nativeFontStyle({
        name: 'Source-BoldItalic', data: new Uint8Array(fs.readFileSync(path.join(directory, 'LiberationSans-Regular.ttf')))
    });
    assert.equal(regular.fontWeight, 400);
    assert.equal(regular.fontStyle, 'normal');
    assert.match(regular.fontFamily, /Liberation Sans/u);
    const oblique = nativeFontStyle({
        name: 'Source-Oblique', data: new Uint8Array(fs.readFileSync(path.join(directory, 'LiberationSans-Italic.ttf')))
    });
    assert.equal(oblique.fontStyle, 'oblique');
});

test('unknown source metadata and synthesized CFF tables do not invent normal weight or emphasis', () => {
    for (const name of ['ABCDEF+UnspecifiedFace', 'Bookkeeper', 'Blackadder', 'LightHouse']) {
        const unknown = nativeFontStyle({ name, fallbackName: 'serif', cssFontInfo: { italicAngle: null } });
        assert.equal(Object.hasOwn(unknown, 'fontWeight'), false);
        assert.equal(Object.hasOwn(unknown, 'fontStyle'), false);
    }
    const data = new Uint8Array(92);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0x4f54544f);
    view.setUint16(4, 1);
    view.setUint32(12, 0x4f532f32);
    view.setUint32(20, 28);
    view.setUint32(24, 64);
    view.setUint16(32, 500);
    const converted = nativeFontStyle({ name: 'UnspecifiedFace', data });
    assert.equal(Object.hasOwn(converted, 'fontWeight'), false);
    assert.equal(Object.hasOwn(converted, 'fontStyle'), false);
    // The same table in a TrueType font is real weight/style metadata.
    view.setUint32(0, 0x00010000);
    const source = nativeFontStyle({ name: 'UnspecifiedFace', data });
    assert.equal(source.fontWeight, 500);
    assert.equal(source.fontStyle, 'normal');
    view.setUint16(90, 512);
    assert.equal(nativeFontStyle({ name: 'UnspecifiedFace', data }).fontStyle, 'oblique');
});

test('native extraction ignores OCR cache and OCR-enabled reads reuse only recognized output', async t => {
    const { uploads, add, cleanup } = fixture(t);
    const source = add('cached', ['', textStream(body)]);
    const service = createPdfOcr(uploads);
    cleanup.push(() => service.shutdown());
    const descriptor = await service.describePdf(source);
    const geometry = await service.describePdf({ ...source, page: 1 });
    const recognized = 'Recognized cover text, not native prose.';
    await service.saveComputedPage({ ...source, page: 1, ...workerPage(geometry.width, geometry.height, recognized),
        expectedSourceVersion: descriptor.sourceVersion, isCurrent: () => true });
    const native = await service.getPdfPage({ ...source, page: 1, nativeOnly: true });
    assert.equal(native.source, 'native');
    assert.equal(native.text, '');
    assert.deepEqual(native.blocks, []);
    const enabled = await service.getPdfPage({ ...source, page: 1, nativeOnly: false, forceOcr: true, regenerate: false });
    assert.equal(enabled.source, 'ocr');
    assert.equal(enabled.text, recognized);
    assert.equal((await service.getPdfPage({ ...source, page: 1 })).text, '');
    await assert.rejects(service.getPdfPage({ ...source, page: 1, forceOcr: true }),
        error => error.statusCode === 500);
});

async function startServer(directory, cleanup) {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const secret = 'isolated-reader-worker-secret-1234567890';
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, READER_MODE: 'vps', DISABLE_AUTH: 'true', HOST: '127.0.0.1', PORT: String(port),
            DATA_DIR: directory, WORKER_SECRET: secret, READER_ENV_FILE: path.join(directory, 'no-env'),
            OCR_PYTHON: path.join(directory, 'no-python') }
    });
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
        }
    };
    cleanup.push(stop);
    await new Promise((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(new Error(`Reader server startup timed out: ${log}`)), 15000);
        const exited = code => { clearTimeout(timer); reject(new Error(`Reader server exited ${code}: ${log}`)); };
        child.once('exit', exited);
        child.once('error', reject);
        child.stderr.on('data', chunk => { log += chunk; });
        child.stdout.on('data', chunk => {
            log += chunk;
            if (log.includes(`http://localhost:${port}`)) {
                clearTimeout(timer);
                child.off('exit', exited);
                resolve();
            }
        });
    });
    const request = async (route, { worker = false, binary = false, body, ...options } = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            ...options, body: body === undefined ? undefined : JSON.stringify(body),
            headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(worker ? { Authorization: `Bearer ${secret}` } : {}) }
        });
        return { status: response.status, body: response.status === 204 ? null :
            binary ? Buffer.from(await response.arrayBuffer()) : await response.json() };
    };
    return { request, stop };
}

test('book preferences, explicit generations and cancellation control what readers see across reopen', async t => {
    const { directory, uploads, add, cleanup } = fixture(t);
    const native = add('native_api', ['', textStream(body)]);
    const scanned = add('scanned_api', [imageStream, graphStream]);
    fs.writeFileSync(path.join(directory, 'library.json'), JSON.stringify([native.record, scanned.record]));
    // A restored pre-policy automatic cover job must be revoked before invoking a model.
    const service = createPdfOcr(uploads);
    const descriptor = await service.describePdf(native);
    await service.shutdown();
    createOcrQueue(path.join(directory, 'compute-jobs.json')).ensurePage({ ...descriptor, bookId: native.bookId, page: 1, mode: 'vps' });
    const { request, stop } = await startServer(directory, cleanup);
    const route = id => `/api/books/${id}`;
    const nativeMetadata = (await request(`${route(native.bookId)}/pdf`)).body;
    assert.equal(nativeMetadata.textLayer, 'native');
    assert.equal(nativeMetadata.automaticOcr, false);
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1`)).body.source, 'native');
    assert.deepEqual((await request(`${route(native.bookId)}/compute`)).body.counts,
        { pending: 0, processing: 0, completed: 0, failed: 0 });
    assert.equal((await request(`${route(scanned.bookId)}/pdf`)).body.automaticOcr, true);
    const automatic = await request(`${route(scanned.bookId)}/pdf/pages/1`);
    assert.equal(automatic.status, 202);
    const lease = (await request('/api/compute/jobs', { worker: true })).body;
    assert.equal(lease.id, automatic.body.jobId);
    const off = await request(`${route(scanned.bookId)}/pdf/ocr`, { method: 'POST', body: { mode: 'off' } });
    assert.equal(off.body.automaticOcr, false);
    const noOcrPage = (await request(`${route(scanned.bookId)}/pdf/pages/1`)).body;
    assert.equal(noOcrPage.source, 'native');
    assert.deepEqual(noOcrPage.blocks.map(block => block.type), ['image']);
    const servedFigure = await request(noOcrPage.blocks[0].imageUrl, { binary: true });
    assert.equal(servedFigure.status, 200);
    const decodedFigure = await loadImage(servedFigure.body);
    const figureCanvas = createCanvas(decodedFigure.width, decodedFigure.height);
    try {
        const context = figureCanvas.getContext('2d');
        context.drawImage(decodedFigure, 0, 0);
        assert.deepEqual(Array.from(context.getImageData(250, 250, 1, 1).data), [0, 0, 0, 255]);
    } finally {
        figureCanvas.width = 0; figureCanvas.height = 0;
    }
    assert.equal((await request(`${route(scanned.bookId)}/pdf/pages/1?ocrJob=${lease.id}`)).status, 410);
    assert.equal((await request(`/api/compute/jobs/${lease.id}/complete`, { worker: true, method: 'POST',
        body: { leaseToken: lease.leaseToken } })).status, 410);
    assert.equal((await request('/api/compute/jobs', { worker: true })).status, 204);
    await request(`${route(native.bookId)}/pdf/ocr`, { method: 'POST', body: { mode: 'off' } });
    const manual = await request(`${route(native.bookId)}/pdf/pages/1?ocr=1`);
    assert.equal(manual.status, 202);
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1?ocr=1`)).body.jobId, manual.body.jobId);
    const manualLease = (await request('/api/compute/jobs', { worker: true })).body;
    const recognized = 'Explicitly recognized cover for the reader.';
    const completion = await request(`/api/compute/jobs/${manualLease.id}/complete`, { worker: true, method: 'POST',
        body: { leaseToken: manualLease.leaseToken, ...workerPage(500, 500, recognized) } });
    assert.equal(completion.status, 200);
    const polled = await request(`${route(native.bookId)}/pdf/pages/1?ocrJob=${manualLease.id}`);
    assert.equal(polled.body.source, 'ocr');
    assert.equal(polled.body.text, recognized);
    const nextPage = (await request(`${route(native.bookId)}/pdf/pages/2`)).body;
    assert.equal(nextPage.source, 'native');
    assert.equal(nextPage.text, body);
    assert.equal((await request(`${route(native.bookId)}/pdf`)).body.ocrMode, 'off');
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1`)).body.text, '');
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1?ocr=0`)).body.text, '');
    const regenerated = await request(`${route(native.bookId)}/pdf/pages/1?ocr=1`);
    assert.equal(regenerated.status, 202);
    assert.notEqual(regenerated.body.jobId, manualLease.id);
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1?ocrJob=${manualLease.id}`)).status, 410);
    await request(`${route(native.bookId)}/pdf/ocr`, { method: 'POST', body: { mode: 'off' } });
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1?ocrJob=${regenerated.body.jobId}`)).status, 410);
    await request(`${route(native.bookId)}/pdf/ocr`, { method: 'POST', body: { mode: 'on' } });
    assert.equal((await request(`${route(native.bookId)}/pdf/pages/1`)).body.text, recognized);
    await request(`${route(native.bookId)}/pdf/ocr`, { method: 'POST', body: { mode: 'off' } });
    const batch = await request(`${route(native.bookId)}/compute`, { method: 'POST', body: { mode: 'compute', fromPage: 2, toPage: 2 } });
    assert.equal(batch.body.ocrMode, 'on');
    assert.equal(batch.body.automaticOcr, true);
    assert.equal((await request(`${route(native.bookId)}/pdf`)).body.ocrMode, 'on');
    await request(`${route(native.bookId)}/pdf/ocr`, { method: 'POST', body: { mode: 'off' } });
    await stop();
    const reopened = await startServer(directory, cleanup);
    assert.equal((await reopened.request(`${route(native.bookId)}/pdf`)).body.ocrMode, 'off');
    assert.equal((await reopened.request(`${route(native.bookId)}/pdf/pages/1`)).body.text, '');
    assert.equal((await reopened.request(`${route(native.bookId)}/pdf/pages/1?ocr=0`)).body.source, 'native');
    assert.equal((await reopened.request(`${route(native.bookId)}/compute`)).body.counts.pending, 0);
    await reopened.stop();
});
