'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { CACHE_VERSION, layoutError, validateBookId, layoutVersion, describeSource } = require('./layout-source');

function createLayoutQueue(cacheDirectory, { uploadsDir } = {}) {
    if (!uploadsDir) throw new Error('The layout queue requires an uploads directory.');
    const cacheRoot = path.resolve(cacheDirectory);
    const jobs = new Map();
    const locks = new Map();
    const revoked = new Set();
    let active = null;
    let stopping = false;
    let scheduled = false;
    const initialized = Promise.all([fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 }), layoutVersion()]);
    initialized.catch(() => {});

    function locked(bookId, operation) {
        const previous = locks.get(bookId) || Promise.resolve();
        const result = previous.catch(() => {}).then(operation);
        locks.set(bookId, result);
        result.finally(() => { if (locks.get(bookId) === result) locks.delete(bookId); }).catch(() => {});
        return result;
    }
    function assertAvailable(bookId) {
        if (stopping) throw layoutError(503, 'The layout server is stopping.');
        if (revoked.has(bookId)) throw layoutError(410, 'The book was deleted.');
    }
    function current(job) {
        return !stopping && !revoked.has(job.bookId) && !job.canceled && jobs.get(job.bookId) === job;
    }
    function publicState(job) {
        return { status: job.status, sourceVersion: job.sourceVersion,
            ...(job.status === 'ready' ? { bundlePath: job.bundlePath } : {}),
            ...(job.status === 'failed' ? { error: job.error } : {}) };
    }
    async function persist(job) {
        const metadata = { version: CACHE_VERSION, sourceVersion: job.sourceVersion, source: job.source,
            status: job.status, ...(job.status === 'ready' ? { bytes: job.bytes } : { error: job.error }) };
        const temporary = path.join(job.directory, `.${crypto.randomUUID()}.json.tmp`);
        try {
            await fs.writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
            if (!current(job)) return;
            await fs.rename(temporary, job.metadataPath);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }
    async function cached(job) {
        try {
            const data = JSON.parse(await fs.readFile(job.metadataPath, 'utf8'));
            if (data.version !== CACHE_VERSION || data.sourceVersion !== job.sourceVersion ||
                JSON.stringify(data.source) !== JSON.stringify(job.source)) return false;
            if (data.status === 'failed' && typeof data.error === 'string' && data.error) {
                job.status = 'failed';
                job.error = data.error;
                return true;
            }
            if (data.status !== 'ready' || !Number.isSafeInteger(data.bytes) || data.bytes <= 0) return false;
            const [real, stats] = await Promise.all([fs.realpath(job.bundlePath), fs.lstat(job.bundlePath)]);
            if (real !== job.bundlePath || !stats.isFile() || stats.size !== data.bytes) return false;
            job.status = 'ready';
            job.bytes = data.bytes;
            return true;
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
            throw error;
        }
    }
    function generate(job) {
        return new Promise((resolve, reject) => {
            let message;
            const worker = new Worker(path.join(__dirname, 'layout-worker.js'), {
                workerData: { source: job.source, temporaryPath: job.temporaryPath }
            });
            job.worker = worker;
            worker.once('message', value => { message = value; });
            worker.once('error', reject);
            worker.once('exit', code => {
                if (code !== 0 || !message) return reject(new Error(`Layout worker exited without a result (code ${code}).`));
                if (message.status !== 'ready') return reject(new Error(message.error || 'Layout generation failed.'));
                if (!Number.isSafeInteger(message.bytes) || message.bytes <= 0) return reject(new Error('Layout worker produced an invalid bundle.'));
                resolve(message);
            });
        });
    }
    async function run(job) {
        try {
            const result = await generate(job);
            let changed = false;
            await locked(job.bookId, async () => {
                if (!current(job)) return;
                const source = await describeSource(job.source.archivePath, uploadsDir, job.source.layoutVersion);
                if (!current(job)) return;
                if (source.sourceVersion !== job.sourceVersion) {
                    changed = true;
                    return;
                }
                await fs.rename(job.temporaryPath, job.bundlePath);
                if (!current(job)) return;
                job.bytes = result.bytes;
                job.status = 'ready';
                await persist(job);
            });
            if (changed && current(job)) await ensure({ bookId: job.bookId, archivePath: job.source.archivePath });
        } catch (error) {
            await locked(job.bookId, async () => {
                if (!current(job)) return;
                job.status = 'failed';
                job.error = String(error.message || error).slice(0, 1024);
                try { await persist(job); } catch (cacheError) {
                    job.error = `${job.error} (Could not persist the layout error: ${cacheError.message})`.slice(0, 1024);
                }
            });
        } finally {
            await fs.rm(job.temporaryPath, { force: true }).catch(() => {});
        }
    }
    function wake() {
        if (stopping || active || scheduled) return;
        scheduled = true;
        setImmediate(() => {
            scheduled = false;
            if (stopping || active) return;
            const job = Array.from(jobs.values()).find(candidate => candidate.status === 'pending' && !candidate.canceled);
            if (!job) return;
            active = job;
            job.status = 'processing';
            job.execution = run(job).finally(() => {
                active = null;
                wake();
            });
            job.execution.catch(() => {});
        });
    }
    async function ensure({ bookId, archivePath }) {
        validateBookId(bookId);
        assertAvailable(bookId);
        return locked(bookId, async () => {
            const [, version] = await initialized;
            assertAvailable(bookId);
            const descriptor = await describeSource(archivePath, uploadsDir, version);
            assertAvailable(bookId);
            const previous = jobs.get(bookId);
            if (previous?.sourceVersion === descriptor.sourceVersion) return publicState(previous);
            if (previous) {
                previous.canceled = true;
                jobs.delete(bookId);
                if (previous.worker) await previous.worker.terminate();
                await fs.rm(previous.directory, { recursive: true, force: true });
                assertAvailable(bookId);
            }
            const bookDirectory = path.join(cacheRoot, bookId);
            const directory = path.join(bookDirectory, descriptor.sourceVersion);
            const job = { bookId, ...descriptor, directory, status: 'pending', canceled: false,
                bundlePath: path.join(directory, 'bundle.zip'), metadataPath: path.join(directory, 'source.json'),
                temporaryPath: path.join(directory, `.${crypto.randomUUID()}.zip.tmp`) };
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            for (const entry of await fs.readdir(bookDirectory)) {
                if (entry !== descriptor.sourceVersion) {
                    await fs.rm(path.join(bookDirectory, entry), { recursive: true, force: true });
                }
            }
            for (const entry of await fs.readdir(directory)) {
                if (entry.startsWith('.') && entry.endsWith('.tmp')) {
                    await fs.rm(path.join(directory, entry), { force: true });
                }
            }
            await cached(job);
            assertAvailable(bookId);
            jobs.set(bookId, job);
            wake();
            return publicState(job);
        });
    }
    async function deleteBook(bookId) {
        validateBookId(bookId);
        revoked.add(bookId);
        const previous = jobs.get(bookId);
        if (previous) previous.canceled = true;
        jobs.delete(bookId);
        await locked(bookId, async () => {
            if (previous?.worker) await previous.worker.terminate();
            await fs.rm(path.join(cacheRoot, bookId), { recursive: true, force: true });
        });
    }
    async function shutdown() {
        stopping = true;
        for (const job of jobs.values()) job.canceled = true;
        if (active?.worker) await active.worker.terminate();
        if (active?.execution) await active.execution;
        await Promise.allSettled(Array.from(locks.values()));
    }

    return { ensure, deleteBook, shutdown };
}

module.exports = createLayoutQueue;
