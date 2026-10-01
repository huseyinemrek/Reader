'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function queueError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

function createOcrQueue(filename, { pipelineVersion = 15, leaseSeconds = 300, now = Date.now } = {}) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30) throw new Error('OCR_LEASE_SECONDS must be an integer of at least 30.');
    let state = { version: 1, books: {}, jobs: [] };
    const completing = new Set();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) {
        state = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (state.version !== 1 || !state.books || !Array.isArray(state.jobs)) throw new Error('Invalid OCR queue file; restore its backup before starting.');
    }
    function save() {
        const temporary = filename + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
        fs.renameSync(temporary, filename);
    }
    function reset(job) {
        job.status = 'pending';
        delete job.leaseToken;
        delete job.expiresAt;
        delete job.error;
    }
    let recovered = false;
    for (const job of state.jobs) {
        if (job.status === 'processing') { reset(job); recovered = true; }
    }
    if (recovered || !fs.existsSync(filename)) save();

    function recoverExpired() {
        let changed = false;
        for (const job of state.jobs) {
            if (job.mode === 'compute' && job.status === 'processing' && job.expiresAt <= now()) {
                reset(job);
                changed = true;
            }
        }
        if (changed) save();
    }
    function source(bookId, sourceVersion, totalPages) {
        const previous = state.books[bookId];
        if (previous && previous.sourceVersion !== sourceVersion) {
            state.jobs = state.jobs.filter(job => job.bookId !== bookId);
        }
        const pages = totalPages ?? (previous?.sourceVersion === sourceVersion ? previous.totalPages : 0) ?? 0;
        const changed = !previous || previous.sourceVersion !== sourceVersion || previous.totalPages !== pages;
        state.books[bookId] = { mode: previous?.mode || 'vps', totalPages: pages, sourceVersion };
        return changed;
    }
    function add(bookId, page, mode, sourceVersion, forceOcr) {
        const job = { id: crypto.randomUUID(), bookId, page, mode, sourceVersion, pipelineVersion,
            status: 'pending', forceOcr: Boolean(forceOcr), createdAt: now() };
        state.jobs.push(job);
        return job;
    }
    function ensurePage({ bookId, page, mode = 'vps', sourceVersion, totalPages, forceOcr = false }) {
        recoverExpired();
        let changed = source(bookId, sourceVersion, totalPages);
        let job = state.jobs.find(candidate => candidate.bookId === bookId && candidate.page === page && candidate.pipelineVersion === pipelineVersion);
        if (job && forceOcr && !job.forceOcr) {
            state.jobs = state.jobs.filter(candidate => candidate.id !== job.id);
            job = null;
            changed = true;
        }
        if (!job) { job = add(bookId, page, mode, sourceVersion, forceOcr); changed = true; }
        if (changed) save();
        return publicJob(job);
    }
    function enqueueBook({ bookId, sourceVersion, totalPages, mode, fromPage = 1, toPage = totalPages, forceOcr = false }) {
        if (!['vps', 'compute'].includes(mode)) throw queueError(400, 'OCR mode must be vps or compute.');
        if (!Number.isSafeInteger(totalPages) || totalPages < 1 || !Number.isSafeInteger(fromPage) ||
            !Number.isSafeInteger(toPage) || fromPage < 1 || toPage < fromPage || toPage > totalPages) {
            throw queueError(400, 'Invalid inclusive page range.');
        }
        source(bookId, sourceVersion, totalPages);
        state.books[bookId].mode = mode;
        // New identities revoke every old lease in the selected range, including CPU inference.
        state.jobs = state.jobs.filter(job => job.bookId !== bookId || job.page < fromPage || job.page > toPage);
        for (let page = fromPage; page <= toPage; page++) add(bookId, page, mode, sourceVersion, forceOcr || mode === 'compute');
        save();
        return status(bookId);
    }
    function updateBook({ bookId, sourceVersion, totalPages, mode = 'vps' }) {
        const changed = source(bookId, sourceVersion, totalPages);
        const modeChanged = state.books[bookId].mode !== mode;
        state.books[bookId].mode = mode;
        if (changed || modeChanged) save();
    }
    function publicJob(job) {
        return { id: job.id, page: job.page, status: job.status, mode: job.mode, ...(job.error ? { error: job.error } : {}) };
    }
    function status(bookId) {
        recoverExpired();
        const book = state.books[bookId];
        const jobs = state.jobs.filter(job => job.bookId === bookId && job.pipelineVersion === pipelineVersion).map(publicJob);
        const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
        for (const job of jobs) counts[job.status]++;
        return { mode: book?.mode || 'vps', totalPages: book?.totalPages || 0, counts, jobs };
    }
    function claim(mode) {
        recoverExpired();
        const job = state.jobs.find(candidate => candidate.mode === mode && candidate.status === 'pending' && candidate.pipelineVersion === pipelineVersion);
        if (!job) return null;
        job.status = 'processing';
        job.leaseToken = crypto.randomBytes(32).toString('hex');
        job.expiresAt = now() + leaseSeconds * 1000;
        try { save(); } catch (error) { reset(job); throw error; }
        return { ...job, leaseSeconds };
    }
    function getLease(id, token, mode, allowCompleted = false) {
        recoverExpired();
        const job = state.jobs.find(candidate => candidate.id === id);
        if (!job) throw queueError(410, 'OCR job was deleted, replaced, or its source changed.');
        if (job.mode !== mode || typeof token !== 'string' || job.leaseToken !== token ||
            !(job.status === 'processing' || allowCompleted && job.status === 'completed')) {
            throw queueError(409, 'OCR lease is no longer owned by this worker.');
        }
        return { ...job };
    }
    function isActive(id, token, mode) {
        try { getLease(id, token, mode); return true; } catch (_) { return false; }
    }
    function renew(id, token) {
        getLease(id, token, 'compute');
        const job = state.jobs.find(candidate => candidate.id === id);
        job.expiresAt = now() + leaseSeconds * 1000;
        save();
        return { leaseSeconds };
    }
    async function complete(id, token, mode, commit) {
        const leased = getLease(id, token, mode, true);
        if (leased.status === 'completed') return { success: true, jobId: id };
        if (completing.has(id)) throw queueError(409, 'OCR completion is already being saved.');
        completing.add(id);
        try {
            await commit(leased, () => isActive(id, token, mode));
            getLease(id, token, mode);
            const job = state.jobs.find(candidate => candidate.id === id);
            job.status = 'completed';
            delete job.error;
            try { save(); } catch (error) { job.status = 'processing'; throw error; }
            return { success: true, jobId: id };
        } catch (error) {
            if (isActive(id, token, mode)) fail(id, token, mode, error.message || 'OCR completion could not be saved.', false);
            throw error;
        } finally {
            completing.delete(id);
        }
    }
    function fail(id, token, mode, error, requeue = false) {
        getLease(id, token, mode);
        const job = state.jobs.find(candidate => candidate.id === id);
        if (requeue) reset(job);
        else {
            job.status = 'failed';
            job.error = String(error || 'OCR failed.').slice(0, 2000);
            delete job.leaseToken;
            delete job.expiresAt;
        }
        save();
        return { success: true, jobId: id };
    }
    function cancelBook(bookId, { automaticOnly = false } = {}) {
        const previousLength = state.jobs.length;
        state.jobs = state.jobs.filter(job => job.bookId !== bookId || job.status === 'completed' ||
            automaticOnly && job.forceOcr);
        if (state.jobs.length !== previousLength) save();
    }
    function deleteBook(bookId) {
        state.jobs = state.jobs.filter(job => job.bookId !== bookId);
        delete state.books[bookId];
        save();
    }
    return { ensurePage, enqueueBook, updateBook, status, claim, getLease, isActive, renew, complete, fail, cancelBook, deleteBook, recoverExpired };
}

module.exports = createOcrQueue;
