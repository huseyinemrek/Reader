'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const crypto = require('crypto');
const { nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');
const createDocumentOcr = require('./document-ocr');
const { documentBlocks } = require('./document-blocks');
const { createSourceWindowRenderer } = require('./pdf-windows');

const requireFromHere = createRequire(__filename);
const MAX_RENDER_DIMENSION = 3200;
const BASE_RENDER_SCALE = 2.5;
const CACHE_VERSION = 15;
const CLASSIFIER_VERSION = 2;
const PDFJS_PACKAGE_DIR = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_PACKAGE_DIR, 'standard_fonts').replace(/\\/g, '/')}/`;
const CMAP_URL = `${path.join(PDFJS_PACKAGE_DIR, 'cmaps').replace(/\\/g, '/')}/`;

function nativeFontStyle(font) {
    const name = font.name;
    const css = font.cssFontInfo;
    let weight;
    let italic = false;
    let oblique = false;
    const data = font.data;
    // PDF.js retains repaired SFNT tables with fontExtraProperties enabled.
    // CFF conversion synthesizes OS/2 weight 500, so never use that as source weight.
    if (data instanceof Uint8Array && data.byteLength >= 12) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const count = view.getUint16(4);
        if (12 + count * 16 <= data.byteLength) {
            const cff = view.getUint32(0) === 0x4f54544f;
            for (let index = 0; index < count; index += 1) {
                const record = 12 + index * 16;
                const tag = view.getUint32(record);
                const offset = view.getUint32(record + 8);
                const length = view.getUint32(record + 12);
                if (offset + length > data.byteLength) continue;
                if (tag === 0x4f532f32 && length >= 64) { // OS/2
                    const value = view.getUint16(offset + 4);
                    if (!cff && value >= 1 && value <= 1000) weight = value;
                    const selection = view.getUint16(offset + 62);
                    italic ||= !!(selection & 1);
                    oblique ||= !!(selection & 512);
                } else if (tag === 0x68656164 && length >= 46) { // head
                    italic ||= !!(view.getUint16(offset + 44) & 2);
                } else if (tag === 0x706f7374 && length >= 8) { // post
                    italic ||= view.getInt32(offset + 4) !== 0;
                }
            }
        }
    }
    const cssWeight = Number(css?.fontWeight);
    if (cssWeight >= 1 && cssWeight <= 1000) weight = cssWeight;
    if (weight === undefined) {
        if (font.black || /black|heavy/iu.test(name)) weight = 900;
        else if (/(?:extra|ultra)[ -]?bold/iu.test(name)) weight = 800;
        else if (/(?:semi|demi)[ -]?bold/iu.test(name)) weight = 600;
        else if (font.bold || /bold/iu.test(name) || css?.fontWeight === 'bold') weight = 700;
        else if (/(?:extra|ultra)[ -]?light/iu.test(name)) weight = 200;
        else if (/light/iu.test(name)) weight = 300;
        else if (/thin/iu.test(name)) weight = 100;
        else if (/medium/iu.test(name)) weight = 500;
        else weight = 400;
    }
    return {
        sourceFontName: name,
        fontFamily: font.fallbackName,
        fontStyle: oblique || /oblique/iu.test(name) || Number(css?.italicAngle) ? 'oblique' :
            italic || font.italic || /italic/iu.test(name) ? 'italic' : 'normal',
        fontWeight: weight
    };
}

async function nativeTextContent(page) {
    const content = await page.getTextContent();
    const names = [...new Set(content.items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => item.fontName))];
    if (!names.length) return content;
    // Loading font objects needs operators, not page.render or the OCR worker.
    await page.getOperatorList();
    await Promise.all(names.map(async name => {
        const font = await new Promise(resolve => page.commonObjs.get(name, resolve));
        if (font && typeof font.name === 'string' && font.name.trim()) {
            content.styles[name] = { ...content.styles[name], ...nativeFontStyle(font) };
        }
    }));
    return content;
}

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

function isNativeProse(text) {
    if (text.includes('\uFFFD')) return false;
    const words = text.match(/[\p{L}]{2,}(?:['’-][\p{L}]+)*/gu) || [];
    const letters = words.reduce((count, word) => count + word.length, 0);
    const characters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    // Plot labels and isolated mathematical glyphs are not a readable text layer.
    return letters >= characters * 0.7 &&
        (letters >= 200 || words.length >= 8 && letters >= 40 ||
            words.length >= 2 && letters >= 8 && /[.!?。！？]\s*$/u.test(text));
}

function createPdfOcr(uploadsDirectory) {
    const uploadsRoot = path.resolve(uploadsDirectory);
    const pdfCacheRoot = path.join(uploadsRoot, 'pdf');
    let jobQueue = Promise.resolve();
    const documentOcr = createDocumentOcr();
    let pdfjsPromise = null;

    let shuttingDown = false;
    const inFlightPages = new Map();
    const bookGenerations = new Map();
    const descriptors = new Map();
    const describing = new Map();

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


    function sourceVersion(fileStat) {
        return crypto.createHash('sha256').update(`${fileStat.size}:${fileStat.mtimeMs}`).digest('hex');
    }

    async function getSource({ bookId, pdfPath }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        return { pdfPath: resolvedPdfPath, sourceVersion: sourceVersion(fileStat) };
    }

    async function describePdf({ bookId, pdfPath, page }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        const version = sourceVersion(fileStat);
        const key = `${bookId}:${version}`;
        const descriptorPath = path.join(pdfCacheRoot, bookId, 'descriptor.json');
        if (page === undefined) {
            const previous = descriptors.get(bookId);
            if (previous?.sourceVersion === version) return { ...previous };
            if (describing.has(key)) return { ...await describing.get(key) };
            try {
                const cached = JSON.parse(await fs.promises.readFile(descriptorPath, 'utf8'));
                if (cached.classifierVersion === CLASSIFIER_VERSION && cached.sourceVersion === version &&
                    Number.isSafeInteger(cached.totalPages) && cached.totalPages > 0 && ['native', 'scanned'].includes(cached.textLayer)) {
                    const { classifierVersion, ...descriptor } = cached;
                    descriptors.set(bookId, descriptor);
                    return { ...descriptor };
                }
            } catch (_) {}
        }
        const work = (async () => {
            const pdfjs = await loadPdfJs();
            const task = pdfjs.getDocument({
                data: new Uint8Array(await fs.promises.readFile(resolvedPdfPath)),
                standardFontDataUrl: STANDARD_FONT_DATA_URL, cMapUrl: CMAP_URL, cMapPacked: true
            });
            try {
                const document = await task.promise;
                const result = { totalPages: document.numPages, sourceVersion: version };
                if (page !== undefined) {
                    if (!Number.isSafeInteger(page) || page < 1 || page > document.numPages) throw makeError(400, 'Invalid PDF page number.');
                    const sourcePage = await document.getPage(page);
                    const unit = sourcePage.getViewport({ scale: 1 });
                    const viewport = sourcePage.getViewport({ scale: Math.min(BASE_RENDER_SCALE, MAX_RENDER_DIMENSION / Math.max(unit.width, unit.height)) });
                    result.width = Math.max(1, Math.ceil(viewport.width));
                    result.height = Math.max(1, Math.ceil(viewport.height));
                } else {
                    result.textLayer = 'scanned';
                    // Covers/front matter cannot decide the book: inspect until readable native text is found.
                    for (let number = 1; number <= document.numPages; number++) {
                        const sourcePage = await document.getPage(number);
                        try {
                            const content = await sourcePage.getTextContent();
                            const blocks = nativeBlocks(content, sourcePage.getViewport({ scale: 1 }));
                            let hasNativeText = blocks.some(block => isNativeProse(block.text));
                            if (!hasNativeText && blocks.some(block =>
                                !block.text.includes('\uFFFD') && /[\p{L}]{3,}/u.test(block.text))) {
                                const { OPS } = pdfjs;
                                const operators = await sourcePage.getOperatorList();
                                const graphics = new Set([
                                    OPS.constructPath, OPS.rawFillPath, OPS.shadingFill,
                                    OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill,
                                    OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
                                    OPS.paintImageXObject, OPS.paintImageXObjectRepeat,
                                    OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
                                    OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
                                    OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask
                                ]);
                                // Sparse digital titles are still native text; plot labels
                                // beside raster/vector graphics are not a readable page body.
                                hasNativeText = !operators.fnArray.some(operation => graphics.has(operation));
                            }
                            if (hasNativeText) {
                                result.textLayer = 'native';
                                break;
                            }
                        } finally {
                            sourcePage.cleanup();
                        }
                    }
                }
                if (sourceVersion(await getPdfStat(resolvedPdfPath)) !== version) throw makeError(409, 'The PDF source changed.');
                if (page === undefined) {
                    descriptors.set(bookId, result);
                    await fs.promises.mkdir(path.dirname(descriptorPath), { recursive: true });
                    const temporary = `${descriptorPath}.${crypto.randomUUID()}.tmp`;
                    try {
                        await fs.promises.writeFile(temporary, JSON.stringify({ classifierVersion: CLASSIFIER_VERSION, ...result }));
                        fs.renameSync(temporary, descriptorPath);
                    } finally {
                        await fs.promises.rm(temporary, { force: true });
                    }
                }
                return result;
            } finally {
                await task.destroy();
            }
        })();
        if (page === undefined) describing.set(key, work);
        try { return { ...await work }; } finally {
            if (describing.get(key) === work) describing.delete(key);
        }
    }

    async function readNativePage({ bookId, pdfPath, page, expectedSourceVersion }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        const version = sourceVersion(fileStat);
        if (expectedSourceVersion && version !== expectedSourceVersion) throw makeError(409, 'The PDF source changed.');
        const pdfjs = await loadPdfJs();
        const task = pdfjs.getDocument({
            data: new Uint8Array(await fs.promises.readFile(resolvedPdfPath)),
            standardFontDataUrl: STANDARD_FONT_DATA_URL, cMapUrl: CMAP_URL, cMapPacked: true,
            fontExtraProperties: true
        });
        try {
            const document = await task.promise;
            if (page > document.numPages) throw makeError(400, 'Invalid PDF page number.');
            const sourcePage = await document.getPage(page);
            const unit = sourcePage.getViewport({ scale: 1 });
            const viewport = sourcePage.getViewport({ scale: Math.min(BASE_RENDER_SCALE, MAX_RENDER_DIMENSION / Math.max(unit.width, unit.height)) });
            const blocks = nativeBlocks(await nativeTextContent(sourcePage), viewport);
            if (sourceVersion(await getPdfStat(resolvedPdfPath)) !== version) throw makeError(409, 'The PDF source changed.');
            return {
                page, text: blocksText(blocks), blocks, source: 'native', confidence: null,
                engine: 'pdfjs', device: 'cpu', modelRevision: requireFromHere('pdfjs-dist/package.json').version,
                elapsedMs: 0, qualityLimits: [], metrics: {}, pipelineVersion: CACHE_VERSION,
                width: Math.max(1, Math.ceil(viewport.width)), height: Math.max(1, Math.ceil(viewport.height))
            };
        } finally {
            await task.destroy();
        }
    }

    async function getCachedPage({ bookId, pdfPath, page, expectedSourceVersion }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        if (expectedSourceVersion && sourceVersion(fileStat) !== expectedSourceVersion) throw makeError(409, 'The PDF source changed.');
        const cached = await readCachedPage(path.join(pdfCacheRoot, bookId), bookId, page, fileStat);
        if (!cached || cached.source !== 'ocr') return null;
        const { imagePath, ...result } = cached;
        return result;
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

    async function writeCache(cacheDirectory, pageResult, fileStat, { stagingDirectory, pdfPath, isCurrent = () => true } = {}) {
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
            await fs.promises.writeFile(temporaryJsonPath, JSON.stringify(cacheRecord), 'utf8');
            if (!isCurrent()) throw makeError(409, 'The OCR job was replaced or deleted.');
            if (pdfPath) {
                const latest = fs.lstatSync(pdfPath);
                if (!latest.isFile() || sourceVersion(latest) !== sourceVersion(fileStat)) throw makeError(409, 'The PDF source changed during OCR.');
            }
            // Publish without yielding: an obsolete generation cannot overwrite a newer lease.
            if (stagingDirectory) {
                for (const block of pageResult.blocks) {
                    if (block.type === 'image') {
                        const filename = path.basename(block.imageUrl);
                        fs.renameSync(path.join(stagingDirectory, filename), path.join(cacheDirectory, filename));
                    }
                }
            }
            fs.renameSync(temporaryImagePath, imagePath);
            fs.renameSync(temporaryJsonPath, jsonPath);
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
            // OCR must see source edges, not JPEG ringing around small math glyphs.
            const imageBuffer = canvas.toBuffer('image/png');
            const renderRegion = createSourceWindowRenderer(page, viewport, canvas);
            retained = true;
            return {
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

    async function processPage({ bookId, pdfPath, pageNumber, regenerate, expectedSourceVersion, isCurrent = () => true }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        if (expectedSourceVersion && sourceVersion(fileStat) !== expectedSourceVersion) throw makeError(409, 'The PDF source changed.');
        if (!isCurrent()) throw makeError(409, 'The OCR job was replaced or deleted.');
        const cacheDirectory = path.join(pdfCacheRoot, bookId);
        await fs.promises.mkdir(cacheDirectory, { recursive: true });

        const cachedPage = regenerate ? null : await readCachedPage(cacheDirectory, bookId, pageNumber, fileStat);
        if (cachedPage?.source === 'ocr') {
            if (!isCurrent()) throw makeError(409, 'The OCR job was replaced or deleted.');
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

        const stagingDirectory = path.join(cacheDirectory, `.work-${crypto.randomUUID()}`);
        let rendered;
        try {
            await fs.promises.mkdir(stagingDirectory, { recursive: true });
            if (!isCurrent()) throw makeError(409, 'The OCR job was replaced or deleted.');
            rendered = await renderPdfPage(resolvedPdfPath, pageNumber);
            const { imageBuffer, width, height, renderRegion } = rendered;
            if (!isCurrent()) throw makeError(409, 'The OCR job was replaced or deleted.');
            let recognized;
            let blocks;
            try {
                recognized = await documentOcr.recognizePage({ imageBuffer, width, height, renderRegion });
                blocks = await documentBlocks(recognized, { imageBuffer, width, height, bookId,
                    pageNumber, cacheDirectory: stagingDirectory, imagePrefix: pageAssetPrefix(bookId, pageNumber) });
                if (!validBlocks(blocks, blocksText(blocks))) throw new Error('The recognized PDF layout is invalid.');
            } catch (error) {
                throw makeError(500, `PDF document recognition failed: ${error.message || String(error)}`);
            }
            const response = {
                page: pageNumber, text: blocksText(blocks), blocks, source: 'ocr', confidence: null,
                engine: recognized.engine, device: recognized.device, modelRevision: recognized.modelRevision,
                elapsedMs: recognized.elapsedMs, qualityLimits: recognized.qualityLimits || [],
                metrics: { ...recognized.metrics, sourceWindows: { ...renderRegion.stats } },
                pipelineVersion: CACHE_VERSION,
                imageUrl: pageImageUrl(bookId, pageNumber), width, height, imageBuffer
            };
            return await writeCache(cacheDirectory, response, fileStat, { stagingDirectory, pdfPath: resolvedPdfPath, isCurrent });
        } finally {
            await rendered?.release();
            await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
        }
    }

    async function saveComputedPage({ bookId, pdfPath, page, image, result, expectedSourceVersion, isCurrent }) {
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        if (sourceVersion(fileStat) !== expectedSourceVersion) throw makeError(409, 'The PDF source changed.');
        const geometry = await describePdf({ bookId, pdfPath, page });
        if (geometry.sourceVersion !== expectedSourceVersion) throw makeError(409, 'The PDF source changed.');
        if (typeof image !== 'string' || image.length > 44 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)) {
            throw makeError(400, 'The worker image must be a base64 PNG smaller than 32 MiB.');
        }
        const imageBuffer = Buffer.from(image, 'base64');
        const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (imageBuffer.length < 24 || imageBuffer.length > 32 * 1024 * 1024 || !imageBuffer.subarray(0, 8).equals(pngSignature) ||
            imageBuffer.toString('ascii', 12, 16) !== 'IHDR' ||
            imageBuffer.readUInt32BE(16) !== geometry.width || imageBuffer.readUInt32BE(20) !== geometry.height) {
            throw makeError(400, 'The worker PNG dimensions do not match the PDF source.');
        }
        const decoded = await requireFromHere('@napi-rs/canvas').loadImage(imageBuffer);
        if (decoded.width !== geometry.width || decoded.height !== geometry.height) throw makeError(400, 'The worker PNG is invalid.');
        if (!result || typeof result.engine !== 'string' || typeof result.device !== 'string' ||
            typeof result.modelRevision !== 'string' || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 ||
            !Array.isArray(result.qualityLimits) || !result.qualityLimits.every(limit => typeof limit === 'string') ||
            result.metrics !== undefined && (!result.metrics || typeof result.metrics !== 'object' || Array.isArray(result.metrics))) {
            throw makeError(400, 'The worker OCR metadata is invalid.');
        }
        const cacheDirectory = path.join(pdfCacheRoot, bookId);
        const stagingDirectory = path.join(cacheDirectory, `.work-${crypto.randomUUID()}`);
        await fs.promises.mkdir(stagingDirectory, { recursive: true });
        try {
            const blocks = await documentBlocks(result, { imageBuffer, width: geometry.width, height: geometry.height,
                bookId, pageNumber: page, cacheDirectory: stagingDirectory, imagePrefix: pageAssetPrefix(bookId, page) });
            return await writeCache(cacheDirectory, {
                page, text: blocksText(blocks), blocks, source: 'ocr', confidence: null,
                engine: result.engine, device: result.device, modelRevision: result.modelRevision,
                elapsedMs: result.elapsedMs, qualityLimits: result.qualityLimits, metrics: result.metrics || {},
                pipelineVersion: CACHE_VERSION, imageUrl: pageImageUrl(bookId, page),
                width: geometry.width, height: geometry.height, imageBuffer
            }, fileStat, { stagingDirectory, pdfPath: resolvedPdfPath, isCurrent });
        } finally {
            await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
        }
    }

    async function getPdfPage({ bookId, pdfPath, page, nativeOnly, forceOcr = false, regenerate = forceOcr,
        generation = '', expectedSourceVersion, isCurrent = () => true }) {
        if (shuttingDown) throw makeError(503, 'PDF processing is shutting down.');
        if (!Number.isSafeInteger(page) || page < 1) throw makeError(400, 'Invalid page number.');
        if (nativeOnly === undefined) {
            nativeOnly = !forceOcr && (await describePdf({ bookId, pdfPath })).textLayer === 'native';
        }
        // Native extraction has no raster/model/cache dependency and never joins queued OCR.
        if (nativeOnly) return readNativePage({ bookId, pdfPath, page, expectedSourceVersion });
        const localGeneration = bookGenerations.get(bookId) || 0;
        const current = () => (bookGenerations.get(bookId) || 0) === localGeneration && isCurrent();
        const resolvedPdfPath = resolvePdfPath(pdfPath, bookId);
        const fileStat = await getPdfStat(resolvedPdfPath);
        const version = sourceVersion(fileStat);
        if (expectedSourceVersion && version !== expectedSourceVersion) throw makeError(409, 'The PDF source changed.');
        if (!current()) throw makeError(409, 'The OCR job was replaced or deleted.');
        const key = `${bookId}:${page}:${version}:${localGeneration}:${generation}:${Boolean(regenerate)}`;
        const existing = inFlightPages.get(key);
        if (existing) return existing.promise;
        const entry = { promise: null };
        entry.promise = (async () => {
            const cached = regenerate ? null : await readCachedPage(path.join(pdfCacheRoot, bookId), bookId, page, fileStat);
            if (!current()) throw makeError(409, 'The OCR job was replaced or deleted.');
            if (cached?.source === 'ocr') {
                const { imagePath, ...result } = cached;
                return result;
            }
            return enqueue(() => processPage({
                bookId, pdfPath: resolvedPdfPath, pageNumber: page, regenerate,
                expectedSourceVersion: version, isCurrent: current
            }));
        })();
        inFlightPages.set(key, entry);
        const clear = () => {
            if (inFlightPages.get(key) === entry) inFlightPages.delete(key);
        };
        entry.promise.then(clear, clear);
        return entry.promise;
    }

    function cancelBookOcr(bookId) {
        bookGenerations.set(bookId, (bookGenerations.get(bookId) || 0) + 1);
    }

    function deleteBookCache(bookId, { waitForJobs = true } = {}) {
        if (typeof bookId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(bookId)) {
            return Promise.reject(makeError(400, 'Invalid book identifier.'));
        }
        cancelBookOcr(bookId);
        descriptors.delete(bookId);
        const cacheDirectory = path.join(pdfCacheRoot, bookId);
        if (!waitForJobs) return fs.promises.rm(cacheDirectory, { recursive: true, force: true });
        const pagePrefix = `${bookId}:`;
        const pendingPages = [];
        for (const [key, entry] of inFlightPages) {
            if (key.startsWith(pagePrefix)) {
                pendingPages.push(entry.promise);
            }
        }
        return Promise.allSettled(pendingPages)
            .then(() => enqueue(() => fs.promises.rm(cacheDirectory, { recursive: true, force: true })));
    }

    async function shutdown() {
        shuttingDown = true;
        await documentOcr.shutdown();
        const pendingPages = Array.from(inFlightPages.values(), entry => entry.promise);
        await Promise.allSettled(pendingPages);
        await jobQueue;
    }

    return { getPdfPage, getCachedPage, getSource, describePdf, saveComputedPage, cancelBookOcr, deleteBookCache, shutdown, pipelineVersion: CACHE_VERSION };
}

module.exports = createPdfOcr;
