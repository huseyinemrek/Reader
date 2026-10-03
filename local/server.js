const path = require('path');
require('dotenv').config({ path: process.env.READER_ENV_FILE || path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const yauzl = require('yauzl');
const createPdfOcr = require('./pdf-ocr');
const crypto = require('crypto');
const createOcrQueue = require('./ocr-queue');
const createLayoutQueue = require('./layout-queue');
const { createAuthMiddleware, resolveProjectId } = require('./firebase-auth');

const MODE = process.env.READER_MODE === 'vps' ? 'vps' : 'local';
const firebaseAuth = createAuthMiddleware();
function requireAuth(req, res, next) {
    if (MODE === 'vps' && process.env.DISABLE_AUTH === 'true' &&
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
        return res.status(403).json({ error: 'DISABLE_AUTH is only available on loopback for isolated smoke runs.' });
    }
    if (MODE === 'vps' && process.env.DISABLE_AUTH !== 'true' && !resolveProjectId()) {
        return res.status(503).json({ error: 'Set FIREBASE_PROJECT_ID and Firebase client settings in vps/.env before using the VPS library.' });
    }
    return firebaseAuth(req, res, next);
}
const app = express();
const PORT = process.env.PORT || 3000;
const WORKER_SECRET = (process.env.WORKER_SECRET || '').trim();
function requireWorker(req, res, next) {
    if (MODE !== 'vps') return res.status(404).json({ error: 'Compute workers are only available on the VPS server.' });
    if (WORKER_SECRET.length < 32) return res.status(503).json({ error: 'Set a random WORKER_SECRET of at least 32 characters in vps/.env, then restart the VPS server to enable computer mode.' });
    const authorization = req.get('Authorization') || '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expected = Buffer.from(WORKER_SECRET);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return res.status(401).json({ error: 'Worker authorization required.' });
    }
    next();
}

app.use(cors());
app.use('/api/compute', requireWorker, express.json({ limit: '64mb' }));
app.use(express.json({ limit: '1mb' }));

// Yükleme klasörleri
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.READER_DEFAULT_DATA_DIR || __dirname);
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const DB_FILE = path.join(DATA_DIR, 'library.json');
const LAYOUT_CACHE_DIR = path.join(DATA_DIR, 'layout-cache');

// Klasörleri oluştur
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

const pdfOcr = createPdfOcr(UPLOADS_DIR);
const layoutQueue = createLayoutQueue(LAYOUT_CACHE_DIR, { uploadsDir: UPLOADS_DIR });

// Veritabanını yükle
let library = [];
if (fs.existsSync(DB_FILE)) {
    try {
        library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!Array.isArray(library)) throw new Error('Library must contain a JSON array.');
    } catch (error) {
        throw new Error(`Cannot load library.json: ${error.message}. Restore the library before starting.`);
    }
} else {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

function saveDB() {
    const temporary = DB_FILE + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(library, null, 2));
    fs.renameSync(temporary, DB_FILE);
}
const ocrQueue = MODE === 'vps' ? createOcrQueue(path.join(DATA_DIR, 'compute-jobs.json'), {
    pipelineVersion: pdfOcr.pipelineVersion, leaseSeconds: Number(process.env.OCR_LEASE_SECONDS || 300)
}) : null;
if (ocrQueue) {
    for (const bookId of Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'compute-jobs.json'), 'utf8')).books)) {
        if (!library.some(book => book.id === bookId)) ocrQueue.deleteBook(bookId);
    }
}
const metadataCache = new Map();
const ocrRevisions = new Map();
let cpuRunning = false;
let cpuJob = null;
let stopping = false;

function ownedBook(req) {
    const book = library.find(candidate => candidate.id === req.params.id && (!candidate.userId || candidate.userId === req.user.uid));
    if (!book) throw Object.assign(new Error('Kitap bulunamadı.'), { statusCode: 404 });
    return book;
}
function pdfPathFor(book) {
    const filename = book.fileName;
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.pdf')) {
        throw Object.assign(new Error('Bu kitap bir PDF değil.'), { statusCode: 415 });
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(book.id) || /[\\/]/.test(filename) ||
        !filename.startsWith(`${book.id}_`) || book.bookUrl !== `/uploads/${filename}`) {
        throw Object.assign(new Error('PDF dosyası için güvenli kitap yolu bulunamadı.'), { statusCode: 400 });
    }
    return path.join(UPLOADS_DIR, filename);
}
function sendError(res, error) {
    if (!res.headersSent) res.status(Number.isInteger(error.statusCode) ? error.statusCode : 500).json({ error: error.message || 'İşlem başarısız.' });
}
async function describeBook(book) {
    const pdfPath = pdfPathFor(book);
    const source = await pdfOcr.getSource({ bookId: book.id, pdfPath });
    let descriptor = metadataCache.get(book.id);
    if (!descriptor || descriptor.sourceVersion !== source.sourceVersion) {
        descriptor = await pdfOcr.describePdf({ bookId: book.id, pdfPath });
        metadataCache.set(book.id, descriptor);
    }
    const ocrMode = ['auto', 'on', 'off'].includes(book.ocrMode) ? book.ocrMode : 'auto';
    const hasOcr = (await pdfOcr.hasOcrCache(book.id)) ||
        Boolean(ocrQueue?.status(book.id).jobs.some(j => ['pending', 'processing', 'completed'].includes(j.status)));
    return { ...descriptor, pdfPath, ocrMode, hasOcr,
        automaticOcr: ocrMode === 'on' || ocrMode === 'auto' && descriptor.textLayer === 'scanned' };
}
async function freshJob(job) {
    const book = library.find(candidate => candidate.id === job.bookId);
    if (!book) throw Object.assign(new Error('The book was deleted.'), { statusCode: 410 });
    const pdfPath = pdfPathFor(book);
    const source = await pdfOcr.getSource({ bookId: book.id, pdfPath });
    if (source.sourceVersion !== job.sourceVersion) {
        ocrQueue.updateBook({ bookId: book.id, sourceVersion: source.sourceVersion, mode: book.computeMode || 'vps' });
        throw Object.assign(new Error('The PDF source changed; enqueue it again.'), { statusCode: 409 });
    }
    if (!job.forceOcr) {
        const descriptor = await describeBook(book);
        if (!descriptor.automaticOcr) {
            ocrQueue.cancelBook(book.id, { automaticOnly: true });
            throw Object.assign(new Error('Automatic OCR is disabled for this book.'), { statusCode: 410 });
        }
    }
    return { book, pdfPath };
}
function wakeCpu() {
    if (!ocrQueue || cpuRunning || stopping) return;
    cpuRunning = true;
    setImmediate(async () => {
        try {
            while (!stopping) {
                const job = ocrQueue.claim('vps');
                if (!job) break;
                cpuJob = job;
                try {
                    const { pdfPath } = await freshJob(job);
                    await ocrQueue.complete(job.id, job.leaseToken, 'vps', async (leased, isCurrent) => {
                        await pdfOcr.getPdfPage({ bookId: job.bookId, pdfPath, page: job.page, nativeOnly: false,
                            forceOcr: true, regenerate: Boolean(job.forceOcr), generation: job.id,
                            expectedSourceVersion: job.sourceVersion, isCurrent });
                    });
                } catch (error) {
                    if (ocrQueue.isActive(job.id, job.leaseToken, 'vps')) {
                        ocrQueue.fail(job.id, job.leaseToken, 'vps', error.message, stopping);
                    }
                }
                cpuJob = null;
            }
        } finally {
            cpuRunning = false;
        }
    });
}

if (MODE === 'vps') {
    app.get('/uploads/*', requireAuth, async (req, res) => {
        try {
            const relative = req.params[0];
            if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
                return res.status(404).json({ error: 'Dosya bulunamadı.' });
            }
            const url = '/uploads/' + relative;
            const generated = relative.match(/^pdf\/([A-Za-z0-9_-]{1,128})\/page-[1-9]\d*-v[1-9]\d*(?:-native)?(?:-region-[1-9]\d*)?\.png$/);
            const book = library.find(candidate => (!candidate.userId || candidate.userId === req.user.uid) &&
                (generated ? candidate.id === generated[1] : candidate.bookUrl === url || candidate.coverUrl === url));
            if (!book) return res.status(404).json({ error: 'Dosya bulunamadı.' });
            const filename = path.join(UPLOADS_DIR, relative);
            const real = await fs.promises.realpath(filename);
            if (real !== filename || !(await fs.promises.lstat(filename)).isFile()) return res.status(404).json({ error: 'Dosya bulunamadı.' });
            res.set('Cache-Control', 'private, no-store');
            return res.sendFile(filename);
        } catch (error) {
            if (error.code === 'ENOENT') return res.status(404).json({ error: 'Dosya bulunamadı.' });
            sendError(res, error);
        }
    });
}

// Multer ayarları (Dosyaları hafızaya alıp sonra diske yazacağız çünkü kapak resmini ayrı alıyoruz)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Only public browser assets are exposed; backend source, data and secrets are never static.
for (const filename of ['index.html', 'script.js', 'style.css', 'firebase-config.js']) {
    app.get(filename === 'index.html' ? ['/', '/index.html'] : `/${filename}`, (req, res) => res.sendFile(path.join(__dirname, filename)));
}
app.get('/book/:id', (req, res) => {
    if (!/^book_[A-Za-z0-9_-]{1,123}$/.test(req.params.id)) return res.status(404).json({ error: 'Kitap yolu bulunamadı.' });
    return res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/libs/jszip.min.js', (req, res) => res.sendFile(path.join(__dirname, 'libs', 'jszip.min.js')));
for (const filename of ['layout-bundle.js', 'cloud-reader.js', 'range-archive.js', 'upload-queue.js',
    'pdf-outline.js', 'pdf-reader.js', 'pdf-viewer.js', 'pdf-layout-view.js', 'pdf-layout.css',
    'server-reader.js', 'pdf-layout-core.mjs', 'pdf-fonts.mjs', 'pdf-graphics.mjs', 'pdf-source-selection.mjs',
    'reader-link-history.js', 'reader-link-history.css', 'epub-pagination.js', 'epub-object-view.js', 'page-turn.js', 'page-turn.css', 'reader-tts.js', 'reader-theme.css', 'reader-toc.js']) {
    app.get(`/reader-core/${filename}`, (req, res) => res.sendFile(path.join(__dirname, '..', 'hosting', 'public', filename)));
}
for (const directory of ['katex/dist', 'pdfjs-dist/build', 'pdfjs-dist/cmaps', 'pdfjs-dist/standard_fonts', 'pdfjs-dist/wasm']) {
    app.use(`/node_modules/${directory}`, express.static(path.join(__dirname, 'node_modules', directory), { dotfiles: 'deny', index: false, redirect: false }));
}
if (MODE === 'local') app.use('/uploads', express.static(UPLOADS_DIR, { dotfiles: 'deny', index: false }));

const EPUB_ENTRY_MIME_TYPES = Object.freeze({
    '.xhtml': 'application/xhtml+xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject'
});

function normalizeEpubEntryPath(rawEntryPath) {
    if (typeof rawEntryPath !== 'string' || rawEntryPath.length === 0) return null;
    if (rawEntryPath.includes('\0') || rawEntryPath.includes('\\')) return null;

    const parts = rawEntryPath.split('/');
    if (parts.some(part => part.length === 0 || part === '.' || part === '..')) return null;
    return parts.join('/');
}

function getBookArchivePath(book) {
    let fileName = typeof book.fileName === 'string' ? book.fileName : null;
    if (!fileName && typeof book.bookUrl === 'string' && book.bookUrl.startsWith('/uploads/')) {
        fileName = book.bookUrl.slice('/uploads/'.length);
    }
    if (!fileName || fileName.includes('\0') || fileName.includes('/') || fileName.includes('\\')) {
        return null;
    }

    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const archivePath = path.resolve(uploadsRoot, fileName);
    const relativePath = path.relative(uploadsRoot, archivePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
    return archivePath;
}

function scheduleLayout(book) {
    const archivePath = getBookArchivePath(book);
    if (!archivePath || !/\.(?:epub|htmlz|zip)$/i.test(archivePath)) return;
    layoutQueue.ensure({ bookId: book.id, archivePath }).catch(error => {
        if (!stopping) console.warn('Layout bundle scheduling failed:', error.message);
    });
}

function getEpubEntryMimeType(entryName) {
    const extension = path.posix.extname(entryName).toLowerCase();
    return EPUB_ENTRY_MIME_TYPES[extension] || 'application/octet-stream';
}

function serveEpubEntry(req, res) {
    const userUid = req.user ? req.user.uid : null;
    const book = library.find(item => item.id === req.params.id && (!item.userId || item.userId === userUid));
    if (!book) {
        return res.status(404).json({ error: "Kitap bulunamadı." });
    }

    const entryName = normalizeEpubEntryPath(req.params[0]);
    if (!entryName) {
        return res.status(400).json({ error: "Geçersiz EPUB yolu." });
    }

    const archivePath = getBookArchivePath(book);
    if (!archivePath) {
        return res.status(404).json({ error: "Kitap dosyası bulunamadı." });
    }

    let responseClosed = res.destroyed;
    const earlyResponseCloseHandler = () => {
        responseClosed = true;
    };
    res.once('close', earlyResponseCloseHandler);
    const releaseEarlyResponseCloseHandler = () => {
        res.removeListener('close', earlyResponseCloseHandler);
    };

    fs.stat(archivePath, (statError, archiveStats) => {
        if (responseClosed || res.destroyed) {
            return releaseEarlyResponseCloseHandler();
        }
        if (statError || !archiveStats.isFile()) {
            releaseEarlyResponseCloseHandler();
            return res.status(404).json({ error: "Kitap dosyası bulunamadı." });
        }

        yauzl.open(archivePath, {
            lazyEntries: true,
            autoClose: true,
            validateEntrySizes: true
        }, (openError, zipfile) => {
            releaseEarlyResponseCloseHandler();
            if (openError) {
                console.error("EPUB arşivi açılamadı:", openError.message);
                if (responseClosed || res.destroyed) return;
                const status = openError.code === 'ENOENT' ? 404 : 500;
                return res.status(status).json({
                    error: status === 404 ? "Kitap dosyası bulunamadı." : "EPUB arşivi okunamadı."
                });
            }
            if (responseClosed || res.destroyed || res.writableEnded) {
                zipfile.close();
                return;
            }
            let finished = false;
            let entryStream = null;
            let cleanedUp = false;
            let responseCloseHandler;

            const closeArchive = () => {
                if (zipfile.isOpen) zipfile.close();
            };

            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                finished = true;
                closeArchive();
                res.removeListener('close', responseCloseHandler);
                res.removeListener('finish', cleanup);
            };

            const fail = (status, message, error) => {
                if (finished) return;
                finished = true;
                if (entryStream && !entryStream.destroyed) entryStream.destroy(error);
                closeArchive();
                res.removeListener('close', responseCloseHandler);
                res.removeListener('finish', cleanup);

                if (!res.headersSent && !res.destroyed) {
                    res.status(status).json({ error: message });
                } else if (!res.destroyed) {
                    res.destroy(error);
                }
            };

            responseCloseHandler = () => {
                if (!res.writableFinished && !finished) {
                    finished = true;
                    if (entryStream && !entryStream.destroyed) entryStream.destroy();
                    closeArchive();
                }
                cleanup();
            };
            res.once('close', responseCloseHandler);
            res.once('finish', cleanup);

            zipfile.once('error', error => {
                fail(500, "EPUB arşivi okunamadı.", error);
            });

            zipfile.once('end', () => {
                if (finished) return;
                cleanup();
                if (!res.headersSent && !res.destroyed) {
                    res.status(404).json({ error: "EPUB dosyası bulunamadı." });
                }
            });

            zipfile.on('entry', entry => {
                if (finished) return;
                if (entry.fileName !== entryName) {
                    try {
                        zipfile.readEntry();
                    } catch (error) {
                        fail(500, "EPUB arşivi okunamadı.", error);
                    }
                    return;
                }

                res.status(200).set({
                    'Content-Type': getEpubEntryMimeType(entryName),
                    'Content-Length': String(entry.uncompressedSize),
                    'Cache-Control': 'private, no-cache',
                    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
                    'X-Content-Type-Options': 'nosniff'
                });

                if (req.method === 'HEAD') {
                    cleanup();
                    return res.end();
                }

                try {
                    zipfile.openReadStream(entry, (streamError, stream) => {
                        if (streamError) {
                            return fail(500, "EPUB dosyası okunamadı.", streamError);
                        }
                        entryStream = stream;
                        if (finished || res.destroyed || res.writableEnded) {
                            return stream.destroy();
                        }

                        stream.once('error', error => {
                            fail(500, "EPUB dosyası okunamadı.", error);
                        });
                        stream.once('end', cleanup);
                        stream.pipe(res);
                    });
                } catch (error) {
                    fail(500, "EPUB dosyası okunamadı.", error);
                }
            });

            try {
                zipfile.readEntry();
            } catch (error) {
                fail(500, "EPUB arşivi okunamadı.", error);
            }
        });
    });
}

// API: EPUB arşivinden tek bir kaynağı akış olarak getir
app.get('/api/books/:id/epub', requireAuth, serveEpubEntry);
app.get('/api/books/:id/epub/*', requireAuth, serveEpubEntry);
app.get('/api/books/:id/layout', requireAuth, async (req, res) => {
    try {
        const book = ownedBook(req);
        const archivePath = getBookArchivePath(book);
        if (!archivePath) throw Object.assign(new Error('Geçersiz kitap arşivi yolu.'), { statusCode: 400 });
        const state = await layoutQueue.ensure({ bookId: book.id, archivePath });
        res.set('Cache-Control', 'private, no-store');
        if (state.status === 'ready') {
            res.set({ 'Content-Type': 'application/zip', 'X-Reader-Source-Version': state.sourceVersion,
                'X-Content-Type-Options': 'nosniff' });
            return res.sendFile(state.bundlePath);
        }
        if (state.status === 'failed') {
            return res.status(422).json({ status: state.status, sourceVersion: state.sourceVersion, error: state.error });
        }
        return res.status(202).json({ status: state.status, sourceVersion: state.sourceVersion });
    } catch (error) { sendError(res, error); }
});
app.get('/api/books/:id/pdf', requireAuth, async (req, res) => {
    try {
        const { pdfPath, ...descriptor } = await describeBook(ownedBook(req));
        return res.json(descriptor);
    } catch (error) { sendError(res, error); }
});

app.post('/api/books/:id/pdf/ocr', requireAuth, async (req, res) => {
    try {
        const book = ownedBook(req);
        if (!['auto', 'on', 'off'].includes(req.body?.mode)) {
            throw Object.assign(new Error('OCR mode must be auto, on or off.'), { statusCode: 400 });
        }
        await describeBook(book);
        book.ocrMode = req.body.mode;
        saveDB();
        // Revoke before any asynchronous work; old inference cannot publish after a policy change.
        ocrRevisions.set(book.id, (ocrRevisions.get(book.id) || 0) + 1);
        ocrQueue?.cancelBook(book.id);
        pdfOcr.cancelBookOcr(book.id);
        const { pdfPath, ...descriptor } = await describeBook(book);
        return res.json(descriptor);
    } catch (error) { sendError(res, error); }
});

async function handleClearBookOcr(req, res) {
    try {
        const book = ownedBook(req);
        book.ocrMode = 'off';
        saveDB();
        ocrRevisions.set(book.id, (ocrRevisions.get(book.id) || 0) + 1);
        if (ocrQueue) ocrQueue.deleteBook(book.id);
        await pdfOcr.clearBookOcrCache(book.id);
        const { pdfPath, ...descriptor } = await describeBook(book);
        const queue = ocrQueue ? ocrQueue.status(book.id) : null;
        return res.json({ ok: true, ...descriptor, ocrMode: 'off', automaticOcr: false, queue });
    } catch (error) { sendError(res, error); }
}

app.delete('/api/books/:id/pdf/ocr', requireAuth, handleClearBookOcr);
app.post('/api/books/:id/pdf/ocr/clear', requireAuth, handleClearBookOcr);

app.get('/api/books/:id/pdf/pages/:page', requireAuth, async (req, res) => {
    try {
        const book = ownedBook(req);
        if (!/^[1-9]\d*$/.test(req.params.page) || !Number.isSafeInteger(Number(req.params.page))) {
            throw Object.assign(new Error('Geçersiz sayfa numarası.'), { statusCode: 400 });
        }
        if (req.query.ocr !== undefined && !['0', '1'].includes(req.query.ocr) ||
            req.query.ocrJob !== undefined && (typeof req.query.ocrJob !== 'string' || req.query.ocr !== undefined)) {
            throw Object.assign(new Error('Use ocr=0, ocr=1, or an OCR job identifier.'), { statusCode: 400 });
        }
        const page = Number(req.params.page);
        const forceOcr = req.query.ocr === '1';
        if (req.query.ocr === '0' || !forceOcr && req.query.ocrJob === undefined && book.ocrMode === 'off') {
            return res.json(await pdfOcr.getPdfPage({ bookId: book.id, pdfPath: pdfPathFor(book), page, nativeOnly: true }));
        }
        const descriptor = await describeBook(book);
        const { pdfPath, sourceVersion, totalPages } = descriptor;
        if (page > totalPages) throw Object.assign(new Error('Geçersiz sayfa numarası.'), { statusCode: 400 });
        const revision = ocrRevisions.get(book.id) || 0;
        const isCurrent = () => library.includes(book) && (ocrRevisions.get(book.id) || 0) === revision;
        if (!forceOcr && req.query.ocrJob === undefined && !descriptor.automaticOcr) {
            return res.json(await pdfOcr.getPdfPage({ bookId: book.id, pdfPath, page, nativeOnly: true, expectedSourceVersion: sourceVersion }));
        }
        if (MODE === 'local') {
            if (req.query.ocrJob !== undefined) throw Object.assign(new Error('Persistent OCR jobs are only available on the VPS server.'), { statusCode: 404 });
            return res.json(await pdfOcr.getPdfPage({ bookId: book.id, pdfPath, page, nativeOnly: false,
                forceOcr: true, regenerate: forceOcr, expectedSourceVersion: sourceVersion, isCurrent }));
        }
        ocrQueue.updateBook({ bookId: book.id, sourceVersion, totalPages, mode: book.computeMode || 'vps' });
        let state = ocrQueue.status(book.id);
        let job = state.jobs.find(candidate => candidate.page === page);
        if (req.query.ocrJob !== undefined && job?.id !== req.query.ocrJob) {
            throw Object.assign(new Error('The OCR job was canceled, replaced, or its source changed.'), { statusCode: 410 });
        }
        if (forceOcr && job && ['pending', 'processing'].includes(job.status)) {
            job = ocrQueue.ensurePage({ bookId: book.id, page, mode: job.mode, sourceVersion, totalPages, forceOcr: true });
        }
        if (job?.status === 'pending' || job?.status === 'processing') {
            wakeCpu();
            return res.status(202).json({ status: job.status, jobId: job.id, mode: job.mode });
        }
        if (job?.status !== 'failed') {
            const cached = await pdfOcr.getCachedPage({ bookId: book.id, pdfPath, page, expectedSourceVersion: sourceVersion });
            if (!isCurrent()) throw Object.assign(new Error('The book OCR policy changed; retry the page request.'), { statusCode: 409 });
            if (cached && !forceOcr) return res.json(cached);
        }
        if (req.query.ocrJob !== undefined && job?.status === 'completed') {
            throw Object.assign(new Error('The completed OCR page is no longer cached; scan it again.'), { statusCode: 410 });
        }
        if (job?.status === 'completed' || job?.status === 'failed' && forceOcr) {
            state = ocrQueue.enqueueBook({ bookId: book.id, sourceVersion, totalPages, fromPage: page, toPage: page,
                mode: job.mode, forceOcr });
            job = state.jobs.find(candidate => candidate.page === page);
        }
        if (!job) {
            job = ocrQueue.ensurePage({ bookId: book.id, page, mode: book.computeMode || 'vps',
                sourceVersion, totalPages, forceOcr });
        }
        wakeCpu();
        return res.status(202).json({ status: job.status, jobId: job.id, mode: job.mode, ...(job.error ? { error: job.error } : {}) });
    } catch (error) {
        sendError(res, error);
    }
});

app.get('/api/runtime-config', (req, res) => res.json({
    mode: MODE, pipelineVersion: pdfOcr.pipelineVersion,
    authEnabled: process.env.DISABLE_AUTH !== 'true' && (MODE === 'vps' || Boolean(resolveProjectId()))
}));

app.get('/api/books/:id/compute', requireAuth, async (req, res) => {
    try {
        if (!ocrQueue) return res.status(404).json({ error: 'Persistent OCR jobs are only available on the VPS server.' });
        const book = ownedBook(req);
        const descriptor = await describeBook(book);
        ocrQueue.updateBook({ bookId: book.id, ...descriptor, mode: book.computeMode || 'vps' });
        return res.json(ocrQueue.status(book.id));
    } catch (error) { sendError(res, error); }
});

app.post('/api/books/:id/compute', requireAuth, async (req, res) => {
    try {
        if (!ocrQueue) return res.status(404).json({ error: 'Persistent OCR jobs are only available on the VPS server.' });
        const book = ownedBook(req);
        const body = req.body || {};
        if (!['vps', 'compute'].includes(body.mode)) throw Object.assign(new Error('OCR mode must be vps or compute.'), { statusCode: 400 });
        if (body.mode === 'compute' && WORKER_SECRET.length < 32) {
            throw Object.assign(new Error('Set a random WORKER_SECRET of at least 32 characters in vps/.env, then restart the VPS server to enable computer mode.'), { statusCode: 503 });
        }
        const descriptor = await describeBook(book);
        const fromPage = body.fromPage ?? 1;
        const toPage = body.toPage ?? descriptor.totalPages;
        if (!Number.isSafeInteger(fromPage) || !Number.isSafeInteger(toPage) || fromPage < 1 || toPage < fromPage || toPage > descriptor.totalPages) {
            throw Object.assign(new Error('Geçersiz kapsayıcı sayfa aralığı.'), { statusCode: 400 });
        }
        book.computeMode = body.mode;
        book.ocrMode = 'on';
        saveDB();
        ocrRevisions.set(book.id, (ocrRevisions.get(book.id) || 0) + 1);
        ocrQueue.cancelBook(book.id, { automaticOnly: true });
        const state = ocrQueue.enqueueBook({ bookId: book.id, ...descriptor, mode: body.mode, fromPage, toPage, forceOcr: true });
        wakeCpu();
        const { pdfPath, ...publicDescriptor } = descriptor;
        return res.json({ ...state, ...publicDescriptor, ocrMode: 'on', automaticOcr: true });
    } catch (error) { sendError(res, error); }
});

app.get('/api/compute/jobs', async (req, res) => {
    try {
        let job;
        while ((job = ocrQueue.claim('compute'))) {
            try { await freshJob(job); } catch (error) {
                if (ocrQueue.isActive(job.id, job.leaseToken, 'compute')) ocrQueue.fail(job.id, job.leaseToken, 'compute', error.message);
                continue;
            }
            return res.json({ id: job.id, bookId: job.bookId, page: job.page, pipelineVersion: job.pipelineVersion,
                leaseToken: job.leaseToken, sourceVersion: job.sourceVersion,
                inputUrl: `/api/compute/jobs/${job.id}/input`, leaseSeconds: job.leaseSeconds });
        }
        return res.status(204).end();
    } catch (error) { sendError(res, error); }
});

app.get('/api/compute/jobs/:id/input', async (req, res) => {
    try {
        const token = req.get('X-Compute-Lease');
        const job = ocrQueue.getLease(req.params.id, token, 'compute');
        const { pdfPath } = await freshJob(job);
        ocrQueue.getLease(req.params.id, token, 'compute');
        res.set('Cache-Control', 'private, no-store');
        return res.sendFile(pdfPath);
    } catch (error) { sendError(res, error); }
});

app.post('/api/compute/jobs/:id/renew', async (req, res) => {
    try {
        const job = ocrQueue.getLease(req.params.id, req.body?.leaseToken, 'compute');
        await freshJob(job);
        return res.json(ocrQueue.renew(job.id, req.body.leaseToken));
    } catch (error) { sendError(res, error); }
});

app.post('/api/compute/jobs/:id/complete', async (req, res) => {
    try {
        const token = req.body?.leaseToken;
        const job = ocrQueue.getLease(req.params.id, token, 'compute', true);
        const { pdfPath } = await freshJob(job);
        const response = await ocrQueue.complete(job.id, token, 'compute', (leased, isCurrent) =>
            pdfOcr.saveComputedPage({ bookId: leased.bookId, pdfPath, page: leased.page,
                image: req.body.image, result: req.body.result, expectedSourceVersion: leased.sourceVersion, isCurrent }));
        return res.json(response);
    } catch (error) { sendError(res, error); }
});

app.post('/api/compute/jobs/:id/fail', async (req, res) => {
    try {
        const body = req.body || {};
        if (typeof body.error !== 'string' || body.requeue !== undefined && typeof body.requeue !== 'boolean') {
            throw Object.assign(new Error('A worker error string and optional boolean requeue are required.'), { statusCode: 400 });
        }
        const job = ocrQueue.getLease(req.params.id, body.leaseToken, 'compute');
        await freshJob(job);
        return res.json(ocrQueue.fail(job.id, body.leaseToken, 'compute', body.error, body.requeue === true));
    } catch (error) { sendError(res, error); }
});

// API: Firebase istemci yapılandırmasını sağla (kaynak kod düzenleme ihtiyacını ortadan kaldırır)
app.get('/api/firebase-config', (req, res) => {
    if (process.env.DISABLE_AUTH === 'true') return res.json({ configured: false });
    if (process.env.FIREBASE_PROJECT_ID) {
        const projectId = process.env.FIREBASE_PROJECT_ID.trim();
        return res.json({
            configured: true,
            apiKey: process.env.FIREBASE_API_KEY || "",
            authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
            projectId: projectId,
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
            appId: process.env.FIREBASE_APP_ID || ""
        });
    }

    const configPath = path.join(__dirname, 'firebase-config.js');
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const extract = (key) => {
                const match = content.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
                return match ? match[1].trim() : "";
            };
            const projectId = extract('projectId');
            if (projectId) {
                return res.json({
                    configured: true,
                    apiKey: extract('apiKey'),
                    authDomain: extract('authDomain') || `${projectId}.firebaseapp.com`,
                    projectId: projectId,
                    storageBucket: extract('storageBucket') || `${projectId}.firebasestorage.app`,
                    messagingSenderId: extract('messagingSenderId'),
                    appId: extract('appId')
                });
            }
        } catch (_) {}
    }

    return res.json({ configured: false });
});

// API: Kullanıcı bilgilerini doğrula
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// API: Kullanıcının kitaplarını getir
app.get('/api/books', requireAuth, (req, res) => {
    const userUid = req.user.uid;
    const userBooks = library.filter(book => !book.userId || book.userId === userUid);
    res.json(userBooks);
});

// API: Yeni kitap yükle
app.post('/api/books', requireAuth, upload.fields([{ name: 'bookFile', maxCount: 1 }, { name: 'coverBlob', maxCount: 1 }]), (req, res) => {
    try {
        const title = req.body.title || 'Bilinmeyen Kitap';
        const fileName = req.body.fileName || 'book.epub';
        const toc = req.body.toc ? JSON.parse(req.body.toc) : [];
        const id = 'book_' + Date.now();

        const bookFile = req.files['bookFile'] ? req.files['bookFile'][0] : null;
        const coverFile = req.files['coverBlob'] ? req.files['coverBlob'][0] : null;

        if (!bookFile) {
            return res.status(400).json({ error: "Kitap dosyası eksik." });
        }

        // Dosyaları diske yaz
        const safeFileName = id + '_' + fileName.replace(/[^a-zA-Z0-9.\-]/g, "_");
        const bookPath = path.join(UPLOADS_DIR, safeFileName);
        fs.writeFileSync(bookPath, bookFile.buffer);

        let coverUrl = null;
        if (coverFile) {
            const coverFileName = id + '_cover.jpg';
            const coverPath = path.join(COVERS_DIR, coverFileName);
            fs.writeFileSync(coverPath, coverFile.buffer);
            coverUrl = `/uploads/covers/${coverFileName}`;
        }

        const newBook = {
            id,
            userId: req.user.uid,
            title,
            fileName: safeFileName,
            bookUrl: `/uploads/${safeFileName}`,
            coverUrl,
            toc,
            progress: 0,
            scrollY: 0,
            chapterIndex: 0,
            pageIndex: 1,
            addedAt: Date.now()
        };

        library.push(newBook);
        saveDB();
        scheduleLayout(newBook);

        res.json({ success: true, book: newBook });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Yükleme sırasında hata oluştu." });
    }
});

// API: Okuma ilerlemesini güncelle
app.put('/api/books/:id/progress', requireAuth, (req, res) => {
    const { id } = req.params;
    const userUid = req.user.uid;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const book = library.find(b => b.id === id && (!b.userId || b.userId === userUid));

    if (!book) {
        return res.status(404).json({ error: "Kitap bulunamadı." });
    }

    if (Object.prototype.hasOwnProperty.call(body, 'readerPosition') &&
        body.readerPosition !== null &&
        (typeof body.readerPosition !== 'object' || Array.isArray(body.readerPosition))) {
        return res.status(400).json({ error: "Geçersiz okuma konumu." });
    }

    ['progress', 'scrollY', 'chapterIndex', 'pageIndex', 'pagedIndex'].forEach(field => {
        if (body[field] !== undefined) book[field] = body[field];
    });

    if (body.readerPosition !== undefined) {
        if (body.readerPosition === null) {
            book.readerPosition = null;
        } else {
            const previousPosition = book.readerPosition && typeof book.readerPosition === 'object' &&
                !Array.isArray(book.readerPosition) ? book.readerPosition : {};
            book.readerPosition = { ...previousPosition, ...body.readerPosition };
        }
    }

    saveDB();
    res.json({ success: true });
});

// API: Kitap sil
app.delete('/api/books/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const userUid = req.user.uid;
    const bookIndex = library.findIndex(b => b.id === id && (!b.userId || b.userId === userUid));

    if (bookIndex === -1) {
        return res.status(404).json({ error: 'Kitap bulunamadı.' });
    }

    const book = library[bookIndex];
    library.splice(bookIndex, 1);
    try {
        saveDB();
        const layoutDeletion = layoutQueue.deleteBook(id);
        if (ocrQueue) ocrQueue.deleteBook(id);
        metadataCache.delete(id);
        ocrRevisions.delete(id);
        await layoutDeletion;
        // Stop new requests before waiting for queued work, then remove this book's cached pages.
        await pdfOcr.deleteBookCache(id, { waitForJobs: MODE === 'local' });
    } catch (error) {
        console.error('Book deletion error:', error);
        return res.status(500).json({ error: 'Kitap silinirken hata oluştu.' });
    }

    try {
        const archive = getBookArchivePath(book);
        if (archive) fs.unlinkSync(archive);
        if (book.coverUrl && /^\/uploads\/covers\/[A-Za-z0-9_-]+_cover\.jpg$/.test(book.coverUrl)) {
            fs.unlinkSync(path.join(COVERS_DIR, path.basename(book.coverUrl)));
        }
    } catch (error) {
        console.warn('Dosya silinemedi:', error.message);
    }

    return res.json({ success: true });
});
// API kitap yolları hiçbir zaman istemci uygulaması geri dönüşüne düşmez
app.get('/api/books/:id/*', (req, res) => {
    res.status(404).json({ error: "API yolu bulunamadı." });
});

// Unknown paths never fall through to the frontend and reveal private source files.
app.use((req, res) => res.status(404).json({ error: 'Yol bulunamadı.' }));

// Sunucuyu Başlat
const os = require('os');
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const server = app.listen(PORT, process.env.HOST || (MODE === 'vps' ? '127.0.0.1' : '0.0.0.0'), () => {
    const localIp = getLocalIP();
    console.log(`\n=================================================`);
    console.log(`📚 Premium Edge Reader Sunucusu Çalışıyor!`);
    console.log(`=================================================`);
    console.log(`👉 Bilgisayarınızdan erişmek için: http://localhost:${PORT}`);
    console.log(`👉 Telefonunuzdan erişmek için   : http://${localIp}:${PORT}`);
    console.log(`=================================================\n`);
});
const leaseRecovery = ocrQueue ? setInterval(() => ocrQueue.recoverExpired(), 15000) : null;
leaseRecovery?.unref();
wakeCpu();

let shuttingDown = false;
async function shutdownServer() {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    if (cpuJob && ocrQueue.isActive(cpuJob.id, cpuJob.leaseToken, 'vps')) {
        ocrQueue.fail(cpuJob.id, cpuJob.leaseToken, 'vps', 'VPS server is stopping.', true);
    }
    clearInterval(leaseRecovery);
    server.close();
    await Promise.all([
        layoutQueue.shutdown().catch(error => console.error('Layout queue shutdown error:', error)),
        pdfOcr.shutdown().catch(error => console.error('PDF OCR shutdown error:', error))
    ]);
}

process.once('SIGINT', () => { shutdownServer().catch(error => console.error(error)); });
process.once('SIGTERM', () => { shutdownServer().catch(error => console.error(error)); });
