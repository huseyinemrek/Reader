import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const requireLocal = createRequire(new URL('../../local/package.json', import.meta.url));
const source = await readFile(new URL('../public/upload-queue.js', import.meta.url), 'utf8');
let browser, server, foreignServer, origin, foreignOrigin;
const requests = [];

before(async () => {
    const { default: puppeteer } = await import(pathToFileURL(requireLocal.resolve('puppeteer')).href);
    browser = await puppeteer.launch({ headless: true });
    const handler = (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (request.method === 'OPTIONS') { response.end(); return; }
        if (request.url === '/upload-queue.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(source);
        } else if (request.method === 'POST') {
            let size = 0;
            request.on('data', chunk => { size += chunk.length; });
            request.on('end', () => {
                requests.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie, size });
                setTimeout(() => {
                    response.setHeader('Content-Type', 'application/json');
                    if (request.url === '/fail') {
                        response.statusCode = 422;
                        response.end(JSON.stringify({ error: 'Archive has no HTML' }));
                    } else response.end(JSON.stringify({ id: 'committed-book', title: 'A book' }));
                }, 180);
            });
        } else {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><button id="read" onclick="this.textContent=\'Next page\'">Read another book</button>');
        }
    };
    server = createServer(handler);
    foreignServer = createServer(handler);
    server.listen(0, '127.0.0.1');
    foreignServer.listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(foreignServer, 'listening')]);
    origin = `http://127.0.0.1:${server.address().port}`;
    foreignOrigin = `http://127.0.0.1:${foreignServer.address().port}`;
});
after(async () => {
    await browser?.close();
    await Promise.all([server, foreignServer].filter(Boolean).map(value => new Promise(resolve => value.close(resolve))));
});

async function pageFor(t, runner = 'controlled') {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(origin);
    await page.evaluate(async mode => {
        const { createUploadQueue, uploadHttp } = await import('/upload-queue.js');
        window.uploadHttp = uploadHttp;
        window.owner = 'alice';
        window.started = [];
        window.finished = [];
        window.pending = {};
        window.contexts = {};
        window.file = name => new File(['book bytes'], name);
        window.unloadBlocked = () => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
        window.queue = createUploadQueue({
            getOwnerKey: () => window.owner,
            completedLifetime: 0,
            run: (file, context) => {
                window.started.push(file.name);
                window.contexts[file.name] = context;
                if (mode === 'fail-first' && file.name === 'bad.epub' && window.started.filter(name => name === file.name).length === 1) {
                    return Promise.reject(new Error('The archive is damaged'));
                }
                return new Promise((resolve, reject) => { window.pending[file.name] = { resolve, reject }; });
            },
            onComplete: (book, { ownerKey }) => { window.finished.push({ book, ownerKey }); }
        });
    }, runner);
    return page;
}

async function state(page) { return page.evaluate(() => window.queue.state); }

test('serializes multi-selection and repeated additions while the reader remains usable', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => {
        window.queue.add([window.file('one.epub'), window.file('two.pdf')], window.owner);
        window.queue.add([window.file('three.htmlz')], window.owner);
    });
    assert.deepEqual(await page.evaluate(() => window.started), ['one.epub']);
    assert.equal(await page.evaluate(() => window.unloadBlocked()), true);
    assert.deepEqual((await state(page)).map(item => item.status), ['running', 'queued', 'queued']);
    await page.click('#read');
    assert.equal(await page.$eval('#read', node => node.textContent), 'Next page');
    for (const name of ['one.epub', 'two.pdf', 'three.htmlz']) {
        await page.evaluate(name => window.pending[name].resolve({ title: name }), name);
        await page.waitForFunction(name => window.finished.some(item => item.book.title === name), {}, name);
    }
    assert.deepEqual(await page.evaluate(() => window.started), ['one.epub', 'two.pdf', 'three.htmlz']);
    assert.deepEqual((await state(page)).map(item => item.percent), [100, 100, 100]);
    assert.equal(await page.evaluate(() => window.unloadBlocked()), false);
});

test('reports real byte progress, exposes book/stage tooltip, and reserves 100 for commit', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => window.queue.add([window.file('illustrated.epub')], window.owner));
    assert.equal((await state(page))[0].percent, null);
    await page.evaluate(() => window.contexts['illustrated.epub'].report({ stage: 'preparing', loaded: 5, total: 10, detail: 'Measuring illustrations', name: 'Illustrated Book' }));
    assert.equal((await state(page))[0].percent, null);
    assert.match(await page.$eval('.reader-upload-badge', node => node.title), /Illustrated Book.*Preparing.*Measuring illustrations/);
    assert.equal(await page.$eval('.reader-upload-badge', node => node.hasAttribute('aria-valuenow')), false);
    await page.focus('.reader-upload-actions button');
    await page.evaluate(() => window.contexts['illustrated.epub'].report({ stage: 'sending', loaded: 42, total: 100 }));
    assert.equal((await state(page))[0].percent, 42);
    assert.match(await page.$eval('.reader-upload-badge', node => node.getAttribute('aria-label')), /Illustrated Book.*Sending.*42%/);
    assert.equal(await page.evaluate(() => document.activeElement.matches('.reader-upload-actions button')), true, 'byte updates preserve keyboard access to cancellation');
    await page.evaluate(() => window.contexts['illustrated.epub'].report({ stage: 'sending', loaded: 100, total: 100 }));
    assert.equal((await state(page))[0].percent, 99);
    await page.evaluate(() => window.contexts['illustrated.epub'].report({ stage: 'finalizing' }));
    assert.equal((await state(page))[0].percent, null);
    assert.equal((await state(page))[0].stage, 'finalizing');
    assert.equal(await page.evaluate(() => window.unloadBlocked()), true);
    await page.evaluate(() => window.pending['illustrated.epub'].resolve({ id: 'saved' }));
    await page.waitForFunction(() => window.queue.state[0].status === 'complete');
    assert.equal((await state(page))[0].percent, 100);
    assert.equal(await page.$eval('.reader-upload-item', node => node.dataset.percent), '100');
    const bounds = await page.$eval('.reader-upload-queue', node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, bottom: innerHeight - rect.bottom };
    });
    assert.ok(bounds.left < 30 && bounds.bottom < 30, 'badges stay in the bottom-left, away from TTS');
});

test('failed uploads retain retry/dismiss controls and never stop the next book', async t => {
    const page = await pageFor(t, 'fail-first');
    await page.evaluate(() => window.queue.add([window.file('bad.epub'), window.file('good.pdf')], window.owner));
    await page.waitForFunction(() => window.started.includes('good.pdf'));
    const failed = (await state(page))[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'The archive is damaged');
    assert.equal(await page.$eval('.reader-upload-error', node => node.textContent), 'The archive is damaged');
    await page.evaluate(() => window.pending['good.pdf'].resolve({ title: 'Good' }));
    await page.waitForFunction(() => window.finished.length === 1);
    assert.equal(await page.evaluate(() => window.unloadBlocked()), false, 'failures alone do not prevent leaving');
    await page.click(`.reader-upload-item[data-upload-id="${failed.id}"] button`);
    await page.waitForFunction(() => window.started.filter(name => name === 'bad.epub').length === 2);
    assert.equal(await page.evaluate(() => window.unloadBlocked()), true);
    await page.evaluate(() => window.pending['bad.epub'].reject(new Error('Still damaged')));
    await page.waitForFunction(() => window.queue.state[0].status === 'failed');
    await page.evaluate(id => window.queue.dismiss(id), failed.id);
    assert.deepEqual((await state(page)).map(item => item.name), ['good.pdf']);
});

test('logout cancels stale progress/completion and prevents cross-account reuse even if a runner ignores abort', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => window.queue.add([window.file('old.epub'), window.file('never.pdf')], window.owner));
    const denied = await page.evaluate(() => {
        try { window.queue.add([window.file('wrong.pdf')], 'bob'); return false; }
        catch (_) { return true; }
    });
    assert.equal(denied, true);
    await page.evaluate(() => {
        window.queue.cancelOwner('alice');
        window.owner = 'bob';
        window.queue.add([window.file('new.pdf')], window.owner);
        window.contexts['old.epub'].report({ stage: 'sending', loaded: 90, total: 100 });
    });
    assert.equal(await page.evaluate(() => window.contexts['old.epub'].signal.aborted), true);
    assert.deepEqual((await state(page)).map(item => item.name), ['new.pdf']);
    assert.deepEqual(await page.evaluate(() => window.started), ['old.epub']);
    assert.equal(await page.evaluate(() => {
        try { window.contexts['old.epub'].throwIfCancelled(); return false; }
        catch (error) { return error.name === 'AbortError'; }
    }), true);
    await page.evaluate(() => window.pending['old.epub'].resolve({ id: 'stale' }));
    await page.waitForFunction(() => window.started.includes('new.pdf'));
    assert.deepEqual(await page.evaluate(() => window.finished), []);
    await page.evaluate(() => window.pending['new.pdf'].resolve({ id: 'new' }));
    await page.waitForFunction(() => window.finished.length === 1);
    assert.deepEqual(await page.evaluate(() => window.finished), [{ book: { id: 'new' }, ownerKey: 'bob' }]);
});

test('completion callback failures cannot requeue a committed book; destroy cancels pending work', async t => {
    const page = await pageFor(t);
    await page.evaluate(async () => {
        window.queue.destroy();
        const { createUploadQueue } = await import('/upload-queue.js');
        window.queue = createUploadQueue({
            completedLifetime: 0,
            run: () => Promise.resolve({ id: 'saved' }),
            onComplete: () => { throw new Error('Library refresh failed'); }
        });
        window.ids = window.queue.add([window.file('saved.epub')], window.owner);
    });
    await page.waitForFunction(() => window.queue.state[0].status === 'complete');
    assert.equal(await page.evaluate(() => window.queue.retry(window.ids[0])), false);
    assert.equal(await page.$eval('.reader-upload-actions', node => node.textContent), 'Dismiss');
    await page.evaluate(() => window.queue.destroy());
    assert.equal(await page.evaluate(() => window.unloadBlocked()), false);
    assert.equal(await page.$('.reader-upload-queue'), null);
});

test('HTTP helper sends multipart bytes and same-origin bearer, and waits for JSON commit', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => {
        const data = new FormData();
        data.append('bookFile', new File([new Uint8Array(512 * 1024)], 'large.epub'));
        window.httpEvents = [];
        window.httpSettled = false;
        window.httpPromise = window.uploadHttp('/ok', data, {
            token: 'private-token',
            onProgress: event => window.httpEvents.push(event)
        }).then(book => { window.httpSettled = true; return book; });
    });
    await page.waitForFunction(() => window.httpEvents.some(event => event.stage === 'finalizing'));
    assert.equal(await page.evaluate(() => window.httpSettled), false);
    assert.equal(await page.evaluate(() => window.httpEvents.some(event => event.stage === 'sending' && event.loaded > 0 && event.total >= event.loaded)), true);
    assert.deepEqual(await page.evaluate(() => window.httpPromise), { id: 'committed-book', title: 'A book' });
    const request = requests.findLast(item => item.path === '/ok');
    assert.equal(request.authorization, 'Bearer private-token');
    assert.ok(request.size > 512 * 1024, 'multipart transfer includes file and framing');
    const failure = await page.evaluate(async () => {
        try { await window.uploadHttp('/fail', new FormData()); return null; }
        catch (error) { return { message: error.message, status: error.status, body: error.body }; }
    });
    assert.deepEqual(failure, { message: 'Archive has no HTML', status: 422, body: { error: 'Archive has no HTML' } });
});

test('HTTP helper strips cross-origin credentials and honors cancellation before and during transfer', async t => {
    const page = await pageFor(t);
    await page.setCookie({ name: 'session', value: 'private-cookie', url: foreignOrigin });
    await page.evaluate(async foreign => {
        await window.uploadHttp(foreign + '/foreign', new FormData(), { token: 'must-not-leak' });
    }, foreignOrigin);
    const foreign = requests.findLast(item => item.path === '/foreign');
    assert.equal(foreign.authorization, undefined);
    assert.equal(foreign.cookie, undefined);
    const aborted = await page.evaluate(async () => {
        const controller = new AbortController();
        controller.abort();
        try { await window.uploadHttp('/pre-aborted', new FormData(), { signal: controller.signal }); return null; }
        catch (error) { return error.name; }
    });
    assert.equal(aborted, 'AbortError');
    assert.equal(requests.some(item => item.path === '/pre-aborted'), false);
    const during = await page.evaluate(async () => {
        const controller = new AbortController();
        const request = window.uploadHttp('/cancel', new FormData(), {
            signal: controller.signal,
            onProgress: event => { if (event.stage === 'finalizing') controller.abort(); }
        });
        try { await request; return null; }
        catch (error) { return error.name; }
    });
    assert.equal(during, 'AbortError');
});
