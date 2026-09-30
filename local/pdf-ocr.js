'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');
const { processRegions } = require('./pdf-regions');
const createDocumentOcr = require('./document-ocr');
const { documentBlocks } = require('./document-blocks');
const { createSourceWindowRenderer } = require('./pdf-windows');

const requireFromHere = createRequire(__filename);
const MAX_RENDER_DIMENSION = 3200;
const BASE_RENDER_SCALE = 2.5;
const MIN_NATIVE_ALPHANUMERIC_CHARS = 200;
const CACHE_VERSION = 14;
const PDFJS_PACKAGE_DIR = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_PACKAGE_DIR, 'standard_fonts').replace(/\\/g, '/')}/`;
const CMAP_URL = `${path.join(PDFJS_PACKAGE_DIR, 'cmaps').replace(/\\/g, '/')}/`;

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
    const documentOcr = createDocumentOcr();
    let pdfjsPromise = null;

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


    function pageCacheStem(pageNumber) {
        return `page-${pageNumber}-v${CACHE_VERSION}`;
    }

    function pageAssetPrefix(bookId, pageNumber) {
        return `/uploads/pdf/${bookId}/${pageCacheStem(pageNumber)}`;
    }

    function pageImageUrl(bookId, pageNumber) {
        return pageAssetPrefix(bookId, pageNumber) + '.png';
    }

    async function readCachedPage(cacheDirectory, bookId, pageNumber, fileStat) {
        const jsonPath = path.join(cacheDirectory, pageCacheStem(pageNumber) + '.json');
        const imagePath = path.join(cacheDirectory, pageCacheStem(pageNumber) + '.png');
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
                typeof cached.engine !== 'string' || typeof cached.device !== 'string' ||
                typeof cached.modelRevision !== 'string' ||
                !Array.isArray(cached.qualityLimits) || !cached.qualityLimits.every(limit => typeof limit === 'string')) {
                return null;
            }
            for (const block of cached.blocks) {
                if (block.bbox.x1 > cached.width || block.bbox.y1 > cached.height) return null;
                if (block.type !== 'image') continue;
                const expectedPrefix = pageAssetPrefix(bookId, pageNumber) + '-region-';
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
                engine: cached.engine,
                device: cached.device,
                modelRevision: cached.modelRevision,
                elapsedMs: cached.elapsedMs,
                qualityLimits: cached.qualityLimits,
                metrics: cached.metrics,
                pipelineVersion: CACHE_VERSION,
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
        const imagePath = path.join(cacheDirectory, pageCacheStem(pageResult.page) + '.png');
        const jsonPath = path.join(cacheDirectory, pageCacheStem(pageResult.page) + '.json');
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
            engine: pageResult.engine,
            device: pageResult.device,
            modelRevision: pageResult.modelRevision,
            elapsedMs: pageResult.elapsedMs,
            qualityLimits: pageResult.qualityLimits,
            metrics: pageResult.metrics,
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
        let retained = false;
        async function release() {
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
            if (loadingTask) await loadingTask.destroy();
        }
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
            // OCR must see source edges, not JPEG ringing around small math glyphs.
            const imageBuffer = canvas.toBuffer('image/png');
            const renderRegion = createSourceWindowRenderer(page, viewport, canvas);
            retained = true;
            return {
                nativeText,
                nativeBlocks: blocks,
                imageBuffer,
                width,
                height,
                renderRegion,
                release
            };
        } catch (error) {
            if (error instanceof PdfOcrError) throw error;
            throw makeError(422, `Unable to read or render the PDF page: ${error.message || String(error)}`);
        } finally {
            if (!retained) await release().catch(() => {});
        }
    }

    async function processPage({ bookId, pdfPath, pageNumber, forceOcr }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        const cacheDirectory = path.join(pdfCacheRoot, bookId);
        await fs.promises.mkdir(cacheDirectory, { recursive: true });

        const cachedPage = forceOcr ? null : await readCachedPage(cacheDirectory, bookId, pageNumber, fileStat);
        if (cachedPage) {
            return {
                page: cachedPage.page,
                text: cachedPage.text,
                blocks: cachedPage.blocks,
                source: cachedPage.source,
                confidence: cachedPage.confidence,
                engine: cachedPage.engine,
                device: cachedPage.device,
                modelRevision: cachedPage.modelRevision,
                elapsedMs: cachedPage.elapsedMs,
                qualityLimits: cachedPage.qualityLimits,
                metrics: cachedPage.metrics,
                pipelineVersion: CACHE_VERSION,
                imageUrl: cachedPage.imageUrl,
                width: cachedPage.width,
                height: cachedPage.height
            };
        }

        const rendered = await renderPdfPage(resolvedPdfPath, pageNumber);
        try {
            const { imageBuffer, width, height, renderRegion } = rendered;
            let blocks = rendered.nativeBlocks;
            let source = 'native';
            let text = rendered.nativeText || '';
            let engine = 'pdfjs';
            let device = 'cpu';
            let modelRevision = requireFromHere('pdfjs-dist/package.json').version;
            let elapsedMs = 0;
            let qualityLimits = [];
            let metrics = {};
            try {
                if (forceOcr || !isMeaningfulNativeText(text)) {
                    const recognized = await documentOcr.recognizePage({ imageBuffer, width, height, renderRegion });
                    blocks = await documentBlocks(recognized, { imageBuffer, width, height, bookId,
                        pageNumber, cacheDirectory, imagePrefix: pageAssetPrefix(bookId, pageNumber) });
                    source = 'ocr';
                    engine = recognized.engine;
                    device = recognized.device;
                    modelRevision = recognized.modelRevision;
                    elapsedMs = recognized.elapsedMs;
                    qualityLimits = recognized.qualityLimits || [];
                    metrics = recognized.metrics || {};
                } else {
                    blocks = await processRegions({ blocks, imageBuffer, width, height,
                        cacheDirectory, imagePrefix: pageAssetPrefix(bookId, pageNumber), renderRegion,
                        recognizeMath: documentOcr.recognizeFormula });
                }
                text = blocksText(blocks);
                if (!validBlocks(blocks, text)) throw new Error('The recognized PDF layout is invalid.');
            } catch (error) {
                throw makeError(500, `PDF document recognition failed: ${error.message || String(error)}`);
            }
            const response = {
                page: pageNumber, text, blocks, source, confidence: null,
                engine, device, modelRevision, elapsedMs, qualityLimits,
                metrics: { ...metrics, sourceWindows: { ...renderRegion.stats } },
                pipelineVersion: CACHE_VERSION,
                imageUrl: pageImageUrl(bookId, pageNumber), width, height, imageBuffer
            };
            return await writeCache(cacheDirectory, response, fileStat);
        } finally {
            await rendered.release();
        }
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

            entry.forcePromise = entry.promise.then(() => {
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
        // A cached page must not wait behind another page's model inference.
        entry.promise = (async () => {
            const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
            const fileStat = await getPdfStat(resolvedPdfPath);
            const cached = entry.forceOcr ? null : await readCachedPage(path.join(pdfCacheRoot, bookId), bookId, page, fileStat);
            if (cached) {
                const { imagePath, ...result } = cached;
                return result;
            }
            return enqueue(() => processPage({
                bookId,
                pdfPath: resolvedPdfPath,
                pageNumber: page,
                forceOcr: entry.forceOcr
            }));
        })();
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
        await documentOcr.shutdown();
    }

    return { getPdfPage, deleteBookCache, shutdown };
}

module.exports = createPdfOcr;
