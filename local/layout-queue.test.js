'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');
const JSZip = require('./libs/jszip.min.js');
const createLayoutQueue = require('./layout-queue');
const { describeSource } = require('./layout-source');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-layout-'));
    const uploadsDir = path.join(directory, 'uploads');
    const cacheDir = path.join(directory, 'layout-cache');
    await fs.mkdir(uploadsDir);
    const queues = [];
    const open = () => {
        const queue = createLayoutQueue(cacheDir, { uploadsDir });
        queues.push(queue);
        return queue;
    };
    t.after(async () => {
        await Promise.all(queues.map(queue => queue.shutdown()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { directory, uploadsDir, cacheDir, queue: open(), open };
}

function png(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

async function archive(filename, chapter = '<html><body><p>Original chapter</p><img src="pic.png"></body></html>') {
    const zip = new JSZip();
    zip.file('chapter.xhtml', chapter);
    zip.file('style.css', 'p { color: navy; }');
    zip.file('pic.png', png(900, 1600));
    zip.file('font.woff', Buffer.from('font bytes excluded'));
    await fs.writeFile(filename, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function terminal(queue, request) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const state = await queue.ensure(request);
        if (state.status === 'ready' || state.status === 'failed') return state;
        await delay(10);
    }
    assert.fail('Layout work did not finish.');
}

async function processing(queue, request) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const state = await queue.ensure(request);
        if (state.status === 'processing') return state;
        if (state.status !== 'pending') assert.fail(`Expected active layout generation, got ${state.status}.`);
        await delay(1);
    }
    assert.fail('Layout generation did not start.');
}

async function manifest(state) {
    const zip = await JSZip.loadAsync(await fs.readFile(state.bundlePath));
    assert.deepEqual(Object.keys(zip.files), ['manifest.json'], 'Only layout metadata is sent, never illustration or font bytes.');
    return JSON.parse(await zip.file('manifest.json').async('string'));
}

test('concurrent ensures queue one source and preserve chapter/CSS text and intrinsic image geometry', async t => {
    const { queue, uploadsDir } = await fixture(t);
    const request = { bookId: 'book_1', archivePath: path.join(uploadsDir, 'book_1.epub') };
    await archive(request.archivePath);
    const initial = await queue.ensure(request);
    assert.equal(initial.status, 'pending');
    assert.match(initial.sourceVersion, /^[a-f0-9]{64}$/);
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => queue.ensure(request)));
    assert.ok(concurrent.every(state => state.sourceVersion === initial.sourceVersion));
    const ready = await terminal(queue, request);
    assert.equal(ready.status, 'ready');
    const index = await manifest(ready);
    assert.equal(index.texts['chapter.xhtml'], '<html><body><p>Original chapter</p><img src="pic.png"></body></html>');
    assert.equal(index.texts['style.css'], 'p { color: navy; }');
    assert.deepEqual(index.images['pic.png'], { width: 900, height: 1600, type: 'image/png' });
    assert.equal(index.texts['font.woff'], undefined);
    const before = await fs.stat(ready.bundlePath, { bigint: true });
    assert.deepEqual(await queue.ensure(request), ready);
    const after = await fs.stat(ready.bundlePath, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs, 'A repeat read does not regenerate or replace the bundle.');
});

test('restart reads ready disk cache without regenerating the original archive', async t => {
    const { queue, uploadsDir, open } = await fixture(t);
    const request = { bookId: 'book_cache', archivePath: path.join(uploadsDir, 'book_cache.htmlz') };
    await archive(request.archivePath, '<html><body>Cached HTMLZ text</body></html>');
    const ready = await terminal(queue, request);
    assert.equal(ready.status, 'ready');
    const before = await fs.stat(ready.bundlePath, { bigint: true });
    await queue.shutdown();
    const restarted = open();
    assert.deepEqual(await restarted.ensure(request), ready);
    assert.equal((await manifest(ready)).texts['chapter.xhtml'], '<html><body>Cached HTMLZ text</body></html>');
    assert.equal((await fs.stat(ready.bundlePath, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('changed sources invalidate ready cache and remove obsolete artifacts', async t => {
    const { queue, uploadsDir } = await fixture(t);
    const request = { bookId: 'book_changed', archivePath: path.join(uploadsDir, 'book_changed.zip') };
    await archive(request.archivePath);
    const original = await terminal(queue, request);
    assert.equal(original.status, 'ready');
    const replacement = '<html><body>A replacement with different content and length</body></html>';
    await archive(request.archivePath, replacement);
    const changed = await queue.ensure(request);
    assert.equal(changed.status, 'pending');
    assert.notEqual(changed.sourceVersion, original.sourceVersion);
    await assert.rejects(fs.access(original.bundlePath), error => error.code === 'ENOENT');
    const ready = await terminal(queue, request);
    assert.equal(ready.status, 'ready');
    assert.equal((await manifest(ready)).texts['chapter.xhtml'], replacement);
});

test('replacing an actively processed archive cannot publish the canceled source', async t => {
    const { queue, uploadsDir } = await fixture(t);
    const request = { bookId: 'book_active', archivePath: path.join(uploadsDir, 'book_active.epub') };
    await archive(request.archivePath, '<html><body>' + 'old content '.repeat(100000) + '</body></html>');
    const original = await processing(queue, request);
    await archive(request.archivePath, '<html><body>Current source only</body></html>');
    const changed = await queue.ensure(request);
    assert.notEqual(changed.sourceVersion, original.sourceVersion);
    const ready = await terminal(queue, request);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.sourceVersion, changed.sourceVersion);
    assert.equal((await manifest(ready)).texts['chapter.xhtml'], '<html><body>Current source only</body></html>');
});

test('deleting active work immediately revokes ensure and removes every cache artifact', async t => {
    const { queue, uploadsDir, cacheDir } = await fixture(t);
    const request = { bookId: 'book_deleted', archivePath: path.join(uploadsDir, 'book_deleted.epub') };
    await archive(request.archivePath, '<html><body>' + 'deleted content '.repeat(100000) + '</body></html>');
    await processing(queue, request);
    const removal = queue.deleteBook(request.bookId);
    await assert.rejects(queue.ensure(request), error => error.statusCode === 410);
    await removal;
    await assert.rejects(fs.access(path.join(cacheDir, request.bookId)), error => error.code === 'ENOENT');
    await assert.rejects(queue.ensure(request), error => error.statusCode === 410);
});

test('invalid archives fail explicitly, remain failed after restart and recover only for a new source', async t => {
    const { queue, uploadsDir, open } = await fixture(t);
    const request = { bookId: 'book_bad', archivePath: path.join(uploadsDir, 'book_bad.epub') };
    await fs.writeFile(request.archivePath, 'not an archive');
    const failure = await terminal(queue, request);
    assert.equal(failure.status, 'failed');
    assert.match(failure.error, /zip|archive/i);
    assert.equal(failure.bundlePath, undefined);
    await queue.shutdown();
    const restarted = open();
    assert.deepEqual(await restarted.ensure(request), failure);
    await archive(request.archivePath, '<html><body>Fixed source</body></html>');
    const fixed = await terminal(restarted, request);
    assert.equal(fixed.status, 'ready');
    assert.notEqual(fixed.sourceVersion, failure.sourceVersion);
    assert.equal((await manifest(fixed)).texts['chapter.xhtml'], '<html><body>Fixed source</body></html>');
});

test('archives without chapters fail rather than publishing an empty layout', async t => {
    const { queue, uploadsDir } = await fixture(t);
    const request = { bookId: 'book_images', archivePath: path.join(uploadsDir, 'book_images.zip') };
    const zip = new JSZip();
    zip.file('pic.png', png(10, 20));
    await fs.writeFile(request.archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const failed = await terminal(queue, request);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /no HTML chapters/);
    assert.equal(failed.bundlePath, undefined);
});

test('a failed worker releases its slot so other queued books still complete', async t => {
    const { queue, uploadsDir } = await fixture(t);
    const bad = { bookId: 'book_serial_bad', archivePath: path.join(uploadsDir, 'book_serial_bad.epub') };
    const requests = Array.from({ length: 3 }, (_, index) => ({
        bookId: `book_serial_${index}`, archivePath: path.join(uploadsDir, `book_serial_${index}.epub`)
    }));
    await fs.writeFile(bad.archivePath, 'broken archive');
    await Promise.all(requests.map((request, index) => archive(request.archivePath, `<html><body>Book ${index}</body></html>`)));
    await queue.ensure(bad);
    await Promise.all(requests.map(request => queue.ensure(request)));
    assert.equal((await terminal(queue, bad)).status, 'failed');
    const states = await Promise.all(requests.map(request => terminal(queue, request)));
    assert.deepEqual(states.map(state => state.status), ['ready', 'ready', 'ready']);
    for (let index = 0; index < states.length; index++) {
        assert.equal((await manifest(states[index])).texts['chapter.xhtml'], `<html><body>Book ${index}</body></html>`);
    }
});

test('queue path validation excludes protected, nested, outside and unsupported source files', async t => {
    const { queue, uploadsDir, directory } = await fixture(t);
    for (const filename of [path.join(uploadsDir, '.private.epub'), path.join(uploadsDir, 'nested', 'book.epub'), path.join(directory, 'outside.epub')]) {
        await assert.rejects(queue.ensure({ bookId: 'book_paths', archivePath: filename }), error => error.statusCode === 400);
    }
    for (const filename of ['plain.html', 'plain.pdf']) {
        await assert.rejects(queue.ensure({ bookId: 'book_paths', archivePath: path.join(uploadsDir, filename) }), error => error.statusCode === 415);
    }
    await assert.rejects(queue.ensure({ bookId: '../escape', archivePath: path.join(uploadsDir, 'book.epub') }), error => error.statusCode === 400);
    await assert.rejects(queue.ensure({ bookId: 'book_missing', archivePath: path.join(uploadsDir, 'missing.epub') }), error => error.statusCode === 404);
});

test('symlink sources cannot escape the regular uploads-file boundary', async t => {
    const { queue, uploadsDir, directory } = await fixture(t);
    const target = path.join(directory, 'private.epub');
    const archivePath = path.join(uploadsDir, 'link.epub');
    await archive(target);
    try { await fs.symlink(target, archivePath); } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Creating file symlinks requires OS permission.');
        throw error;
    }
    await assert.rejects(queue.ensure({ bookId: 'book_symlink', archivePath }), error => error.statusCode === 400);
});

test('layout builder versions participate in the source identity even when archive stat is unchanged', async t => {
    const { uploadsDir } = await fixture(t);
    const filename = path.join(uploadsDir, 'versioned.epub');
    await archive(filename);
    const first = await describeSource(filename, uploadsDir, 'builder-version-one');
    const second = await describeSource(filename, uploadsDir, 'builder-version-two');
    assert.notEqual(first.sourceVersion, second.sourceVersion);
    assert.equal(first.source.size, second.source.size);
    assert.equal(first.source.mtimeNs, second.source.mtimeNs);
});
