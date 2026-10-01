'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createOcrQueue = require('./ocr-queue');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-queue-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'compute-jobs.json');
    let clock = 1000;
    const options = { leaseSeconds: 30, now: () => clock };
    return { queue: createOcrQueue(filename, options), reopen: () => createOcrQueue(filename, options), advance: milliseconds => { clock += milliseconds; } };
}
const book = { bookId: 'book_1', sourceVersion: 'original', totalPages: 4 };

test('CPU and remote claims partition modes and only one claimant owns a page', t => {
    const { queue } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute', fromPage: 2, toPage: 3 });
    queue.ensurePage({ ...book, mode: 'vps', page: 1 });
    assert.equal(queue.claim('vps').page, 1);
    assert.equal(queue.claim('vps'), null);
    const first = queue.claim('compute');
    const second = queue.claim('compute');
    assert.deepEqual([first.page, second.page], [2, 3]);
    assert.notEqual(first.leaseToken, second.leaseToken);
    assert.equal(queue.claim('compute'), null);
    assert.equal(queue.isActive(first.id, first.leaseToken, 'vps'), false);
    assert.deepEqual(queue.status(book.bookId).counts, { pending: 0, processing: 3, completed: 0, failed: 0 });
});

test('expired leases requeue and heartbeat extends ownership without authorizing old tokens', t => {
    const { queue, advance } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute', fromPage: 1, toPage: 1 });
    const first = queue.claim('compute');
    advance(20000);
    assert.deepEqual(queue.renew(first.id, first.leaseToken), { leaseSeconds: 30 });
    advance(20000);
    assert.equal(queue.claim('compute'), null);
    advance(10001);
    const replacement = queue.claim('compute');
    assert.equal(replacement.id, first.id);
    assert.notEqual(replacement.leaseToken, first.leaseToken);
    assert.throws(() => queue.renew(first.id, first.leaseToken), error => error.statusCode === 409);
});

test('restart preserves preference, completed pages and pending jobs while revoking processing leases', async t => {
    const { queue, reopen } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute' });
    const completed = queue.claim('compute');
    await queue.complete(completed.id, completed.leaseToken, 'compute', async () => {});
    const interrupted = queue.claim('compute');
    const restored = reopen();
    assert.equal(restored.status(book.bookId).mode, 'compute');
    assert.equal(restored.status(book.bookId).totalPages, 4);
    assert.deepEqual(restored.status(book.bookId).counts, { pending: 3, processing: 0, completed: 1, failed: 0 });
    assert.equal(restored.isActive(interrupted.id, interrupted.leaseToken, 'compute'), false);
    let duplicateWrites = 0;
    await restored.complete(completed.id, completed.leaseToken, 'compute', async () => { duplicateWrites++; });
    assert.equal(duplicateWrites, 0);
});

test('retarget revokes an in-flight CPU generation and does not permit stale completion', async t => {
    const { queue } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'vps', fromPage: 1, toPage: 1 });
    const cpu = queue.claim('vps');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let writes = 0;
    const completing = queue.complete(cpu.id, cpu.leaseToken, 'vps', async (job, isCurrent) => {
        await gate;
        if (!isCurrent()) throw new Error('obsolete generation');
        writes++;
    });
    queue.enqueueBook({ ...book, mode: 'compute', fromPage: 1, toPage: 1 });
    release();
    await assert.rejects(completing, /obsolete generation/);
    assert.equal(writes, 0);
    assert.equal(queue.claim('vps'), null);
    assert.equal(queue.claim('compute').page, 1);
});

test('source changes and book deletion invalidate late results and reset stale page metadata', async t => {
    const { queue } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute' });
    const stale = queue.claim('compute');
    queue.updateBook({ bookId: book.bookId, sourceVersion: 'replacement', mode: 'compute' });
    assert.equal(queue.status(book.bookId).totalPages, 0);
    assert.deepEqual(queue.status(book.bookId).jobs, []);
    await assert.rejects(queue.complete(stale.id, stale.leaseToken, 'compute', async () => assert.fail('stale commit')), error => error.statusCode === 410);
    queue.enqueueBook({ ...book, sourceVersion: 'replacement', mode: 'compute' });
    const deleted = queue.claim('compute');
    queue.deleteBook(book.bookId);
    assert.throws(() => queue.getLease(deleted.id, deleted.leaseToken, 'compute'), error => error.statusCode === 410);
    assert.equal(queue.claim('compute'), null);
});

test('a completion write failure remains failed and cannot be reported as completed', async t => {
    const { queue, reopen } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute', fromPage: 1, toPage: 1 });
    const job = queue.claim('compute');
    await assert.rejects(queue.complete(job.id, job.leaseToken, 'compute', async () => { throw new Error('disk full'); }), /disk full/);
    assert.deepEqual(reopen().status(book.bookId).counts, { pending: 0, processing: 0, completed: 0, failed: 1 });
    assert.equal(queue.status(book.bookId).jobs[0].error, 'disk full');
    assert.equal(queue.claim('vps'), null);
    assert.equal(queue.claim('compute'), null);
});

test('worker stop requeues but inference failure never falls back to CPU', t => {
    const { queue } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute', fromPage: 1, toPage: 1 });
    const interrupted = queue.claim('compute');
    queue.fail(interrupted.id, interrupted.leaseToken, 'compute', 'worker stopping', true);
    assert.equal(queue.claim('vps'), null);
    const retried = queue.claim('compute');
    queue.fail(retried.id, retried.leaseToken, 'compute', 'model failed', false);
    assert.equal(queue.status(book.bookId).jobs[0].status, 'failed');
    assert.equal(queue.claim('vps'), null);
    assert.throws(() => queue.getLease(retried.id, retried.leaseToken, 'compute'), error => error.statusCode === 409);
});

test('range validation has no partial enqueue and retarget leaves unselected pages assigned remotely', t => {
    const { queue } = fixture(t);
    assert.throws(() => queue.enqueueBook({ ...book, mode: 'compute', fromPage: 3, toPage: 5 }), error => error.statusCode === 400);
    assert.deepEqual(queue.status(book.bookId).jobs, []);
    queue.enqueueBook({ ...book, mode: 'compute' });
    queue.enqueueBook({ ...book, mode: 'vps', fromPage: 2, toPage: 3 });
    assert.deepEqual(queue.status(book.bookId).jobs.filter(job => job.mode === 'compute').map(job => job.page), [1, 4]);
    assert.deepEqual(queue.status(book.bookId).jobs.filter(job => job.mode === 'vps').map(job => job.page), [2, 3]);
});

test('disabling a book revokes pending and saving leases, preserving completed results across restart', async t => {
    const { queue, reopen } = fixture(t);
    queue.enqueueBook({ ...book, mode: 'compute', forceOcr: true });
    const completed = queue.claim('compute');
    await queue.complete(completed.id, completed.leaseToken, 'compute', async () => {});
    const saving = queue.claim('compute');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let published = false;
    const completion = queue.complete(saving.id, saving.leaseToken, 'compute', async (_, isCurrent) => {
        await gate;
        if (!isCurrent()) throw new Error('OCR disabled during save');
        published = true;
    });
    queue.cancelBook(book.bookId);
    release();
    await assert.rejects(completion, /OCR disabled during save/);
    assert.equal(published, false);
    assert.equal(queue.claim('compute'), null);
    assert.throws(() => queue.renew(saving.id, saving.leaseToken), error => error.statusCode === 410);
    assert.deepEqual(reopen().status(book.bookId).counts, { pending: 0, processing: 0, completed: 1, failed: 0 });
    queue.ensurePage({ ...book, mode: 'compute', page: 2, forceOcr: true });
    const manual = queue.claim('compute');
    assert.notEqual(manual.id, saving.id);
    assert.equal(queue.isActive(saving.id, saving.leaseToken, 'compute'), false);
    assert.equal(queue.isActive(manual.id, manual.leaseToken, 'compute'), true);
});

test('native-book cutover cancels only automatic jobs and explicit scan upgrades revoke the old generation', t => {
    const { queue } = fixture(t);
    queue.ensurePage({ ...book, mode: 'vps', page: 1 });
    const automatic = queue.claim('vps');
    const upgraded = queue.ensurePage({ ...book, mode: 'vps', page: 1, forceOcr: true });
    assert.notEqual(upgraded.id, automatic.id);
    assert.equal(queue.isActive(automatic.id, automatic.leaseToken, 'vps'), false);
    queue.ensurePage({ ...book, mode: 'compute', page: 2 });
    queue.cancelBook(book.bookId, { automaticOnly: true });
    assert.equal(queue.claim('compute'), null);
    const explicit = queue.claim('vps');
    assert.equal(explicit.id, upgraded.id);
    assert.equal(queue.isActive(explicit.id, explicit.leaseToken, 'vps'), true);
});
