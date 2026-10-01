'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const { makeEpub, makePdfGraphics } = require('./helpers/reader-fixtures.cjs');
const { startHosting, configureHosting, seedHosting, hostingLibrary } = require('./helpers/reader-hosting.cjs');
const root = path.resolve(__dirname, '..');
const requireLocal = createRequire(path.join(root, 'local/package.json'));
const { createCanvas, loadImage } = requireLocal('@napi-rs/canvas');
let browser;
let fixtureDirectory;
let epubFixture;
let pdfGraphicsFixture;
let uploadFixtures;

before(async () => {
    fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-generated-fixtures-'));
    epubFixture = await makeEpub(fixtureDirectory);
    pdfGraphicsFixture = await makePdfGraphics(fixtureDirectory);
    uploadFixtures = await Promise.all([
        makeEpub(fixtureDirectory, 'First background journey'),
        makeEpub(fixtureDirectory, 'Second background journey')
    ]);
    const { default: puppeteer } = await import(pathToFileURL(requireLocal.resolve('puppeteer')).href);
    // Cold navigations must release old emulator RPCs, not freeze them in BFCache.
    browser = await puppeteer.launch({ headless: true, args: ['--disable-features=BackForwardCache'] });
});
after(async () => {
    try { await browser?.close(); }
    finally { if (fixtureDirectory) await fs.rm(fixtureDirectory, { recursive: true, force: true }); }
});

async function availablePort() {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

async function startReader(mode, t) {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-regression-'));
    let child;
    t.after(async () => {
        try {
            if (child?.pid && child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                const forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
                try { await exited; } finally { clearTimeout(forceStop); }
            }
        } finally {
            await fs.rm(data, { recursive: true, force: true });
        }
    });
    await fs.mkdir(path.join(data, 'uploads'));
    await fs.writeFile(path.join(data, 'empty.env'), '');
    const books = [];
    for (const [id, fixture] of [
        ['book_test_typography', 'typography-outline.pdf'],
        ['book_test_no_outline', 'without-outline.pdf']
    ]) {
        const fileName = `${id}_${fixture}`;
        await fs.copyFile(path.join(__dirname, 'fixtures', fixture), path.join(data, 'uploads', fileName));
        books.push({ id, title: fixture, fileName, userId: 'local_user',
            bookUrl: '/uploads/' + fileName, coverUrl: null, ocrMode: 'off',
            // A stale library record must not replace the source PDF's bookmarks.
            toc: [{ title: 'Stale library bookmark', link: '#unrelated' }] });
    }
    const epubName = 'book_test_epub_generated.epub';
    await fs.copyFile(epubFixture.file, path.join(data, 'uploads', epubName));
    books.push({ id: 'book_test_epub', title: epubFixture.title, fileName: epubName,
        userId: 'local_user', bookUrl: '/uploads/' + epubName, coverUrl: null, toc: [] });
    const graphicsName = 'book_test_pdf_graphics_generated.pdf';
    await fs.copyFile(pdfGraphicsFixture.file, path.join(data, 'uploads', graphicsName));
    books.push({ id: 'book_test_pdf_graphics', title: pdfGraphicsFixture.title, fileName: graphicsName,
        userId: 'local_user', bookUrl: '/uploads/' + graphicsName, coverUrl: null, ocrMode: 'off', toc: [] });
    await fs.writeFile(path.join(data, 'library.json'), JSON.stringify(books));
    const port = await availablePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, mode, 'server.js')], {
        cwd: root,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), READER_MODE: mode,
            DATA_DIR: data, READER_ENV_FILE: path.join(data, 'empty.env'), DISABLE_AUTH: 'true',
            OCR_PYTHON: path.join(data, 'no-ocr-runtime') },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    let spawnError;
    child.on('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-32768); });
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Reader exited:\n' + logs);
        try {
            const response = await fetch(base + '/api/runtime-config', { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                const runtime = await response.json();
                assert.equal(runtime.mode, mode);
                assert.equal(runtime.authEnabled, false, 'Only the isolated loopback instance may disable auth');
                return base;
            }
        } catch (error) { if (error instanceof assert.AssertionError) throw error; }
        await delay(50);
    }
    throw new Error('Reader did not become ready:\n' + logs);
}

async function openPdf(page, base, id = 'book_test_typography', number = 2) {
    await page.goto(`${base}/book/${id}?page=${number}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(number => {
        const section = document.querySelector('.pdf-page');
        return section?.dataset.pageIndex === String(number) &&
            section.querySelector('.pdf-page-text')?.textContent.includes(`page ${number}.`);
    }, { timeout: 20000 }, number);
}

async function openSidebar(page, name) {
    // A closing panel still covers the toolbar until its transition finishes.
    await page.waitForFunction(id => {
        const panel = document.getElementById(id);
        return panel.getAttribute('aria-hidden') === 'true' &&
            getComputedStyle(panel).visibility === 'hidden';
    }, { timeout: 5000 }, `${name}-sidebar`);
    await page.click(`#${name}-toggle`);
    await page.waitForFunction(id => {
        const panel = document.getElementById(id);
        const bounds = panel.getBoundingClientRect();
        return panel.getAttribute('aria-hidden') === 'false' &&
            bounds.left >= 0 && bounds.right <= innerWidth;
    }, { timeout: 5000 }, `${name}-sidebar`);
}

function visibleTypography() {
    const spans = Array.from(document.querySelectorAll('.pdf-page-text .pdf-text-block span'));
    const find = text => {
        const span = spans.find(element => element.textContent.includes(text));
        if (!span) throw new Error('Missing rendered text: ' + text);
        const style = getComputedStyle(span);
        return { family: style.fontFamily, style: style.fontStyle,
            weight: Number(style.fontWeight), size: parseFloat(style.fontSize), color: style.color };
    };
    return { regular: find('He whispered'), italic: find('remember me'),
        following: find('then fell silent'), bold: find('deliberately bold'),
        mono: find('voice in monospace'), sans: find('sans-serif italic'),
        larger: find('larger heading'), smaller: find('smaller footnote') };
}

async function waitForPages(page) {
    await page.waitForFunction(() => {
        const input = document.getElementById('page-jump-input');
        return input && !input.disabled && Number(input.max) > 1 &&
            getComputedStyle(document.getElementById('loading-overlay')).display === 'none';
    }, { timeout: 30000 });
    return page.$eval('#page-jump-input', input => Number(input.max));
}

async function jumpTo(page, number) {
    await page.click('#paged-indicator');
    await page.waitForFunction(() => document.getElementById('page-jump-modal').open);
    await page.$eval('#page-jump-input', (input, value) => { input.value = String(value); }, number);
    await page.click('#page-jump-submit');
    await page.waitForFunction(number => !document.getElementById('page-jump-modal').open &&
        Number(new URLSearchParams(location.search).get('page')) === number &&
        !document.getElementById('page-jump-input').disabled, { timeout: 20000 }, number);
}

function visiblePassage() {
    const bounds = document.getElementById('book-viewport').getBoundingClientRect();
    for (const paragraph of document.querySelectorAll('#book-content p[id]')) {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        if (Array.from(range.getClientRects()).some(rect => rect.right > bounds.left + 5 &&
            rect.left < bounds.right - 5 && rect.bottom > bounds.top && rect.top < bounds.bottom)) {
            return { chapter: paragraph.id.split('-')[0], index: Number(paragraph.id.split('-')[1]) };
        }
    }
    throw new Error('No source passage is visible on the current page');
}

async function visibleIllustration(page, name, rgb) {
    await page.waitForFunction(({ name, rgb }) => {
        const image = document.querySelector(`img[alt="${name} illustration"]`);
        if (!image?.complete || !image.naturalWidth) return false;
        const box = image.getBoundingClientRect();
        const viewport = document.getElementById('book-viewport').getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0 && box.left < viewport.right && box.right > viewport.left &&
            box.top < viewport.bottom && box.bottom > viewport.top)) return false;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 128, 128, 1, 1, 0, 0, 1, 1);
        const pixel = ctx.getImageData(0, 0, 1, 1).data;
        return rgb.every((channel, index) => pixel[index] === channel) && pixel[3] === 255;
    }, { timeout: 20000 }, { name, rgb });
    const pixel = await page.$eval(`img[alt="${name} illustration"]`, image => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 128, 128, 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    assert.deepEqual(pixel, [...rgb, 255], 'The visible illustration must contain real source pixels, not a dimension placeholder');
}

function nativeGraphicsPixels() {
    const section = document.querySelector('.pdf-page');
    const images = Array.from(section?.querySelectorAll('.pdf-page-text img') || []);
    if (!images.length || images.some(image => !image.complete || !image.naturalWidth)) return null;
    const palette = [[232, 32, 32], [32, 64, 232], [32, 200, 64]];
    const figures = images.map(image => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const colors = palette.map(() => ({ count: 0, x: 0, y: 0 }));
        for (let offset = 0; offset < pixels.length; offset += 4) {
            const color = palette.findIndex(rgb => rgb.every((channel, index) =>
                Math.abs(channel - pixels[offset + index]) <= 3) && pixels[offset + 3] === 255);
            if (color < 0) continue;
            colors[color].count++;
            colors[color].x += (offset / 4) % canvas.width;
            colors[color].y += Math.floor(offset / 4 / canvas.width);
        }
        for (const color of colors) {
            color.x /= color.count || 1;
            color.y /= color.count || 1;
        }
        const box = image.getBoundingClientRect();
        const viewport = document.getElementById('book-viewport').getBoundingClientRect();
        return { colors, top: box.top, bottom: box.bottom, width: box.width, height: box.height,
            visible: box.width > 0 && box.height > 0 && box.left < viewport.right && box.right > viewport.left &&
                box.top < viewport.bottom && box.bottom > viewport.top };
    });
    if (!figures.some(figure => figure.visible && figure.colors[0].count > 20 && figure.colors[1].count > 20)) return null;
    const paragraphs = Array.from(section.querySelectorAll('.pdf-text-block'));
    const above = paragraphs.find(element => element.textContent.includes('Prose above'));
    const below = paragraphs.find(element => element.textContent.includes('Prose below'));
    return { page: Number(section.dataset.pageIndex), figures,
        aboveBottom: above?.getBoundingClientRect().bottom ?? null,
        belowTop: below?.getBoundingClientRect().top ?? null };
}

async function observeNativeGraphics(page, number, prose = false) {
    await page.waitForFunction(nativeGraphicsPixels, { timeout: 30000 });
    const result = await page.evaluate(nativeGraphicsPixels);
    assert.equal(result.page, number, 'Reading must remain on the requested source page');
    if (prose) {
        assert.notEqual(result.aboveBottom, null);
        assert.notEqual(result.belowTop, null);
        assert.ok(result.figures.every(figure => figure.top >= result.aboveBottom - 1 &&
            figure.bottom <= result.belowTop + 1), 'Source figures must stay between the prose above and below');
        assert.ok(result.figures.some(figure => figure.colors[2].count > 20),
            'The native reader must preserve the separate green vector graphic');
        assert.ok(result.figures.some(({ colors }) => colors[0].count > 20 && colors[1].count > 20 &&
            colors[0].x < colors[1].x - 5), 'The main raster must preserve its red-left, blue-right source orientation');
        assert.ok(result.figures.some(({ colors }) => colors[0].count > 20 && colors[1].count > 20 &&
            Math.abs(colors[0].y - colors[1].y) > 5), 'The clipped raster must preserve its source rotation');
    }
    return result.figures.map(figure => figure.colors.map(color => color.count));
}

async function readLibrary(page, base, mode) {
    if (mode === 'hosting') return hostingLibrary(page);
    const response = await fetch(base + '/api/books');
    assert.equal(response.status, 200);
    return response.json();
}

async function waitForLibrary(page, base, mode, predicate) {
    const deadline = Date.now() + 60000;
    let books;
    do {
        books = await readLibrary(page, base, mode);
        if (predicate(books)) return books;
        const errors = await page.$$eval('.reader-upload-item[data-status="failed"] .reader-upload-error',
            elements => elements.map(element => element.textContent));
        assert.deepEqual(errors, [], 'A real upload failed');
        await delay(100);
    } while (Date.now() < deadline);
    assert.fail('The uploaded books were not committed to the isolated library: ' + JSON.stringify(books));
}

for (const mode of ['local', 'vps', 'hosting']) {
    test(`${mode}: real reader parity regressions`, { timeout: 420000 }, async t => {
        const runtime = mode === 'hosting' ? await startHosting(t) : null;
        const base = runtime?.base || await startReader(mode, t);
        const context = await browser.createBrowserContext();
        t.after(() => context.close());
        const page = await context.newPage();
        await page.setViewport({ width: 1400, height: 960 });
        if (runtime) await configureHosting(page, runtime);
        await page.evaluateOnNewDocument(() => {
            if (!localStorage.getItem('edgeReaderSettings')) {
                localStorage.setItem('edgeReaderSettings', JSON.stringify({
                    readingMode: 'paged', pdfLayout: 'text-only', fontFamily: 'original',
                    fontSize: '28', lineHeight: '2.0', textColor: '#9ddeac'
                }));
            }
        });
        if (runtime) await seedHosting(page, runtime, epubFixture, pdfGraphicsFixture);

        await t.test('mixed faces preserve word-level emphasis and relative sizes', async () => {
            await openPdf(page, base);
            const runs = await page.evaluate(visibleTypography);
            assert.equal(runs.regular.style, 'normal');
            assert.equal(runs.italic.style, 'italic');
            assert.equal(runs.following.style, 'normal', 'Italic must not leak into the following words');
            assert.ok(runs.bold.weight >= 600 && runs.regular.weight < 600);
            assert.match(runs.mono.family, /monospace/i);
            assert.match(runs.sans.family, /sans-serif/i);
            assert.match(runs.sans.style, /italic|oblique/);
            assert.ok(Math.abs(runs.larger.size / runs.regular.size - 22 / 14) < 0.01);
            assert.ok(Math.abs(runs.smaller.size / runs.regular.size - 10 / 14) < 0.01);
        });

        await t.test('font, color and size overrides retain emphasis and size ratios after reopening', async () => {
            await openPdf(page, base);
            await openSidebar(page, 'settings');
            await page.select('#font-family-select', "'Inter', sans-serif");
            await page.$eval('#font-size-slider', element => {
                element.focus(); element.value = '32'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.$eval('#text-color-picker', element => {
                element.value = '#e8c18a'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.$eval('#side-padding-slider', element => {
                element.value = '70'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.click('#settings-close');
            const verify = async () => {
                await page.waitForFunction(() => {
                    const span = Array.from(document.querySelectorAll('.pdf-text-block span'))
                        .find(element => element.textContent.includes('He whispered'));
                    return span && getComputedStyle(span).fontSize === '32px' &&
                        getComputedStyle(span).color === 'rgb(232, 193, 138)';
                }, { timeout: 10000 });
                const runs = await page.evaluate(visibleTypography);
                for (const run of Object.values(runs)) {
                    assert.match(run.family, /Inter/);
                    assert.equal(run.color, 'rgb(232, 193, 138)');
                }
                assert.equal(runs.italic.style, 'italic');
                assert.equal(runs.following.style, 'normal');
                assert.ok(runs.bold.weight >= 600 && runs.regular.weight < 600);
                assert.ok(Math.abs(runs.larger.size / runs.regular.size - 22 / 14) < 0.01);
                assert.ok(Math.abs(runs.smaller.size / runs.regular.size - 10 / 14) < 0.01);
                assert.equal(await page.$eval('#book-content', el => getComputedStyle(el).paddingLeft), '70px');
            };
            await verify();
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openPdf(page, base);
            await verify();
        });

        await t.test('nested source bookmarks navigate both named and page-reference destinations', async () => {
            await openPdf(page, base);
            await openSidebar(page, 'toc');
            const outline = await page.$$eval('#toc-list a', links => links.map(link => ({
                title: link.textContent, page: Number(link.dataset.pdfPage),
                parent: link.closest('ul').parentElement.querySelector(':scope > a')?.textContent ?? null
            })));
            assert.deepEqual(outline, [
                { title: 'First chapter', page: 2, parent: null },
                { title: 'Nested section', page: 3, parent: 'First chapter' },
                { title: 'Last chapter', page: 4, parent: null }
            ]);
            await page.click('#toc-list a[data-pdf-page="3"]');
            await page.waitForFunction(() => document.querySelector('.pdf-page-text')?.textContent.includes('page 3.'),
                { timeout: 10000 });
            await openSidebar(page, 'toc');
            await page.click('#toc-list a[data-pdf-page="4"]');
            await page.waitForFunction(() => document.querySelector('.pdf-page-text')?.textContent.includes('page 4.'),
                { timeout: 10000 });
        });

        await t.test('native PDF links are clickable in text and source while linked rows stay separate', async () => {
            await openPdf(page, base, 'book_test_typography', 1);
            await page.waitForFunction(() => document.querySelectorAll('#pdf-text-1 a.pdf-source-link').length === 3,
                { timeout: 10000 });
            const links = await page.$$eval('#pdf-text-1 a.pdf-source-link', anchors => anchors.map(anchor => ({
                text: anchor.textContent.trim(), page: Number(anchor.dataset.pdfPage) || null,
                href: anchor.href, target: anchor.target, rel: anchor.rel,
                paragraph: anchor.closest('.pdf-text-block')?.textContent.trim(),
                decoration: getComputedStyle(anchor).textDecorationLine
            })));
            assert.deepEqual(links.map(({ text, page: destination, paragraph }) => [text, destination, paragraph]), [
                ['First linked chapter', 2, 'First linked chapter'],
                ['Second linked chapter', 3, 'Second linked chapter'],
                ['Project website', null, 'Project website']
            ]);
            assert.ok(links.every(link => link.decoration.includes('underline')));
            assert.equal(links[2].href, 'https://example.org/');
            assert.equal(links[2].target, '_blank');
            assert.match(links[2].rel, /noopener/u);

            await page.click('#pdf-text-1 a[data-pdf-page="2"]');
            await page.waitForFunction(() => Number(new URLSearchParams(location.search).get('page')) === 2 &&
                document.querySelector('#pdf-text-2')?.textContent.includes('page 2.'), { timeout: 10000 });

            await openPdf(page, base, 'book_test_typography', 1);
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-right');
            await page.click('#settings-close');
            await page.waitForFunction(() => document.querySelectorAll('.pdf-link-layer a').length === 3,
                { timeout: 10000 });
            await page.locator('.pdf-link-layer a[data-pdf-page="3"]').click();
            await page.waitForFunction(() => Number(new URLSearchParams(location.search).get('page')) === 3 &&
                document.querySelector('#pdf-text-3')?.textContent.includes('page 3.'), { timeout: 10000 });
        });

        await t.test('PDF without bookmarks never displays stale library contents', async () => {
            await openPdf(page, base, 'book_test_no_outline', 1);
            await openSidebar(page, 'toc');
            assert.equal(await page.$$eval('#toc-list a', links => links.length), 0);
        });

        await t.test('native PDF illustrations preserve source pixels, order and image-only pages without OCR', async () => {
            await page.setViewport({ width: 1400, height: 960 });
            await openPdf(page, base);
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-only');
            await page.$eval('#font-size-slider', element => {
                element.value = '20'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.click('#settings-close');
            await page.goto(`${base}/book/book_test_pdf_graphics?page=1`, { waitUntil: 'domcontentloaded' });
            await waitForPages(page);
            assert.equal(await page.$('.pdf-original-viewport'), null);
            const originalFigures = await observeNativeGraphics(page, 1, true);
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-right');
            await page.click('#settings-close');
            await page.waitForFunction(() => {
                const colors = [[232, 32, 32], [32, 64, 232], [32, 200, 64]];
                const found = colors.map(() => false);
                for (const canvas of document.querySelectorAll('.pdf-original-surface canvas')) {
                    if (!canvas.width || !canvas.height) continue;
                    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    for (let offset = 0; offset < pixels.length; offset += 4) {
                        colors.forEach((rgb, index) => {
                            if (rgb.every((channel, channelIndex) =>
                                Math.abs(channel - pixels[offset + channelIndex]) <= 3) && pixels[offset + 3] === 255) found[index] = true;
                        });
                        if (found.every(Boolean)) return true;
                    }
                }
                return false;
            }, { timeout: 20000 });
            assert.deepEqual(await observeNativeGraphics(page, 1, true), originalFigures,
                'Opening source comparison must neither duplicate nor alter the extracted illustrations');
            assert.equal(Number(new URL(page.url()).searchParams.get('page')), 1);
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-only');
            await page.click('#settings-close');
            await page.waitForFunction(() => !document.querySelector('.pdf-original-viewport'));
            assert.deepEqual(await observeNativeGraphics(page, 1, true), originalFigures);
            await jumpTo(page, 2);
            const imageOnlyFigures = await observeNativeGraphics(page, 2);
            assert.equal(await page.$('.pdf-original-viewport'), null,
                'An image-only source page must work in native reading without the source viewer or OCR');
            await page.hover('#reader-nav-hit-area');
            await page.waitForFunction(() => getComputedStyle(document.getElementById('reader-nav')).visibility === 'visible');
            await page.click('#back-to-library');
            await page.waitForFunction(() => getComputedStyle(document.getElementById('reader-view')).display === 'none');
            await waitForLibrary(page, base, mode, books =>
                Number(books.find(book => book.id === 'book_test_pdf_graphics')?.readerPosition?.globalPage) === 2);
            await page.goto(`${base}/book/book_test_pdf_graphics`, { waitUntil: 'domcontentloaded' });
            await waitForPages(page);
            assert.deepEqual(await observeNativeGraphics(page, 2), imageOnlyFigures,
                'Reopening must restore the nonblank image-only source page');
        });

        await t.test('layout bundle paginates source text without the archive or later illustration', async () => {
            await openPdf(page, base);
            await openSidebar(page, 'settings');
            await page.select('#font-family-select', 'original');
            await page.click('[data-theme="original"]');
            await page.$eval('#font-size-slider', element => {
                element.value = '24'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.click('#settings-close');
            const book = (await readLibrary(page, base, mode)).find(book => book.id === 'book_test_epub');
            const originalPath = new URL(book.bookUrl, base).pathname;
            const requests = [];
            const mediaResponses = [];
            const onRequest = request => requests.push({
                url: request.url(), method: request.method(), range: request.headers().range
            });
            const onResponse = response => {
                const url = new URL(response.url());
                if (url.pathname === originalPath && url.searchParams.get('alt') === 'media') {
                    mediaResponses.push({ status: response.status(), range: response.headers()['content-range'] });
                }
            };
            page.on('request', onRequest);
            page.on('response', onResponse);
            try {
                await page.goto(`${base}/book/book_test_epub?ch=0&local=0`, { waitUntil: 'domcontentloaded' });
                const total = await waitForPages(page);
                assert.ok(total >= 8, 'The fixture must span several columns in both chapters');
                await visibleIllustration(page, 'First', [232, 32, 32]);
                if (mode !== 'hosting') {
                    const decoration = await page.$('.css-illustration');
                    const box = await decoration.boundingBox();
                    const screenshot = await page.screenshot({ type: 'png', clip: {
                        x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2), width: 1, height: 1
                    } });
                    const canvas = createCanvas(1, 1);
                    const context = canvas.getContext('2d');
                    context.drawImage(await loadImage(screenshot), 0, 0);
                    assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], [232, 32, 32, 255],
                        'Server-backed reading must retain genuine CSS illustrations without fetching later-chapter decorations during measurement');
                }
                const source = await page.evaluate(() => {
                    const style = selector => {
                        const element = document.querySelector(selector);
                        const css = getComputedStyle(element);
                        return { text: element.textContent, family: css.fontFamily, color: css.color,
                            size: parseFloat(css.fontSize), style: css.fontStyle, weight: Number(css.fontWeight) };
                    };
                    return { plain: style('.source-runs'), italic: style('.source-runs em'),
                        bold: style('.source-runs strong'), large: style('p.large'), small: style('p.small'),
                        paragraph: style('p[id="First-0"]') };
                });
                assert.match(source.paragraph.text, /First passage 00.*quiet traveller/);
                assert.match(source.plain.family, /Georgia/i);
                assert.equal(source.plain.color, 'rgb(89, 50, 25)');
                assert.equal(source.italic.style, 'italic');
                assert.ok(source.bold.weight >= 600 && source.plain.weight < 600);
                assert.ok(Math.abs(source.large.size / source.plain.size - 21 / 14) < 0.02);
                assert.ok(Math.abs(source.small.size / source.plain.size - 10 / 14) < 0.02);
                assert.ok(requests.some(request => mode === 'hosting'
                    ? new URL(request.url).pathname === new URL(book.layoutUrl).pathname
                    : new URL(request.url).pathname === '/api/books/book_test_epub/layout'),
                'Pagination must consume the served layout bundle');
                if (mode === 'hosting') {
                    const original = requests.filter(request => request.method === 'GET' &&
                        new URL(request.url).pathname === originalPath &&
                        new URL(request.url).searchParams.get('alt') === 'media');
                    assert.ok(original.length > 0, 'The first visible illustration must read real archive bytes');
                    let laterBytes = 0;
                    for (const request of original) {
                        assert.ok(request.range, 'The original archive must not be downloaded wholesale');
                        const match = /^bytes=(\d*)-(\d*)$/.exec(request.range);
                        assert.ok(match, 'Archive reads must have a bounded byte range');
                        const start = match[1] ? Number(match[1]) : epubFixture.bytes.length - Number(match[2]);
                        const end = match[1] ? (match[2] ? Number(match[2]) : epubFixture.bytes.length - 1) : epubFixture.bytes.length - 1;
                        assert.ok(end - start + 1 < epubFixture.bytes.length);
                        laterBytes += Math.max(0, Math.min(end, epubFixture.laterImage.end) -
                            Math.max(start, epubFixture.laterImage.start) + 1);
                    }
                    assert.ok(laterBytes < epubFixture.laterImage.end - epubFixture.laterImage.start + 1,
                        'Page counting must not fetch the complete later illustration');
                    assert.ok(mediaResponses.length > 0 && mediaResponses.every(response => response.status === 206 && response.range),
                        'The real storage emulator must honor range reads rather than send the full archive');
                } else {
                    assert.equal(requests.some(request => new URL(request.url).pathname === originalPath), false,
                        'Server-backed pagination must never download the original EPUB');
                    assert.equal(requests.some(request => decodeURIComponent(new URL(request.url).pathname)
                        .endsWith('/images/later.png')), false, 'Measuring the later chapter must not fetch its illustration');
                }
                await jumpTo(page, Math.floor(total / 2) + 1);
                while (new URL(page.url()).searchParams.get('ch') === '0') {
                    await jumpTo(page, Number(new URL(page.url()).searchParams.get('page')) + 1);
                }
                const laterLocation = new URL(page.url()).searchParams;
                await jumpTo(page, Number(laterLocation.get('page')) - Number(laterLocation.get('local')));
                await visibleIllustration(page, 'Later', [32, 64, 232]);
                await jumpTo(page, total);
                const last = await page.evaluate(visiblePassage);
                assert.equal(last.chapter, 'Later');
                assert.ok(last.index >= 45, 'A later numbered page must show late source text, not the first column');
            } finally {
                page.off('request', onRequest);
                page.off('response', onResponse);
            }
        });

        await t.test('EPUB resize, font changes and reopening preserve logical position and percentage', async () => {
            await page.goto(`${base}/book/book_test_epub?ch=0&local=0`, { waitUntil: 'domcontentloaded' });
            const total = await waitForPages(page);
            await jumpTo(page, Math.floor(total / 4) + 1);
            const initial = await page.evaluate(visiblePassage);
            assert.equal(initial.chapter, 'First');
            assert.ok(initial.index > 10, 'The position fixture must be well beyond the beginning');
            await page.setViewport({ width: 600, height: 960 });
            await page.waitForFunction(total => {
                const input = document.getElementById('page-jump-input');
                return !input.disabled && Number(input.max) !== total;
            }, { timeout: 30000 }, total);
            await waitForPages(page);
            const resized = await page.evaluate(visiblePassage);
            assert.equal(resized.chapter, initial.chapter);
            assert.ok(Math.abs(resized.index - initial.index) <= 8, 'Resizing must retain the source passage, not reset to the beginning');
            const resizedPages = await waitForPages(page);
            await openSidebar(page, 'settings');
            await page.select('#font-family-select', "'Inter', sans-serif");
            await page.click('[data-theme="light"]');
            await page.$eval('#font-size-slider', element => {
                element.value = '32'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.$eval('#text-color-picker', element => {
                element.value = '#e8c18a'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.click('#settings-close');
            await page.waitForFunction(previous => {
                const input = document.getElementById('page-jump-input');
                return !input.disabled && Number(input.max) !== previous;
            }, { timeout: 30000 }, resizedPages);
            const newTotal = await waitForPages(page);
            const changed = await page.evaluate(visiblePassage);
            assert.equal(changed.chapter, initial.chapter);
            assert.ok(Math.abs(changed.index - resized.index) <= 8, 'Changing font metrics must retain the source passage');
            const overrides = await page.$$eval('.source-runs, .source-runs em, .source-runs strong', elements =>
                elements.map(element => {
                    const css = getComputedStyle(element);
                    return { family: css.fontFamily, color: css.color, style: css.fontStyle, weight: Number(css.fontWeight) };
                }));
            assert.ok(overrides.every(run => /Inter/.test(run.family) && run.color === 'rgb(232, 193, 138)'));
            assert.equal(overrides[1].style, 'italic');
            assert.ok(overrides[2].weight >= 600);
            const savedPage = Number(new URL(page.url()).searchParams.get('page'));
            const expectedPercentage = 100 * savedPage / newTotal;
            await page.hover('#reader-nav-hit-area');
            await page.waitForFunction(() => getComputedStyle(document.getElementById('reader-nav')).visibility === 'visible');
            await page.click('#back-to-library');
            const books = await waitForLibrary(page, base, mode, books => {
                const book = books.find(book => book.id === 'book_test_epub');
                return book?.readerPosition?.globalPage === savedPage &&
                    Math.abs(book.progress - expectedPercentage) < 0.01;
            });
            const book = books.find(book => book.id === 'book_test_epub');
            assert.ok(book.progress > 10 && book.progress < 50);
            await page.waitForFunction(({ title, percent }) => Array.from(document.querySelectorAll('.book-card'))
                .some(card => card.querySelector('.book-title')?.textContent === title &&
                    card.querySelector('.book-progress-text')?.textContent.includes(String(percent))),
            { timeout: 10000 }, { title: epubFixture.title, percent: Math.round(expectedPercentage) });
            await page.goto(`${base}/book/book_test_epub`, { waitUntil: 'domcontentloaded' });
            await waitForPages(page);
            const reopened = await page.evaluate(visiblePassage);
            assert.equal(reopened.chapter, changed.chapter);
            assert.ok(Math.abs(reopened.index - changed.index) <= 2);
            await page.click('#paged-indicator');
            await page.waitForFunction(() => document.getElementById('page-jump-modal').open);
            assert.equal(await page.$eval('#page-jump-input', input => Number(input.value)), savedPage);
            await page.click('#page-jump-close');
            await page.setViewport({ width: 1400, height: 960 });
            await waitForPages(page);
        });

        await t.test('every PDF layout renders real pages and split interactions retain reading position', async () => {
            await page.setViewport({ width: 1400, height: 960 });
            await openPdf(page, base);
            for (const layout of ['text-right', 'text-left', 'text-only']) {
                await openSidebar(page, 'settings');
                await page.select('#pdf-layout', layout);
                await page.click('#settings-close');
                await page.waitForFunction(layout => document.getElementById('book-content')?.dataset.pdfLayout === layout,
                    { timeout: 10000 }, layout);
                assert.equal(Number(new URL(page.url()).searchParams.get('page')), 2);
                if (layout === 'text-only') {
                    assert.equal(await page.$('.pdf-original-viewport'), null);
                    assert.match(await page.$eval('.pdf-page-text', element => element.textContent), /He whispered/);
                    continue;
                }
                const rendered = await page.waitForFunction(() => {
                    const text = document.querySelector('.pdf-page-text').getBoundingClientRect();
                    const image = document.querySelector('.pdf-page-image-column').getBoundingClientRect();
                    let light = false, dark = false;
                    for (const canvas of document.querySelectorAll('.pdf-original-surface canvas')) {
                        if (!canvas.width || !canvas.height) continue;
                        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                        for (let i = 0; i < pixels.length; i += 4) {
                            if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) light = true;
                            if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100 && pixels[i + 3] > 0) dark = true;
                            if (light && dark) break;
                        }
                        if (light && dark) break;
                    }
                    return light && dark ? { textLeft: text.left, imageLeft: image.left, textWidth: text.width, imageWidth: image.width, light, dark } : null;
                }, {timeout: 20000});
                const geometry = await rendered.jsonValue();
                await rendered.dispose();
                assert.ok(geometry.light && geometry.dark, 'Original PDF view must contain rendered paper and source ink');
                assert.ok(geometry.textWidth > 100 && geometry.imageWidth > 100);
                assert.equal(geometry.textLeft > geometry.imageLeft, layout === 'text-right');
                const separator = await page.$('.pdf-splitter');
                const before = Number(await separator.evaluate(element => element.getAttribute('aria-valuenow')));
                await separator.focus();
                await page.keyboard.press('ArrowRight');
                await page.waitForFunction(before => Number(document.querySelector('.pdf-splitter').getAttribute('aria-valuenow')) > before,
                    {}, before);
                assert.equal(Number(new URL(page.url()).searchParams.get('page')), 2);
                const box = await separator.boundingBox();
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.down();
                await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 4 });
                await page.mouse.up();
                await page.waitForFunction(before => Number(document.querySelector('.pdf-splitter').getAttribute('aria-valuenow')) < before,
                    {}, before);
                await page.click('[data-pdf-zoom="fit"]');
                const fitWidth = await page.$eval('.pdf-original-surface', element => element.getBoundingClientRect().width);
                await page.click('[data-pdf-zoom="in"]');
                await page.waitForFunction(width => document.querySelector('.pdf-original-surface').getBoundingClientRect().width > width + 10,
                    { timeout: 10000 }, fitWidth);
                await page.click('[data-pdf-zoom="fit"]');
                await page.waitForFunction(width => Math.abs(document.querySelector('.pdf-original-surface').getBoundingClientRect().width - width) < 2,
                    { timeout: 10000 }, fitWidth);
                await page.click('[data-pdf-zoom="fill"]');
                await page.waitForFunction(() => {
                    const source = document.querySelector('.pdf-original-viewport');
                    const paper = source.querySelector('.pdf-original-surface');
                    return Math.abs(paper.getBoundingClientRect().width - source.clientWidth) < 2;
                });
                await page.setViewport({ width: 1500, height: 960 });
                await page.waitForFunction(() => {
                    const source = document.querySelector('.pdf-original-viewport');
                    return Math.abs(source.querySelector('.pdf-original-surface').getBoundingClientRect().width - source.clientWidth) < 2;
                });
                await page.setViewport({ width: 1400, height: 960 });
                await page.click('[data-pdf-zoom="fit"]');
                assert.equal(Number(new URL(page.url()).searchParams.get('page')), 2);
            }
            await jumpTo(page, 3);
            await page.waitForFunction(() => document.querySelector('.pdf-page-text')?.textContent.includes('page 3.'));
        });

        await t.test('source PDF copy stays out of speech and text scrolling follows the source', async () => {
            // Both source and text must overflow despite the full-height paged surface.
            await page.setViewport({ width: 1400, height: 600 });
            await openPdf(page, base);
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-right');
            await page.$eval('#font-size-slider', element => {
                element.value = '48'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.$eval('#paragraph-spacing-slider', element => {
                element.value = '3'; element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.click('#settings-close');
            await page.waitForSelector('.pdf-original-surface[data-pdf-selectable="true"]', {timeout: 5000});
            await page.click('[data-pdf-zoom="fit"]');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const word = await page.$eval('.pdf-original-surface', element => {
                const rect = element.getBoundingClientRect();
                return {x: rect.left + 44 / 500 * rect.width, y: rect.top + 31 / 650 * rect.height};
            });
            await page.mouse.click(word.x, word.y, { count: 2 });
            await page.waitForFunction(() => window.getSelection().toString().trim() === 'Native', {timeout: 5000});
            const selectedWord = await page.evaluate(() => window.getSelection().toString());
            await context.overridePermissions(base, ['clipboard-read', 'clipboard-write']);
            await page.keyboard.down('Control');
            await page.keyboard.press('c');
            await page.keyboard.up('Control');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selectedWord);
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.down('Control');
            await page.keyboard.press('c');
            await page.keyboard.up('Control');
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            assert.match(copied, /Native typography document, page 2\./);
            assert.match(copied, /He whispered remember me, then fell silent\./);
            assert.match(copied, /A smaller footnote\./);
            assert.equal(await page.$eval('.pdf-original-viewport', element => element.textContent), '');
            const ax = await page.createCDPSession();
            try {
                const { nodes } = await ax.send('Accessibility.getFullAXTree');
                const spoken = nodes.filter(node => !node.ignored && node.role?.value === 'StaticText')
                    .map(node => node.name?.value || '').join('\n');
                assert.equal(spoken.split('Native typography document, page 2.').length - 1, 1,
                    'The source must not add a second copy of book prose to the speech tree');
            } finally { await ax.detach(); }
            await page.keyboard.down('Control');
            await page.keyboard.press('+');
            await page.keyboard.press('c');
            await page.keyboard.up('Control');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), copied,
                'Zoom must preserve the selected source text');
            for (const readingMode of ['paged', 'scroll']) {
                for (const layout of ['text-right', 'text-left']) {
                    await openSidebar(page, 'settings');
                    await page.select('#pdf-layout', layout);
                    await page.click(readingMode === 'paged' ? '#mode-paged-btn' : '#mode-scroll-btn');
                    await page.click('#settings-close');
                    await page.waitForFunction(() => {
                        const panel = document.getElementById('settings-sidebar');
                        return panel.getAttribute('aria-hidden') === 'true' &&
                            getComputedStyle(panel).visibility === 'hidden';
                    }, {timeout: 5000});
                    const source = '#pdf-page-2 .pdf-original-viewport';
                    await page.click('#pdf-page-2 [data-pdf-zoom="fill"]');
                    await page.waitForFunction(selector => {
                        const original = document.querySelector(selector);
                        return original.scrollHeight - original.clientHeight > 100;
                    }, {}, source);
                    for (const fraction of [0, 0.5, 1]) {
                        await page.evaluate(({readingMode, fraction}) => {
                            const text = document.querySelector('#pdf-text-2').getBoundingClientRect();
                            if (readingMode === 'paged') {
                                const viewport = document.getElementById('book-viewport');
                                const top = viewport.getBoundingClientRect().top + viewport.clientTop;
                                const range = text.height - viewport.clientHeight;
                                if (range <= 100) throw new Error('Fixture text must overflow the reading viewport');
                                viewport.scrollTo({top: viewport.scrollTop + text.top - top + fraction * range, behavior: 'instant'});
                            } else {
                                const range = text.height - innerHeight;
                                if (range <= 100) throw new Error('Fixture text must overflow the window');
                                window.scrollTo({top: scrollY + text.top + fraction * range, behavior: 'instant'});
                            }
                        }, {readingMode, fraction});
                        await page.waitForFunction(({source, fraction}) => {
                            const original = document.querySelector(source);
                            const ratio = original.scrollTop / (original.scrollHeight - original.clientHeight);
                            return Math.abs(ratio - fraction) < 0.04;
                        }, {timeout: 5000}, {source, fraction});
                    }
                    const before = await page.evaluate(mode => mode === 'paged'
                        ? document.getElementById('book-viewport').scrollTop : scrollY, readingMode);
                    await page.$eval(source, element => {
                        element.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: -100}));
                        element.scrollTop = 0;
                    });
                    await page.waitForFunction(selector => document.querySelector(selector).scrollTop === 0, {}, source);
                    assert.equal(await page.evaluate(mode => mode === 'paged'
                        ? document.getElementById('book-viewport').scrollTop : scrollY, readingMode), before,
                    'Panning the source must not move the readable text');
                }
            }
            await openSidebar(page, 'settings');
            await page.click('#mode-paged-btn');
            await page.select('#pdf-layout', 'text-only');
            await page.$eval('#font-size-slider', element => {
                element.value = '32'; element.dispatchEvent(new Event('input', {bubbles: true}));
            });
            await page.$eval('#paragraph-spacing-slider', element => {
                element.value = '1.5'; element.dispatchEvent(new Event('input', {bubbles: true}));
            });
            await page.click('#settings-close');
            await page.setViewport({width: 1400, height: 960});
        });

        await t.test('source PDF horizontal pan survives next and previous pages', async () => {
            await openPdf(page, base);
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-right');
            await page.click('#mode-paged-btn');
            await page.click('#settings-close');
            for (let step = 0; step < 5; step++) await page.click('[data-pdf-zoom="in"]');
            const source = () => page.$eval('.active-pdf-page .pdf-original-viewport', element => ({
                range: element.scrollWidth - element.clientWidth,
                fraction: element.scrollLeft / (element.scrollWidth - element.clientWidth)
            }));
            assert.ok((await source()).range > 100, 'The source must actually overflow horizontally');
            for (const fraction of [0.5, 1]) {
                await page.$eval('.active-pdf-page .pdf-original-viewport', (element, fraction) => {
                    element.scrollLeft = fraction * (element.scrollWidth - element.clientWidth);
                }, fraction);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                for (const number of [3, 2]) {
                    await jumpTo(page, number);
                    await page.waitForFunction(({number, fraction}) => {
                        const original = document.querySelector(`#pdf-page-${number} .pdf-original-viewport`);
                        if (!original || original.scrollWidth - original.clientWidth <= 100) return false;
                        return Math.abs(original.scrollLeft / (original.scrollWidth - original.clientWidth) - fraction) < 0.02;
                    }, {timeout: 5000}, {number, fraction});
                    assert.ok(Math.abs((await source()).fraction - fraction) < 0.02);
                }
            }
            await page.click('[data-pdf-zoom="fit"]');
            await openSidebar(page, 'settings');
            await page.select('#pdf-layout', 'text-only');
            await page.click('#settings-close');
        });

        if (mode !== 'hosting') {
            await t.test('starting OCR exposes the cancel button and cancelling clears queue and cache', async () => {
                await openPdf(page, base);
                await openSidebar(page, 'settings');
                try {
                    const cancelBtn = '#pdf-ocr-cancel';
                    assert.equal(await page.$eval(cancelBtn, el => getComputedStyle(el).display), 'none');
                    if (mode === 'vps') {
                        await page.$eval('#compute-panel', el => { el.open = true; });
                        await page.click('#compute-submit');
                        await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).display !== 'none',
                            { timeout: 5000 }, '#compute-cancel');
                        assert.notEqual(await page.$eval('#compute-cancel', el => getComputedStyle(el).display), 'none');
                        await page.click('#compute-cancel');
                        await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).display === 'none',
                            { timeout: 10000 }, '#compute-cancel');
                        assert.match(await page.$eval('#compute-status', el => el.textContent), /iptal edildi ve önbellek silindi/);
                    } else {
                        await page.click('#pdf-ocr-current');
                        await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).display !== 'none',
                            { timeout: 5000 }, cancelBtn);
                        await page.click(cancelBtn);
                        await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).display === 'none',
                            { timeout: 10000 }, cancelBtn);
                    }
                    assert.equal(await page.$eval('#pdf-ocr-mode', el => el.value), 'off');
                } finally {
                    await page.click('#settings-close');
                }
            });
        }

        await t.test('real background uploads accept a second file while reading without route or position resets', async () => {
            await page.setViewport({ width: 1400, height: 960 });
            await openPdf(page, base);
            await waitForPages(page);
            const cdp = await page.createCDPSession();
            t.after(() => cdp.detach().catch(() => {}));
            await cdp.send('Network.enable');
            await cdp.send('Network.emulateNetworkConditions', {
                offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 32768
            });
            await page.evaluate(() => {
                const observation = window.__readerUploadObservation = { failures: [], pages: new Set() };
                observation.timer = setInterval(() => {
                    const overlay = document.getElementById('loading-overlay');
                    if (getComputedStyle(overlay).display !== 'none') observation.failures.push('blocking overlay');
                    if (location.pathname !== '/book/book_test_typography') observation.failures.push('reader route reset');
                    const reader = document.getElementById('reader-view');
                    if (getComputedStyle(reader).display === 'none') observation.failures.push('reader hidden');
                    observation.pages.add(new URLSearchParams(location.search).get('page'));
                }, 25);
            });
            try {
                await page.hover('#reader-nav-hit-area');
                await page.waitForFunction(() => getComputedStyle(document.getElementById('reader-nav')).visibility === 'visible');
                const [firstChooser] = await Promise.all([page.waitForFileChooser(), page.click('#reader-upload-btn')]);
                await firstChooser.accept([uploadFixtures[0].file]);
                await page.waitForFunction(title => Array.from(document.querySelectorAll('.reader-upload-item'))
                    .some(item => item.dataset.status === 'running' && item.dataset.stage === 'sending' &&
                        item.title.includes(title) && Number(item.dataset.percent) > 0 && Number(item.dataset.percent) < 95),
                { timeout: 30000 }, uploadFixtures[0].title);
                await page.hover('#reader-nav-hit-area');
                await page.waitForFunction(() => getComputedStyle(document.getElementById('reader-nav')).visibility === 'visible');
                const [secondChooser] = await Promise.all([page.waitForFileChooser(), page.click('#reader-upload-btn')]);
                await secondChooser.accept([uploadFixtures[1].file]);
                await page.waitForFunction(title => Array.from(document.querySelectorAll('.reader-upload-item'))
                    .some(item => item.dataset.status === 'queued' && item.title.includes(title)),
                { timeout: 10000 }, path.basename(uploadFixtures[1].file));
                const tooltip = await page.$$eval('.reader-upload-badge', badges => badges.map(badge => badge.title));
                assert.ok(tooltip.some(title => title.includes(uploadFixtures[0].title)),
                    'The circular progress tooltip must name the actual metadata title, not a generic upload');
                await jumpTo(page, 3);
                await page.waitForFunction(() => document.querySelector('.pdf-page-text')?.textContent.includes('page 3.'));
                await openSidebar(page, 'settings');
                await page.$eval('#font-size-slider', element => {
                    element.value = '28'; element.dispatchEvent(new Event('input', { bubbles: true }));
                });
                await page.click('#settings-close');
                await page.waitForFunction(() => {
                    const span = Array.from(document.querySelectorAll('.pdf-text-block span'))
                        .find(element => element.textContent.includes('Native typography document'));
                    return span && getComputedStyle(span).fontSize === '28px';
                }, { timeout: 10000 });
                assert.equal(Number(new URL(page.url()).searchParams.get('page')), 3);
                await cdp.send('Network.emulateNetworkConditions', {
                    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
                });
                const books = await waitForLibrary(page, base, mode, books => uploadFixtures.every(fixture =>
                    books.some(book => book.title === fixture.title)));
                for (const fixture of uploadFixtures) {
                    const matches = books.filter(book => book.title === fixture.title);
                    assert.equal(matches.length, 1, 'An upload must commit exactly one real library entry');
                    const response = await fetch(matches[0].bookUrl.startsWith('http')
                        ? matches[0].bookUrl : base + matches[0].bookUrl);
                    assert.equal(response.status, 200);
                    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes,
                        'The persisted book must contain the original transferred bytes');
                }
                await page.waitForFunction(() => !document.querySelector('.reader-upload-item[data-status="running"], .reader-upload-item[data-status="queued"]'),
                    { timeout: 10000 });
                const observed = await page.evaluate(() => {
                    const state = window.__readerUploadObservation;
                    clearInterval(state.timer);
                    return { failures: state.failures, pages: Array.from(state.pages) };
                });
                assert.deepEqual(observed.failures, []);
                assert.ok(observed.pages.includes('2') && observed.pages.includes('3'));
                assert.ok(observed.pages.every(number => number === '2' || number === '3'),
                    'Background completion must not reset the logical reading position');
                assert.equal(Number(new URL(page.url()).searchParams.get('page')), 3);
                await page.hover('#reader-nav-hit-area');
                await page.waitForFunction(() => getComputedStyle(document.getElementById('reader-nav')).visibility === 'visible');
                await page.click('#back-to-library');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForFunction(titles => titles.every(title => Array.from(document.querySelectorAll('.book-title'))
                    .some(element => element.textContent === title)), { timeout: 30000 }, uploadFixtures.map(fixture => fixture.title));
            } finally {
                await page.evaluate(() => clearInterval(window.__readerUploadObservation?.timer)).catch(() => {});
                await cdp.send('Network.emulateNetworkConditions', {
                    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
                });
            }
        });
    });
}
