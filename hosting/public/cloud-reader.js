import { RemoteZip } from './range-archive.js';
import { readLayoutBundle, imageDimensions } from './layout-bundle.js';

export const RESOURCE_BASE = 'https://epub.local/';
const XLINK = 'http://www.w3.org/1999/xlink';

// Shared by the visible chapter and page-counting document. Inline image margins,
// baseline space and publisher padding can otherwise overflow a whole column.
const pagedImageCss = `
#reader-view.paged-mode #book-content .epub-chapter [data-reader-image-block] {
    padding-block: 0 !important;
    margin-block: 20px !important;
    break-inside: avoid !important;
}
#reader-view.paged-mode #book-content .epub-chapter [data-reader-image-block] [data-reader-image-block] {
    margin-block: 0 !important;
}
#reader-view.paged-mode #book-content .epub-chapter [data-reader-image-block] img {
    display: block;
    margin: 0 auto !important;
}
#reader-view.paged-mode #book-content .epub-chapter img[data-reader-image-block] {
    display: block;
    margin: 20px auto !important;
}
/* End a caption/credit keep-with-next chain before the next independent image. */
#reader-view.paged-mode #book-content .epub-chapter :has(+ [data-reader-image-block]) {
    break-after: auto !important;
}
#reader-view.paged-mode #book-content[data-reader-gap-measuring] {
    column-width: auto !important;
    column-count: auto !important;
    height: auto !important;
}
#reader-view.paged-mode #book-content .epub-chapter [data-reader-gap-height] img,
#reader-view.paged-mode #book-content .epub-chapter img[data-reader-gap-height] {
    max-height: var(--reader-gap-height) !important;
}
#reader-view.paged-mode #book-content .epub-chapter [data-reader-gap-part] {
    break-inside: avoid-column !important;
    break-after: avoid-column !important;
}
#reader-view.paged-mode #book-content .epub-chapter [data-reader-gap-part="end"] {
    break-after: auto !important;
}`;

function imageOf(element) { return element.matches('img') ? element : element.querySelector('img'); }

function imageGapCandidates(section) {
    const images = [...section.querySelectorAll('[data-reader-image-block]')]
        .filter(element => !element.parentElement.closest('[data-reader-image-block]'));
    return images.slice(1).map((right, index) => {
        let left = images[index];
        let parent = left.parentElement;
        while (parent && !parent.contains(right)) parent = parent.parentElement;
        if (!parent || !section.contains(parent)) return null;
        let last = right;
        while (left.parentElement !== parent) left = left.parentElement;
        while (last.parentElement !== parent) last = last.parentElement;
        if (left === last || left.textContent.trim() || last.textContent.trim() ||
            (!left.matches('img') && left.querySelectorAll('img').length !== 1) ||
            (!last.matches('img') && last.querySelectorAll('img').length !== 1)) return null;
        const text = [];
        for (let node = left.nextSibling; node && node !== last; node = node.nextSibling) {
            if (node.nodeType === 3 && node.textContent.trim()) return null;
            if (node.nodeType !== 1 || !node.textContent.trim()) continue;
            if (node.matches('h1,h2,h3,h4,h5,h6,table,hr') || node.querySelector('img,svg,table,hr,h1,h2,h3,h4,h5,h6')) return null;
            text.push(node);
        }
        return text.length ? { pair: index, left, right: last, text } : null;
    });
}

// One batch of continuous-flow measurements per chapter/layout, then one batch
// of writes. Cached plans also drive the visible document; turning a page never
// invokes this measurement. No caption classification or text reordering.
export function createImageGapLayout() {
    const layouts = new Map();
    const applied = new WeakMap();
    function plansFor(key) {
        if (!layouts.has(key)) {
            layouts.set(key, new Map());
            if (layouts.size > 2) layouts.delete(layouts.keys().next().value);
        }
        return layouts.get(key);
    }
    function apply(section, candidates, plan) {
        for (const element of section.querySelectorAll('[data-reader-gap-part],[data-reader-gap-height]')) {
            delete element.dataset.readerGapPart;
            delete element.dataset.readerGapHeight;
            element.style.removeProperty('--reader-gap-height');
        }
        for (const entry of plan) {
            const candidate = candidates[entry.pair];
            if (!candidate) continue;
            const image = entry.side === 'after' ? candidate.left : candidate.right;
            image.dataset.readerGapHeight = '';
            image.style.setProperty('--reader-gap-height', entry.height + 'px');
            const parts = entry.side === 'after' ? [image, ...candidate.text] : [...candidate.text, image];
            parts.forEach((element, index) => { element.dataset.readerGapPart = index === parts.length - 1 ? 'end' : 'keep'; });
        }
    }
    return {
        restore(key, plans) {
            if (!Array.isArray(plans) || !plans.every(plan => Array.isArray(plan) && plan.every(entry =>
                Number.isSafeInteger(entry.pair) && entry.pair >= 0 && ['before', 'after'].includes(entry.side) &&
                Number.isFinite(entry.height) && entry.height >= 1))) return false;
            const layout = plansFor(key);
            plans.forEach((plan, index) => layout.set(index, plan));
            return true;
        },
        serialize(key, length) {
            const layout = plansFor(key);
            return Array.from({ length }, (_, index) => layout.get(index) || []);
        },
        fit(article, key) {
            const root = article.closest('#book-content');
            if (!root?.closest('#reader-view.paged-mode')) return;
            const sections = article.matches('.epub-chapter') ? [article] : [...article.querySelectorAll('.epub-chapter')];
            const layout = plansFor(key);
            const pending = [];
            for (const section of sections) {
                if (applied.get(section) === key) continue;
                const candidates = imageGapCandidates(section);
                const index = Number(section.dataset.index);
                if (layout.has(index)) {
                    apply(section, candidates, layout.get(index));
                    applied.set(section, key);
                } else {
                    apply(section, candidates, []);
                    if (!candidates.some(Boolean)) { layout.set(index, []); applied.set(section, key); }
                    else pending.push({ section, index, candidates });
                }
            }
            if (!pending.length) return;
            const view = root.ownerDocument.defaultView;
            const rootStyle = view.getComputedStyle(root);
            const pageHeight = parseFloat(rootStyle.height);
            const stride = parseFloat(rootStyle.columnWidth) + parseFloat(rootStyle.columnGap);
            if (!Number.isFinite(pageHeight) || pageHeight <= 0 || !Number.isFinite(stride) || stride <= 0) return;
            const origin = root.getBoundingClientRect().left + parseFloat(rootStyle.paddingLeft);
            const column = rect => Math.floor((rect.left - origin + .5) / stride);
            // Read the existing pagination first. A short interval sharing either
            // image's column is already well packed and requires no flow probe.
            for (const item of pending) {
                item.candidates = item.candidates.map(candidate => {
                    if (!candidate) return null;
                    const imageColumns = [candidate.left, candidate.right].map(element => column(imageOf(element).getBoundingClientRect()));
                    const range = root.ownerDocument.createRange();
                    const textColumns = new Set();
                    const isolated = candidate.text.every(element => {
                        range.selectNodeContents(element);
                        return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
                            .every(rect => {
                                const value = column(rect);
                                textColumns.add(value);
                                return !imageColumns.includes(value) && textColumns.size <= 1;
                            });
                    });
                    return isolated && textColumns.size === 1 ? candidate : null;
                });
            }
            if (!pending.some(item => item.candidates.some(Boolean))) {
                pending.forEach(item => { layout.set(item.index, []); applied.set(item.section, key); });
                return;
            }
            root.dataset.readerGapMeasuring = '';
            let measurements;
            try {
                measurements = pending.map(item => ({ ...item, measurements: item.candidates.map(candidate => {
                    if (!candidate) return null;
                    const { left, right, text } = candidate;
                    const first = text[0], last = text.at(-1);
                    const top = first.getBoundingClientRect().top, bottom = last.getBoundingClientRect().bottom;
                    const height = bottom - top;
                    const css = element => view.getComputedStyle(element);
                    const forcedBreak = element => [css(element).breakBefore, css(element).breakAfter]
                        .some(value => ['column', 'page', 'always', 'left', 'right'].includes(value));
                    const margin = (element, side) => Math.max(0, parseFloat(css(element)[side]) || 0);
                    if (height <= 0 || height > pageHeight * .25 || text.some(forcedBreak)) return null;
                    return ['after', 'before'].map(side => {
                        const block = side === 'after' ? left : right;
                        const image = imageOf(block);
                        if (forcedBreak(block)) return null;
                        const imageHeight = image.getBoundingClientRect().height;
                        if (imageHeight < pageHeight * .6) return null;
                        const extra = block.getBoundingClientRect().height - imageHeight;
                        const gap = side === 'after' ? top - left.getBoundingClientRect().bottom : right.getBoundingClientRect().top - bottom;
                        const outside = side === 'after'
                            ? margin(left, 'marginTop') + margin(last, 'marginBottom')
                            : margin(first, 'marginTop') + margin(right, 'marginBottom');
                        const target = Math.floor(Math.min(imageHeight, pageHeight - height - gap - outside - extra - 2));
                        const shrink = 1 - target / imageHeight;
                        return target > 0 && shrink >= 0 && shrink <= .25
                            ? { pair: candidate.pair, side, height: target, shrink, image: block } : null;
                    }).filter(Boolean);
                }) }));
            } finally { delete root.dataset.readerGapMeasuring; }
            for (const item of measurements) {
                const used = new Set();
                const plan = [];
                for (const options of item.measurements) {
                    if (!options?.length) continue;
                    // Prefer the previous image when the size difference is tiny.
                    const available = options.filter(option => !used.has(option.image))
                        .sort((a, b) => (a.shrink + (a.side === 'before' ? .01 : 0)) - (b.shrink + (b.side === 'before' ? .01 : 0)));
                    const best = available[0];
                    if (!best) continue;
                    used.add(best.image);
                    plan.push({ pair: best.pair, side: best.side, height: best.height });
                }
                layout.set(item.index, plan);
                apply(item.section, item.candidates, plan);
                applied.set(item.section, key);
            }
        }
    };
}

export function storageErrorMessage(error) {
    if (error.code === 'storage/quota-exceeded') {
        return 'Cloud Storage bucket erişimi kota veya faturalandırma nedeniyle durdurulmuş. ' +
            'Hosting ekranındaki 360 MB/gün ve Firestore kotaları kitap deposuna ait değildir. ' +
            'Firebase > Storage kullanımını ve bu projenin etkin Cloud Billing hesabını kontrol edin. ' +
            'Blaze görünmesi tek başına bucket erişiminin açık olduğunu doğrulamaz. (' + error.code + ')';
    }
    if (error.code === 'storage/unauthorized') return 'Kitap deposuna erişim izni yok. Oturumu ve kullanıcıya özel Storage kurallarını kontrol edin. (' + error.code + ')';
    return error.message || String(error);
}

function pathOf(url) {
    const resolved = new URL(url, RESOURCE_BASE);
    if (resolved.origin !== new URL(RESOURCE_BASE).origin) return null;
    return decodeURIComponent(resolved.pathname.slice(1));
}

function placeholder({ width = 800, height = 1200 } = {}) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`);
}

function mimeType(path) {
    const extension = path.split('.').pop().toLowerCase();
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        avif: 'image/avif', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' })[extension] || 'application/octet-stream';
}

const absoluteFontSizes = {
    'xx-small': 0.5625, 'x-small': 0.625, small: 0.8125, medium: 1,
    large: 1.125, 'x-large': 1.5, 'xx-large': 2, 'xxx-large': 3
};

function normalizeFontSize(value) {
    const keyword = value.trim().toLowerCase();
    if (Object.hasOwn(absoluteFontSizes, keyword)) {
        return `calc(var(--font-size) * ${absoluteFontSizes[keyword]})`;
    }
    return value.replace(/([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|rem)(?![\w-])/gi, (match, amount, unit) => {
        const scale = unit.toLowerCase() === 'pt' ? 1 / 12 : unit.toLowerCase() === 'rem' ? 1 : 1 / 16;
        const ratio = Number(amount) * scale;
        return Number.isFinite(ratio) ? `calc(var(--font-size) * ${Number(ratio.toFixed(6))})` : match;
    });
}

export function normalizeInlineStyle(style) {
    const size = style.getPropertyValue('font-size');
    if (size) style.setProperty('font-size', normalizeFontSize(size), style.getPropertyPriority('font-size'));
    if (style.getPropertyValue('text-align').trim().toLowerCase() === 'justify') {
        style.setProperty('text-align', 'start', style.getPropertyPriority('text-align'));
    }
}

// Only the compressed layout index is fetched on open. The original ZIP is opened
// lazily on the first visible image/font request and is always read using Range.
export async function createBookResources(book, { uid, signal, source = null }) {
    let index = { texts: Object.create(null), images: Object.create(null) };
    if (book.layoutUrl) {
        const response = await fetch(book.layoutUrl, { signal, cache: 'force-cache' });
        if (!response.ok) throw new Error('Kitabın düzen dosyası indirilemedi (' + response.status + ').');
        index = await readLayoutBundle(await response.arrayBuffer());
        signal.throwIfAborted();
    }
    const layoutReady = source
        ? source.layout.then(value => { signal.throwIfAborted(); index = value; })
        : Promise.resolve();
    layoutReady.catch(() => {});
    let archivePromise;
    let disposed = false;
    const blobs = new Map();
    const pendingBlobs = new Map();
    const archive = () => archivePromise ||= RemoteZip.open(book.bookUrl, {
        signal, cacheKey: uid + ':' + book.id + ':' + book.addedAt
    });
    const actualPath = async path => {
        const zip = await archive();
        return zip.has(path) ? path : zip.names().find(name => name.toLowerCase() === path.toLowerCase()) || path;
    };
    async function assetUrl(path) {
        signal.throwIfAborted();
        if (source) return source.assetUrl(path);
        if (blobs.has(path)) return blobs.get(path);
        if (pendingBlobs.has(path)) return pendingBlobs.get(path);
        const task = (async () => {
            const zip = await archive();
            const bytes = await zip.read(await actualPath(path), 'uint8array', signal);
            signal.throwIfAborted();
            if (disposed) throw new DOMException('Kitap kapatıldı.', 'AbortError');
            const url = URL.createObjectURL(new Blob([bytes], { type: mimeType(path) }));
            blobs.set(path, url);
            return url;
        })();
        pendingBlobs.set(path, task);
        try { return await task; } finally { pendingBlobs.delete(path); }
    }
    async function text(url, requestSignal = signal) {
        requestSignal.throwIfAborted();
        const path = pathOf(url);
        if (path === null) throw new Error('Kitap dışındaki metin kaynakları yüklenemez.');
        let value = index.texts[path];
        if (value === undefined) {
            const matched = Object.keys(index.texts).find(name => name.toLowerCase() === path.toLowerCase());
            if (matched) value = index.texts[matched];
        }
        if (value === undefined) {
            value = source ? await source.text(path, requestSignal)
                : await (await archive()).read(await actualPath(path), 'string', requestSignal);
            index.texts[path] = value;
        }
        requestSignal.throwIfAborted();
        return value;
    }
    async function dimensions(path) {
        if (source) await layoutReady;
        if (index.images[path]) return index.images[path];
        const matched = Object.keys(index.images).find(name => name.toLowerCase() === path.toLowerCase());
        if (matched) return index.images[matched];
        if (source) throw new Error('Görsel ölçüleri düzen paketinde bulunamadı: ' + path);
        // Old uploads have no geometry index. Determine it once from the cached
        // individual entry; new uploads never fetch image bytes for pagination.
        const zip = await archive();
        const bytes = await zip.read(await actualPath(path), 'uint8array', signal);
        const size = imageDimensions(bytes, path);
        if (!size) throw new Error('Görsel ölçüleri bulunamadı. Kitabı yeniden yükleyin: ' + path);
        index.images[path] = size;
        return size;
    }
    async function cssUrls(css, base, decorations = false) {
        // Measurement never downloads decorations. Server-backed readers can
        // let the browser fetch matching CSS images from authenticated URLs.
        const matches = [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)];
        for (const match of matches) {
            const raw = match[2];
            if (raw.startsWith('data:') || raw.startsWith('#')) continue;
            const path = pathOf(new URL(raw, base).href);
            const url = path && (/\.(woff2?|ttf|otf)$/i.test(path) || (source && decorations))
                ? await assetUrl(path) : placeholder({width: 1, height: 1});
            css = css.replaceAll(match[0], `url("${url}")`);
        }
        return css;
    }


    function normalizedCss(css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        function serialize(rules) {
            const output = [];
            for (const rule of rules) {
                if (rule.type === CSSRule.PAGE_RULE) continue;
                const style = rule.style;
                if (style) {
                    const size = style.getPropertyValue('font-size');
                    if (size) style.setProperty('font-size', normalizeFontSize(size), style.getPropertyPriority('font-size'));
                    if (style.getPropertyValue('text-align').trim().toLowerCase() === 'justify') {
                        style.setProperty('text-align', 'start', style.getPropertyPriority('text-align'));
                    }
                }
                if (typeof rule.selectorText === 'string') {
                    rule.selectorText = rule.selectorText.replace(/(^|[^\w-])(body|html)(?=[^\w-]|$)/gi, '$1.epub-chapter');
                }
                if (rule.cssRules) serialize(rule.cssRules);
                output.push(rule.cssText);
            }
            return output.join('\n');
        }
        return serialize(sheet.cssRules);
    }


    async function cssText(css, base, seen = new Set(), decorations = false) {
        if (seen.has(base)) return '';
        seen = new Set([...seen, base]);
        // Resolve CSS imports ourselves, so the browser cannot fetch entire
        // external books or bypass the resource policy during measurement.
        const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?[^;]*;/gi)];
        for (const match of imports) {
            const url = new URL(match[1], base).href;
            const imported = pathOf(url) === null ? '' : await cssText(await text(url), url, seen, decorations);
            css = css.replace(match[0], imported);
        }
        css = css.replace(/@import[^;]*;/gi, '').replace(/@namespace[^;]+;/gi, '');
        return cssUrls(normalizedCss(css), base, decorations);
    }
    async function section(html, base, targetDocument, chapterIndex = 0, id = '') {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const decorations = !!source && targetDocument === globalThis.document;
        let css = '';
        for (const style of parsed.querySelectorAll('style')) {
            css += await cssText(style.textContent, base, new Set(), decorations);
            style.remove();
        }
        for (const link of parsed.querySelectorAll('link[rel="stylesheet"]')) {
            const href = link.getAttribute('href');
            if (href && pathOf(new URL(href, base).href) !== null) {
                const url = new URL(href, base).href;
                css += await cssText(await text(url), url, new Set(), decorations);
            }
        }
        parsed.querySelectorAll('script,iframe,object,embed,base,link,form,audio,video,source,foreignObject,animate,set').forEach(el => el.remove());
        for (const element of parsed.body.querySelectorAll('*')) {
            for (const attr of [...element.attributes]) {
                if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
            }
            element.removeAttribute('srcset');
            element.removeAttribute('ping');
            if (element.hasAttribute('style')) {
                normalizeInlineStyle(element.style);
                element.setAttribute('style', await cssUrls(element.style.cssText, base, decorations));
            }
            const isImage = ['img', 'image'].includes(element.localName);
            if (isImage) {
                const raw = element.getAttribute('src') || element.getAttribute('href') || element.getAttribute('xlink:href');
                element.removeAttribute('src'); element.removeAttribute('href'); element.removeAttribute('xlink:href');
                const path = raw && !raw.startsWith('data:') ? pathOf(new URL(raw, base).href) : null;
                let source = raw?.startsWith('data:image/') ? raw : placeholder();
                if (path) {
                    const size = await dimensions(path);
                    source = placeholder(size);
                    element.dataset.readerAsset = path;
                }
                if (element.localName === 'img') {
                    element.src = source;
                    element.decoding = 'async';
                } else {
                    element.setAttribute('href', source);
                    element.setAttributeNS(XLINK, 'href', source);
                }
            } else {
                element.removeAttribute('src');
                for (const name of ['href', 'xlink:href']) {
                    const raw = element.getAttribute(name);
                    if (!raw) continue;
                    const url = new URL(raw, base);
                    if (element.localName === 'a' && ['http:', 'https:', 'mailto:'].includes(url.protocol)) {
                        element.setAttribute(name, url.href);
                        element.setAttribute('rel', 'noopener noreferrer');
                    } else if (!raw.startsWith('#')) element.removeAttribute(name);
                }
            }
        }
        for (const element of parsed.body.querySelectorAll('div,p,figure')) {
            // Keep inline illustrations and figures containing captions in their
            // source flow. Nested image-only wrappers share one outer spacing.
            if (!element.textContent.trim() && element.querySelectorAll('img').length === 1 &&
                !element.querySelector('svg,hr,table')) element.dataset.readerImageBlock = '';
        }
        for (const image of parsed.body.querySelectorAll('img')) {
            if (!image.closest('[data-reader-image-block]') && image.parentElement.matches('body,section,div,a') &&
                ![...image.parentElement.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) {
                image.dataset.readerImageBlock = '';
            }
        }
        signal.throwIfAborted();
        const result = targetDocument.createElement('section');
        result.className = 'epub-chapter';
        result.id = id;
        result.dataset.index = chapterIndex;
        result.dataset.loaded = 'true';
        const style = targetDocument.createElement('style');
        style.textContent = css + '\n' + pagedImageCss;
        result.appendChild(style);
        while (parsed.body.firstChild) result.appendChild(targetDocument.adoptNode(parsed.body.firstChild));
        return result;
    }
    return {
        text, section, assetUrl, layoutReady,
        get sourceVersion() { return index.sourceVersion; },
        async names() {
            if (source) await layoutReady;
            return Object.keys(index.texts).length ? Object.keys(index.texts) : (await archive()).names();
        },
        dispose() {
            disposed = true;
            archivePromise?.then(zip => zip.close()).catch(() => {});
            for (const url of blobs.values()) URL.revokeObjectURL(url);
            blobs.clear();
        }
    };
}

// Deliberately test ranges before handing a PDF to PDF.js. With a plain URL,
// PDF.js can silently fetch the full file when CORS hides range headers.
export async function openRangePdf(url, { signal, onError = console.warn } = {}) {
    async function range(begin, end) {
        const response = await fetch(url, { signal, headers: { Range: `bytes=${begin}-${end - 1}` } });
        if (response.status !== 206) {
            await response.body?.cancel();
            throw new Error('PDF parça indirme desteklenmiyor (HTTP ' + response.status + '). Storage CORS/Range ayarlarını kontrol edin; dosyanın tamamı indirilmedi.');
        }
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        if (!match || Number(match[1]) !== begin || Number(match[2]) !== Math.min(end, Number(match[3])) - 1) {
            await response.body?.cancel();
            throw new Error('PDF Content-Range başlığı okunamıyor veya geçersiz. Storage CORS ayarlarını kontrol edin.');
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== Number(match[2]) - begin + 1) throw new Error('Eksik PDF parçası.');
        return { bytes, length: Number(match[3]) };
    }
    const first = await range(0, 65536);
    signal.throwIfAborted();
    const transport = new pdfjsLib.PDFDataRangeTransport(first.length, first.bytes, true);
    let task;
    transport.requestDataRange = (begin, end) => {
        range(begin, end).then(({ bytes, length }) => {
            if (length !== first.length) throw new Error('PDF indirme sırasında değişti. Kitabı yeniden açın.');
            transport.onDataRange(begin, bytes);
        }).catch(error => {
            onError(error);
            task?.destroy();
        });
    };
    transport.abort = () => {};
    task = pdfjsLib.getDocument({
        range: transport, length: first.length, disableStream: true, disableAutoFetch: true,
        rangeChunkSize: 65536, fontExtraProperties: true,
        cMapUrl: '/libs/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/libs/standard_fonts/', wasmUrl: '/libs/wasm/'
    });
    const abort = () => { void task.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try { return await task.promise; }
    catch (error) { signal.removeEventListener('abort', abort); throw error; }
}

export function hydrateVisibleAssets(resources, root, bounds, onError = console.warn) {
    for (const element of root.querySelectorAll('[data-reader-asset]')) {
        if (element.dataset.assetLoading || element.dataset.assetLoaded || element.dataset.assetFailed) continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
        element.dataset.assetLoading = 'true';
        resources.assetUrl(element.dataset.readerAsset).then(url => {
            if (!element.isConnected) return;
            if (element.localName === 'img') element.src = url;
            else {
                element.setAttribute('href', url);
                element.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
            }
            element.dataset.assetLoaded = 'true';
        }).catch(error => {
            if (!element.isConnected || error.name === 'AbortError') return;
            element.dataset.assetFailed = 'true';
            element.setAttribute('aria-label', 'Görsel yüklenemedi');
            onError(error);
        }).finally(() => { delete element.dataset.assetLoading; });
    }
}
