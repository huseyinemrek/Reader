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

const root = path.resolve(__dirname, '..');
const requireLocal = createRequire(path.join(root, 'local/package.json'));
let browser;

before(async () => {
    const { default: puppeteer } = await import(pathToFileURL(requireLocal.resolve('puppeteer')).href);
    browser = await puppeteer.launch({ headless: true });
});
after(async () => { await browser?.close(); });

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
        return section?.dataset.pageIndex === String(number) && section.dataset.textSource === 'native' &&
            section.querySelector('.pdf-page-text')?.textContent.includes(`page ${number}.`);
    }, { timeout: 20000 }, number);
}

async function openSidebar(page, name) {
    // A closing panel still covers the toolbar until its transition finishes.
    await page.waitForFunction(id => {
        const panel = document.getElementById(id);
        const bounds = panel.getBoundingClientRect();
        return panel.getAttribute('aria-hidden') === 'true' &&
            (bounds.right <= 0 || bounds.left >= innerWidth);
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

for (const mode of ['local', 'vps']) {
    test(`${mode}: real PDF reader regressions`, { timeout: 120000 }, async t => {
        const base = await startReader(mode, t);
        const context = await browser.createBrowserContext();
        t.after(() => context.close());
        const page = await context.newPage();
        await page.setViewport({ width: 1400, height: 960 });
        await page.evaluateOnNewDocument(() => {
            if (!localStorage.getItem('edgeReaderSettings')) {
                localStorage.setItem('edgeReaderSettings', JSON.stringify({
                    readingMode: 'paged', pdfLayout: 'text-only', fontFamily: 'original',
                    fontSize: '28', lineHeight: '2.0', textColor: '#9ddeac'
                }));
            }
        });

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

        await t.test('PDF without bookmarks never displays stale library contents', async () => {
            await openPdf(page, base, 'book_test_no_outline', 1);
            await openSidebar(page, 'toc');
            assert.equal(await page.$$eval('#toc-list a', links => links.length), 0);
        });
    });
}
