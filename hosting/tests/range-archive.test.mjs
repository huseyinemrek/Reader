import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.JSZip = require('../public/libs/jszip.min.js');
// The hosted app uses browser ESM, while its Express package is CommonJS.
const source = await readFile(new URL('../public/range-archive.js', import.meta.url), 'utf8');
const { RemoteZip } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const chapter = '<html><body><h1>Merhaba dünya</h1><p>Kitabın ilk bölümü.</p></body></html>';
const imageBytes = randomBytes(900_000);
const fixture = new JSZip();
fixture.file('OPS/chapter.xhtml', chapter, { compression: 'DEFLATE' });
fixture.file('OPS/stored.txt', 'Uncompressed text', { compression: 'STORE' });
fixture.file('OPS/images/unread.bin', imageBytes, { compression: 'STORE' });
const zipBytes = await fixture.generateAsync({ type: 'nodebuffer', comment: 'Range test archive' });

async function mockServer(t, bytes = zipBytes, options = {}) {
    const requests = [];
    let transferred = 0;
    const server = createServer((req, res) => {
        requests.push(req.headers.range);
        if (options.wholeResponse) {
            res.writeHead(200, { 'Content-Length': bytes.length });
            res.end(bytes);
            return;
        }
        const suffix = /^bytes=-(\d+)$/.exec(req.headers.range || '');
        const exact = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (!suffix && !exact) { res.writeHead(400).end(); return; }
        const start = suffix ? Math.max(0, bytes.length - Number(suffix[1])) : Number(exact[1]);
        const end = suffix ? bytes.length - 1 : Number(exact[2]);
        if (end >= bytes.length || start > end) { res.writeHead(416).end(); return; }
        const send = () => {
            if (res.destroyed) return;
            const headers = options.hideContentRange ? {} : { 'Content-Range': `bytes ${start + (options.wrongRange ? 1 : 0)}-${end}/${bytes.length}` };
            res.writeHead(206, headers);
            const payload = bytes.subarray(start, options.truncated ? end : end + 1);
            transferred += payload.length;
            res.end(options.tooLong ? Buffer.concat([payload, Buffer.from([0])]) : payload);
        };
        if (options.delay && !suffix) setTimeout(send, options.delay);
        else send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return { url: `http://127.0.0.1:${server.address().port}/book.epub`, requests, transferred: () => transferred };
}

test('reads selected STORE/DEFLATE members with bounded Range downloads and memory reuse', async t => {
    const server = await mockServer(t);
    const archive = await RemoteZip.open(server.url);
    t.after(() => archive.close());
    assert.equal(archive.has('OPS/chapter.xhtml'), true);
    assert.equal(archive.has('missing'), false);
    assert.ok(archive.names().includes('OPS/images/unread.bin'));
    assert.equal(await archive.read('OPS/chapter.xhtml'), chapter);
    assert.equal(await archive.read('OPS/stored.txt'), 'Uncompressed text');
    const requests = server.requests.length;
    const bytes = await archive.read('OPS/chapter.xhtml', 'uint8array');
    bytes[0] = 0; // A consumer cannot corrupt the cached entry.
    assert.equal(await archive.read('OPS/chapter.xhtml'), chapter);
    assert.equal(await (await archive.read('OPS/stored.txt', 'blob')).text(), 'Uncompressed text');
    assert.equal(server.requests.length, requests);
    assert.ok(server.transferred() < 70_000, `Downloaded ${server.transferred()} of ${zipBytes.length} bytes`);
    assert.ok(server.requests.every(range => /^bytes=/.test(range)));
    await assert.rejects(archive.read('missing'), /Dosya bulunamadı/);
    await assert.rejects(archive.read('OPS/stored.txt', 'unsupported'), /çıktı türü/);
});

test('concurrent readers share downloads; aborting one reader preserves the other', async t => {
    const server = await mockServer(t, zipBytes, { delay: 30 });
    const archive = await RemoteZip.open(server.url);
    t.after(() => archive.close());
    const controller = new AbortController();
    const first = archive.read('OPS/chapter.xhtml', 'string', controller.signal);
    const second = archive.read('OPS/chapter.xhtml');
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(await second, chapter);
    assert.equal(server.requests.length, 3); // Tail, local header, compressed chapter.
});

test('close cancels in-flight entry downloads and prevents subsequent reads', async t => {
    const server = await mockServer(t, zipBytes, { delay: 100 });
    const archive = await RemoteZip.open(server.url);
    const pending = archive.read('OPS/chapter.xhtml');
    setTimeout(() => archive.close(), 10);
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(archive.read('OPS/stored.txt'), { name: 'AbortError' });
});

test('a cancelled open does not start a request', async t => {
    const server = await mockServer(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(RemoteZip.open(server.url, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(server.requests.length, 0);
});

test('rejects servers that ignore Range instead of falling back to full download', async t => {
    const server = await mockServer(t, zipBytes, { wholeResponse: true });
    await assert.rejects(RemoteZip.open(server.url), /HTTP Range.*Tüm kitap indirilmedi/);
    assert.equal(server.requests.length, 1);
});

for (const [name, options, message] of [
    ['missing CORS response header', { hideContentRange: true }, /Content-Range.*CORS/],
    ['incorrect range bounds', { wrongRange: true }, /Content-Range sınırları/],
    ['truncated body', { truncated: true }, /parçası eksik/],
    ['oversized body', { tooLong: true }, /istenenden fazla veri/]
]) {
    test(`rejects ${name}`, async t => {
        const server = await mockServer(t, zipBytes, options);
        await assert.rejects(RemoteZip.open(server.url), message);
    });
}

test('rejects malformed EOCD and out-of-bounds central directory', async t => {
    const malformed = Buffer.from(zipBytes);
    const end = malformed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    malformed.writeUInt32LE(malformed.length, end + 16);
    const server = await mockServer(t, malformed);
    await assert.rejects(RemoteZip.open(server.url), /Merkez dizin sınırları/);
    assert.equal(server.requests.length, 1);
});

test('rejects ZIP64 before using unsupported offsets', async t => {
    const malformed = Buffer.from(zipBytes);
    const end = malformed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    malformed.writeUInt32LE(0xffffffff, end + 16);
    const server = await mockServer(t, malformed);
    await assert.rejects(RemoteZip.open(server.url), /ZIP64/);
});

test('CRC verification detects damaged compressed data', async t => {
    const corrupted = Buffer.from(zipBytes);
    const name = Buffer.from('OPS/stored.txt');
    const header = corrupted.indexOf(name) - 30;
    const start = header + 30 + corrupted.readUInt16LE(header + 26) + corrupted.readUInt16LE(header + 28);
    corrupted[start] ^= 1;
    const server = await mockServer(t, corrupted);
    const archive = await RemoteZip.open(server.url);
    t.after(() => archive.close());
    await assert.rejects(archive.read('OPS/stored.txt'), /CRC32/);
});

test('small archives and empty ZIPs work with suffix ranges shorter than the requested tail', async t => {
    const tiny = new JSZip();
    tiny.file('small.txt', 'Small');
    const smallServer = await mockServer(t, await tiny.generateAsync({ type: 'nodebuffer' }));
    const archive = await RemoteZip.open(smallServer.url);
    t.after(() => archive.close());
    assert.equal(await archive.read('small.txt'), 'Small');
    const emptyServer = await mockServer(t, await new JSZip().generateAsync({ type: 'nodebuffer' }));
    const empty = await RemoteZip.open(emptyServer.url);
    t.after(() => empty.close());
    assert.deepEqual(empty.names(), []);
});

test('reads a central directory larger than the tail window', async t => {
    const manyEntries = new JSZip();
    for (let i = 0; i < 1600; i++) manyEntries.file(`chapter-${String(i).padStart(4, '0')}.xhtml`, `Chapter ${i}`);
    const server = await mockServer(t, await manyEntries.generateAsync({ type: 'nodebuffer' }));
    const archive = await RemoteZip.open(server.url);
    t.after(() => archive.close());
    assert.equal(archive.names().length, 1600);
    assert.equal(server.requests.length, 2); // Tail plus the complete central directory.
    assert.equal(await archive.read('chapter-0000.xhtml'), 'Chapter 0');
});

test('persistent ranges are reusable and scoped to the supplied user/book identity', async t => {
    const originalCaches = globalThis.caches;
    const stored = new Map();
    globalThis.caches = { open: async () => ({
        match: async key => stored.get(typeof key === 'string' ? key : key.url)?.clone(),
        keys: async () => Array.from(stored.keys(), url => new Request(url)),
        delete: async key => stored.delete(typeof key === 'string' ? key : key.url),
        put: async (key, response) => {
            assert.equal(response.status, 200, 'Cache API does not accept status 206');
            stored.set(typeof key === 'string' ? key : key.url, response.clone());
        }
    }) };
    t.after(() => { globalThis.caches = originalCaches; });
    const server = await mockServer(t);
    const first = await RemoteZip.open(server.url, { cacheKey: 'user-one/book/version-1' });
    assert.equal(await first.read('OPS/chapter.xhtml'), chapter);
    first.close();
    for (let attempts = 0; stored.size < 3 && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stored.size, 3);
    const firstRequests = server.requests.length;
    const reopened = await RemoteZip.open(server.url, { cacheKey: 'user-one/book/version-1' });
    assert.equal(await reopened.read('OPS/chapter.xhtml'), chapter);
    reopened.close();
    assert.equal(server.requests.length, firstRequests);
    const otherUser = await RemoteZip.open(server.url, { cacheKey: 'user-two/book/version-1' });
    assert.equal(await otherUser.read('OPS/chapter.xhtml'), chapter);
    otherUser.close();
    assert.equal(server.requests.length, firstRequests + 3);
});
