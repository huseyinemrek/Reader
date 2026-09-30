'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');
const { ocrBlocks, nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');
const { processRegions } = require('./pdf-regions');
const createMathOcr = require('./math-ocr');

const requireFromHere = createRequire(__filename);
const MAX_RENDER_DIMENSION = 3200;
const BASE_RENDER_SCALE = 2.5;
const MIN_NATIVE_ALPHANUMERIC_CHARS = 200;
const CACHE_VERSION = 9;
const PDFJS_PACKAGE_DIR = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_PACKAGE_DIR, 'standard_fonts').replace(/\\/g, '/')}/`;
const CMAP_URL = `${path.join(PDFJS_PACKAGE_DIR, 'cmaps').replace(/\\/g, '/')}/`;
const englishData = requireFromHere('@tesseract.js-data/eng');
const turkishData = requireFromHere('@tesseract.js-data/tur');

class PdfOcrError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.name = 'PdfOcrError';
        this.statusCode = statusCode;
    }
}

function makeError(statusCode, message) {
    return new PdfOcrError(statusCode, message);
}

function isMeaningfulNativeText(text) {
    return !text.includes('\uFFFD') && (text.match(/[\p{L}\p{N}]/gu) || []).length >= MIN_NATIVE_ALPHANUMERIC_CHARS;
}

function createPdfOcr(uploadsDirectory) {
    const uploadsRoot = path.resolve(uploadsDirectory);
    const pdfCacheRoot = path.join(uploadsRoot, 'pdf');
    let jobQueue = Promise.resolve();
    const mathOcr = createMathOcr();
    let pdfjsPromise = null;
    let tesseractPromise = null;

    let trainedDataDirectory = null;
    let shuttingDown = false;
    const inFlightPages = new Map();

    function enqueue(job) {
        const result = jobQueue.then(job, job);
        jobQueue = result.catch(() => {});
        return result;
    }

    function resolvePdfPath(pdfPath, bookId) {
        if (typeof bookId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(bookId)) {
            throw makeError(400, 'Invalid book identifier.');
        }
        if (typeof pdfPath !== 'string' || !pdfPath.toLowerCase().endsWith('.pdf')) {
            throw makeError(415, 'This book is not a PDF.');
        }

        const resolvedPath = path.resolve(pdfPath);
        if (path.dirname(resolvedPath) !== uploadsRoot || path.basename(resolvedPath) !== path.basename(pdfPath)) {
            throw makeError(400, 'The PDF file path is outside the uploads directory.');
        }
        return resolvedPath;
    }

    async function getPdfStat(pdfPath) {
        let fileStat;
        try {
            fileStat = await fs.promises.lstat(pdfPath);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                throw makeError(404, 'The PDF file was not found.');
            }
            throw error;
        }
        if (!fileStat.isFile()) {
            throw makeError(400, 'The PDF path is not a regular file.');
        }

        return fileStat;
    }

    async function loadPdfJs() {
        if (!pdfjsPromise) {
            const canvasModule = requireFromHere('@napi-rs/canvas');
            for (const globalName of ['DOMMatrix', 'Path2D', 'ImageData']) {
                if (!globalThis[globalName] && canvasModule[globalName]) {
                    globalThis[globalName] = canvasModule[globalName];
                }
            }
            pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
        }
        return pdfjsPromise;
    }

    async function createTesseractWorker() {
        const { createWorker, OEM } = requireFromHere('tesseract.js');
        trainedDataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reader-pdf-ocr-'));
        try {
            await Promise.all([
                fs.promises.copyFile(
                    path.join(englishData.langPath, 'eng.traineddata.gz'),
                    path.join(trainedDataDirectory, 'eng.traineddata.gz')
                ),
                fs.promises.copyFile(
                    path.join(turkishData.langPath, 'tur.traineddata.gz'),
                    path.join(trainedDataDirectory, 'tur.traineddata.gz')
                )
            ]);
            return await createWorker('eng+tur', OEM.LSTM_ONLY, {
                langPath: trainedDataDirectory,
                gzip: true,
                cacheMethod: 'none',
                logger: () => {}
            });
        } catch (error) {
            await fs.promises.rm(trainedDataDirectory, { recursive: true, force: true }).catch(() => {});
            trainedDataDirectory = null;
            throw error;
        }
    }

    async function getTesseractWorker() {
        if (!tesseractPromise) {
            const pendingWorker = createTesseractWorker();
            tesseractPromise = pendingWorker;
            pendingWorker.catch(() => {
                if (tesseractPromise === pendingWorker) tesseractPromise = null;
            });
        }
        return tesseractPromise;
    }

    async function recognizePage(imageBuffer) {
        let worker;
        try {
            worker = await getTesseractWorker();
            const result = await worker.recognize(imageBuffer, {}, { text: true, blocks: true });
            const blocks = ocrBlocks(result.data);
            const text = blocksText(blocks);
            const confidence = Number.isFinite(result.data.confidence) ? result.data.confidence : null;
            return { text, blocks, confidence };
        } catch (error) {
            throw makeError(500, `OCR failed: ${error.message || String(error)}`);
        }
    }

    function pageImageUrl(bookId, pageNumber) {
        return `/uploads/pdf/${bookId}/page-${pageNumber}.jpg`;
    }

    async function readCachedPage(cacheDirectory, bookId, pageNumber, fileStat, forceOcr) {
        const jsonPath = path.join(cacheDirectory, `page-${pageNumber}.json`);
        const imagePath = path.join(cacheDirectory, `page-${pageNumber}.jpg`);
        let cached;
        try {
            cached = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
            const imageStat = await fs.promises.stat(imagePath);
            if (!imageStat.isFile() || imageStat.size === 0 || cached.page !== pageNumber ||
                cached.version !== CACHE_VERSION ||
                cached.pdfSize !== fileStat.size || cached.pdfMtimeMs !== fileStat.mtimeMs ||
                typeof cached.text !== 'string' || !validBlocks(cached.blocks, cached.text) || !['native', 'ocr'].includes(cached.source) ||
                (cached.confidence !== null && !Number.isFinite(cached.confidence)) ||
                !Number.isInteger(cached.width) || cached.width < 1 ||
                !Number.isInteger(cached.height) || cached.height < 1 ||
                cached.imageUrl !== pageImageUrl(bookId, pageNumber) ||
                (forceOcr && cached.source !== 'ocr')) {
                return null;
            }
            for (const block of cached.blocks) {
                if (block.bbox.x1 > cached.width || block.bbox.y1 > cached.height) return null;
                if (block.type !== 'image') continue;
                const expectedPrefix = `/uploads/pdf/${bookId}/page-${pageNumber}-region-`;
                if (!block.imageUrl.startsWith(expectedPrefix) ||
                    block.width !== block.bbox.x1 - block.bbox.x0 ||
                    block.height !== block.bbox.y1 - block.bbox.y0) return null;
                const cropPath = path.join(cacheDirectory, path.basename(block.imageUrl));
                const cropStat = await fs.promises.lstat(cropPath);
                if (!cropStat.isFile() || cropStat.size === 0) return null;
                const crop = await requireFromHere('@napi-rs/canvas').loadImage(await fs.promises.readFile(cropPath));
                if (crop.width !== block.width || crop.height !== block.height) return null;
            }
            return {
                page: pageNumber,
                text: cached.text,
                blocks: cached.blocks,
                source: cached.source,
                confidence: cached.confidence,
                imageUrl: cached.imageUrl,
                width: cached.width,
                height: cached.height,
                imagePath
            };
        } catch (_) {
            return null;
        }
    }

    async function writeCache(cacheDirectory, pageResult, fileStat) {
        const imagePath = path.join(cacheDirectory, `page-${pageResult.page}.jpg`);
        const jsonPath = path.join(cacheDirectory, `page-${pageResult.page}.json`);
        const suffix = `${process.pid}-${Date.now()}`;
        const temporaryImagePath = `${imagePath}.${suffix}.tmp`;
        const temporaryJsonPath = `${jsonPath}.${suffix}.tmp`;
        const cacheRecord = {
            version: CACHE_VERSION,
            page: pageResult.page,
            text: pageResult.text,
            blocks: pageResult.blocks,
            source: pageResult.source,
            confidence: pageResult.confidence,
            imageUrl: pageResult.imageUrl,
            width: pageResult.width,
            height: pageResult.height,
            pdfSize: fileStat.size,
            pdfMtimeMs: fileStat.mtimeMs
        };
        try {
            await fs.promises.writeFile(temporaryImagePath, pageResult.imageBuffer);
            await fs.promises.rename(temporaryImagePath, imagePath);
            await fs.promises.writeFile(temporaryJsonPath, JSON.stringify(cacheRecord), 'utf8');
            await fs.promises.rename(temporaryJsonPath, jsonPath);
        } finally {
            await Promise.all([
                fs.promises.rm(temporaryImagePath, { force: true }),
                fs.promises.rm(temporaryJsonPath, { force: true })
            ]);
        }
        const { imageBuffer, ...response } = pageResult;
        return response;
    }

    async function renderPdfPage(pdfPath, pageNumber) {
        const pdfjs = await loadPdfJs();
        const documentData = await fs.promises.readFile(pdfPath);
        let loadingTask;
        let pdfDocument;
        let canvas;
        try {
            loadingTask = pdfjs.getDocument({
                data: new Uint8Array(documentData),
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                useSystemFonts: true
            });
            pdfDocument = await loadingTask.promise;
            if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdfDocument.numPages) {
                throw makeError(400, `Invalid page number. The PDF has ${pdfDocument.numPages} pages.`);
            }

            const page = await pdfDocument.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const unitViewport = page.getViewport({ scale: 1 });
            const scale = Math.min(BASE_RENDER_SCALE, MAX_RENDER_DIMENSION / Math.max(unitViewport.width, unitViewport.height));
            const viewport = page.getViewport({ scale });
            const width = Math.max(1, Math.ceil(viewport.width));
            const height = Math.max(1, Math.ceil(viewport.height));
            const canvasModule = requireFromHere('@napi-rs/canvas');
            canvas = canvasModule.createCanvas(width, height);
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            await page.render({ canvasContext: context, viewport }).promise;
            // Original PDF font identities distinguish single mathematical glyphs
            // from ordinary prose without sending native paragraphs through OCR.
            for (const [fontName, style] of Object.entries(textContent.styles || {})) {
                if (page.commonObjs.has(fontName)) {
                    const font = page.commonObjs.get(fontName);
                    style.sourceFontName = font.name || fontName;
                }
            }
            const blocks = nativeBlocks(textContent, viewport);
            const nativeText = blocksText(blocks);
            const imageBuffer = canvas.toBuffer('image/jpeg', 88);
            return {
                nativeText,
                nativeBlocks: blocks,
                imageBuffer,
                width,
                height
            };
        } catch (error) {
            if (error instanceof PdfOcrError) throw error;
            throw makeError(422, `Unable to read or render the PDF page: ${error.message || String(error)}`);
        } finally {
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
            if (pdfDocument) {
                await pdfDocument.cleanup().catch(() => {});
            }
            if (loadingTask) {
                await loadingTask.destroy().catch(() => {});
            }
        }
    }

    async function processPage({ bookId, pdfPath, pageNumber, forceOcr }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        const cacheDirectory = path.join(pdfCacheRoot, bookId);
        await fs.promises.mkdir(cacheDirectory, { recursive: true });

        const cachedPage = await readCachedPage(cacheDirectory, bookId, pageNumber, fileStat, forceOcr);
        if (cachedPage) {
            return {
                page: cachedPage.page,
                text: cachedPage.text,
                blocks: cachedPage.blocks,
                source: cachedPage.source,
                confidence: cachedPage.confidence,
                imageUrl: cachedPage.imageUrl,
                width: cachedPage.width,
                height: cachedPage.height
            };
        }

        const oldNativePage = forceOcr
            ? await readCachedPage(cacheDirectory, bookId, pageNumber, fileStat, false)
            : null;
        let nativeText;
        let blocks;
        let imageBuffer;
        let width;
        let height;

        if (oldNativePage) {
            imageBuffer = await fs.promises.readFile(oldNativePage.imagePath);
            width = oldNativePage.width;
            height = oldNativePage.height;
        } else {
            let rendered;
            try {
                rendered = await renderPdfPage(resolvedPdfPath, pageNumber);
            } catch (error) {
                if (error instanceof PdfOcrError) throw error;
                throw makeError(422, `Unable to read the PDF: ${error.message || String(error)}`);
            }
            nativeText = rendered.nativeText;
            blocks = rendered.nativeBlocks;
            imageBuffer = rendered.imageBuffer;
            width = rendered.width;
            height = rendered.height;
        }

        let source = 'native';
        let text = nativeText || '';
        let confidence = null;
        if (forceOcr || !oldNativePage && !isMeaningfulNativeText(text)) {
            const recognized = await recognizePage(imageBuffer);
            source = 'ocr';
            text = recognized.text;
            blocks = recognized.blocks;
            confidence = recognized.confidence;
        }

        try {
            blocks = await processRegions({ blocks, imageBuffer, width, height, bookId, pageNumber,
                cacheDirectory, recognizeMath: mathOcr.recognizeMath });
            text = blocksText(blocks);
            if (!validBlocks(blocks, text)) throw new Error('The recognized PDF layout is invalid.');
        } catch (error) {
            throw makeError(500, `PDF figure/formula processing failed: ${error.message || String(error)}`);
        }

        const response = {
            page: pageNumber,
            text,
            blocks,
            source,
            confidence,
            imageUrl: pageImageUrl(bookId, pageNumber),
            width,
            height,
            imageBuffer
        };
        return writeCache(cacheDirectory, response, fileStat);
    }

    function getPdfPage({ bookId, pdfPath, page, forceOcr = false }) {
        if (shuttingDown) return Promise.reject(makeError(503, 'PDF processing is shutting down.'));
        if (!Number.isSafeInteger(page) || page < 1) {
            return Promise.reject(makeError(400, 'Invalid page number.'));
        }

        const key = `${bookId}:${page}`;
        let entry = inFlightPages.get(key);
        if (entry) {
            if (!forceOcr) return entry.promise;
            if (entry.forcePromise) return entry.forcePromise;
            if (entry.forceOcr) return entry.promise;

            entry.forceOcr = true;
            entry.forcePromise = entry.promise.then(result => {
                if (result.source === 'ocr') return result;
                return enqueue(() => processPage({
                    bookId,
                    pdfPath,
                    pageNumber: page,
                    forceOcr: true
                }));
            });
            const clearInFlight = () => {
                if (inFlightPages.get(key) === entry) inFlightPages.delete(key);
            };
            entry.forcePromise.then(clearInFlight, clearInFlight);
            return entry.forcePromise;
        }

        entry = { forceOcr: Boolean(forceOcr), promise: null, forcePromise: null };
        entry.promise = enqueue(() => processPage({
            bookId,
            pdfPath,
            pageNumber: page,
            forceOcr: entry.forceOcr
        }));
        inFlightPages.set(key, entry);
        const clearInFlight = () => {
            if (!entry.forcePromise && inFlightPages.get(key) === entry) inFlightPages.delete(key);
        };
        entry.promise.then(clearInFlight, clearInFlight);
        return entry.promise;
    }

    function deleteBookCache(bookId) {
        if (typeof bookId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(bookId)) {
            return Promise.reject(makeError(400, 'Invalid book identifier.'));
        }
        const cacheDirectory = path.join(pdfCacheRoot, bookId);
        const pagePrefix = `${bookId}:`;
        const pendingPages = [];
        for (const [key, entry] of inFlightPages) {
            if (key.startsWith(pagePrefix)) {
                pendingPages.push(entry.forcePromise || entry.promise);
            }
        }
        return Promise.allSettled(pendingPages)
            .then(() => enqueue(() => fs.promises.rm(cacheDirectory, { recursive: true, force: true })));
    }

    async function shutdown() {
        shuttingDown = true;
        const pendingPages = Array.from(inFlightPages.values(), entry => entry.forcePromise || entry.promise);
        await Promise.allSettled(pendingPages);
        await jobQueue;
        if (tesseractPromise) {
            try {
                const worker = await tesseractPromise;
                await worker.terminate();
            } catch (_) {
                // Worker initialization errors are already surfaced to the request that triggered them.
            }

            tesseractPromise = null;
        }
        if (trainedDataDirectory) {
            await fs.promises.rm(trainedDataDirectory, { recursive: true, force: true });
            trainedDataDirectory = null;
        }
        await mathOcr.shutdown();
    }

    return { getPdfPage, deleteBookCache, shutdown };
}

module.exports = createPdfOcr;
