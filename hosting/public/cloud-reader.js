import { RemoteZip } from './range-archive.js';
import { readLayoutBundle, imageDimensions } from './layout-bundle.js';

export const RESOURCE_BASE = 'https://epub.local/';
const XLINK = 'http://www.w3.org/1999/xlink';

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

// Only the compressed layout index is fetched on open. The original ZIP is opened
// lazily on the first visible image/font request and is always read using Range.
export async function createBookResources(book, { uid, signal }) {
    let index = { texts: Object.create(null), images: Object.create(null) };
    if (book.layoutUrl) {
        const response = await fetch(book.layoutUrl, { signal, cache: 'force-cache' });
        if (!response.ok) throw new Error('Kitabın düzen dosyası indirilemedi (' + response.status + ').');
        index = await readLayoutBundle(await response.arrayBuffer());
        signal.throwIfAborted();
    }
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
            const zip = await archive();
            value = await zip.read(await actualPath(path), 'string', requestSignal);
            index.texts[path] = value;
        }
        requestSignal.throwIfAborted();
        return value;
    }
    async function dimensions(path) {
        if (index.images[path]) return index.images[path];
        // Old uploads have no geometry index. Determine it once from the cached
        // individual entry; new uploads never fetch image bytes for pagination.
        const zip = await archive();
        const bytes = await zip.read(await actualPath(path), 'uint8array', signal);
        const size = imageDimensions(bytes, path);
        if (!size) throw new Error('Görsel ölçüleri bulunamadı. Kitabı yeniden yükleyin: ' + path);
        index.images[path] = size;
        return size;
    }
    async function cssUrls(css, base) {
        // Images used as decoration must not initiate background downloads.
        const matches = [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)];
        for (const match of matches) {
            const raw = match[2];
            if (raw.startsWith('data:') || raw.startsWith('#')) continue;
            const path = pathOf(new URL(raw, base).href);
            const url = path && /\.(woff2?|ttf|otf)$/i.test(path) ? await assetUrl(path) : placeholder({width: 1, height: 1});
            css = css.replaceAll(match[0], `url("${url}")`);
        }
        return css;
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

    function normalizedCss(css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        function serialize(rules) {
            const output = [];
            for (const rule of rules) {
                if (rule.type === CSSRule.PAGE_RULE) continue;
                const style = rule.style;
                if (style) {
                    for (const property of ['color', 'background-color', 'background']) style.removeProperty(property);
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

    function normalizeInlineStyle(style) {
        const size = style.getPropertyValue('font-size');
        if (size) style.setProperty('font-size', normalizeFontSize(size), style.getPropertyPriority('font-size'));
        if (style.getPropertyValue('text-align').trim().toLowerCase() === 'justify') {
            style.setProperty('text-align', 'start', style.getPropertyPriority('text-align'));
        }
    }

    async function cssText(css, base, seen = new Set()) {
        if (seen.has(base)) return '';
        seen = new Set([...seen, base]);
        // Resolve CSS imports ourselves, so the browser cannot fetch entire
        // external books or bypass the resource policy during measurement.
        const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?[^;]*;/gi)];
        for (const match of imports) {
            const url = new URL(match[1], base).href;
            const imported = pathOf(url) === null ? '' : await cssText(await text(url), url, seen);
            css = css.replace(match[0], imported);
        }
        css = css.replace(/@import[^;]*;/gi, '').replace(/@namespace[^;]+;/gi, '');
        return cssUrls(normalizedCss(css), base);
    }
    async function section(html, base, targetDocument, chapterIndex = 0, id = '') {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        let css = '';
        for (const style of parsed.querySelectorAll('style')) {
            css += await cssText(style.textContent, base);
            style.remove();
        }
        for (const link of parsed.querySelectorAll('link[rel="stylesheet"]')) {
            const href = link.getAttribute('href');
            if (href && pathOf(new URL(href, base).href) !== null) {
                const url = new URL(href, base).href;
                css += await cssText(await text(url), url);
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
                element.style.color = element.style.backgroundColor = element.style.background = '';
                normalizeInlineStyle(element.style);
                element.setAttribute('style', await cssUrls(element.style.cssText, base));
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
        signal.throwIfAborted();
        const result = targetDocument.createElement('section');
        result.className = 'epub-chapter';
        result.id = id;
        result.dataset.index = chapterIndex;
        result.dataset.loaded = 'true';
        if (css) {
            const style = targetDocument.createElement('style');
            style.textContent = css;
            result.appendChild(style);
        }
        while (parsed.body.firstChild) result.appendChild(targetDocument.adoptNode(parsed.body.firstChild));
        return result;
    }
    return {
        text, section, assetUrl,
        async names() { return Object.keys(index.texts).length ? Object.keys(index.texts) : (await archive()).names(); },
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
    task = pdfjsLib.getDocument({ range: transport, length: first.length, disableStream: true, disableAutoFetch: true, rangeChunkSize: 65536 });
    const abort = () => { void task.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try { return await task.promise; }
    catch (error) { signal.removeEventListener('abort', abort); throw error; }
}
