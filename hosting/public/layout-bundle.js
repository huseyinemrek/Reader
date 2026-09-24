// A small companion archive lets pagination read text and image geometry without
// downloading the original book's illustrations. Image bytes stay in the EPUB.
const MAX_ENTRIES = 50000;
const MAX_TEXT_FILE = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 96 * 1024 * 1024;
const TEXT_FILE = /\.(?:x?html?|css|opf|xml|ncx)$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|svg|bmp|ico|avif|heic|heif|tiff?)$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function safePath(path) {
    if (typeof path !== 'string' || !path || path.length > 2048) return false;
    const valid = value => !/^[\\/]|[\\:\u0000-\u001f]/.test(value) &&
        !value.split('/').some(part => part === '..' || part === '.');
    if (!valid(path)) return false;
    try { return valid(decodeURIComponent(path)); } catch { return true; }
}

function geometry(width, height, type) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
        width <= 1000000 && height <= 1000000 ? { width, height, type } : null;
}

function ascii(bytes, offset, length) {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function svgLength(value) {
    const match = String(value || '').trim().match(/^([\d.]+)(px|pt|pc|in|cm|mm)?$/i);
    if (!match) return null;
    return Number(match[1]) * ({ px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[match[2]?.toLowerCase() || 'px']);
}

function svgDimensions(bytes) {
    // SVG geometry lives in the root tag. Do not parse scripts or external entities.
    const head = decoder.decode(bytes.subarray(0, 256 * 1024)).replace(/<!--[\s\S]*?-->/g, '');
    const tag = head.match(/<svg\b[^>]*>/i)?.[0];
    if (!tag) return null;
    const attribute = name => tag.match(new RegExp('(?:\\s)' + name + '\\s*=\\s*(["\x27])([^"\x27]*)\\1', 'i'))?.[2];
    let width = svgLength(attribute('width'));
    let height = svgLength(attribute('height'));
    const box = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
        if (!width && height) width = height * box[2] / box[3];
        if (!height && width) height = width * box[3] / box[2];
        width ||= box[2];
        height ||= box[3];
    }
    // SVG's default replaced-element viewport if no intrinsic dimensions exist.
    return geometry(width || 300, height || 150, 'image/svg+xml');
}

function exifOrientation(bytes, start, end) {
    if (ascii(bytes, start, 6) !== 'Exif\0\0' || start + 14 > end) return 1;
    const base = start + 6;
    const little = ascii(bytes, base, 2) === 'II';
    if (!little && ascii(bytes, base, 2) !== 'MM') return 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(base + 2, little) !== 42) return 1;
    const ifd = base + view.getUint32(base + 4, little);
    if (ifd < base || ifd + 2 > end) return 1;
    const count = Math.min(view.getUint16(ifd, little), 256);
    for (let i = 0; i < count; i++) {
        const pos = ifd + 2 + i * 12;
        if (pos + 12 > end) break;
        if (view.getUint16(pos, little) === 0x0112 && view.getUint16(pos + 2, little) === 3 && view.getUint32(pos + 4, little) === 1) {
            return view.getUint16(pos + 8, little);
        }
    }
    return 1;
}

/** Return intrinsic geometry without decoding pixels, or null for unknown formats. */
export function imageDimensions(input, path = '') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const size = bytes.byteLength;
    const view = new DataView(bytes.buffer, bytes.byteOffset, size);
    if (size >= 24 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n' && ascii(bytes, 12, 4) === 'IHDR') {
        return geometry(view.getUint32(16), view.getUint32(20), 'image/png');
    }
    if (size >= 10 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
        return geometry(view.getUint16(6, true), view.getUint16(8, true), 'image/gif');
    }
    if (size >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
        for (let pos = 12; pos + 8 <= size;) {
            const type = ascii(bytes, pos, 4);
            const length = view.getUint32(pos + 4, true);
            const data = pos + 8;
            if (data + length > size) break;
            const u24 = offset => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
            if (type === 'VP8X' && length >= 10) return geometry(u24(data + 4) + 1, u24(data + 7) + 1, 'image/webp');
            if (type === 'VP8 ' && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 1 && bytes[data + 5] === 0x2a) {
                return geometry(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff, 'image/webp');
            }
            if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
                const bits = view.getUint32(data + 1, true);
                return geometry((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'image/webp');
            }
            pos = data + length + (length & 1);
        }
    }
    if (size >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let width, height, orientation = 1;
        for (let pos = 2; pos + 1 < size;) {
            if (bytes[pos++] !== 0xff) break;
            while (pos < size && bytes[pos] === 0xff) pos++;
            if (pos >= size) break;
            const marker = bytes[pos++];
            if (marker === 0xda || marker === 0xd9) break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
            if (pos + 2 > size) break;
            const length = view.getUint16(pos);
            if (length < 2 || pos + length > size) break;
            if (marker === 0xe1) orientation = exifOrientation(bytes, pos + 2, pos + length);
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
                height = view.getUint16(pos + 3);
                width = view.getUint16(pos + 5);
            }
            pos += length;
        }
        return orientation >= 5 && orientation <= 8 ? geometry(height, width, 'image/jpeg') : geometry(width, height, 'image/jpeg');
    }
    if (size >= 26 && ascii(bytes, 0, 2) === 'BM') {
        const dibSize = view.getUint32(14, true);
        return dibSize === 12 ? geometry(view.getUint16(18, true), view.getUint16(20, true), 'image/bmp') :
            dibSize >= 40 ? geometry(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)), 'image/bmp') : null;
    }
    if (size >= 22 && view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1 && view.getUint16(4, true) > 0) {
        return geometry(bytes[6] || 256, bytes[7] || 256, 'image/x-icon');
    }
    if (/\.svg$/i.test(path) || (size && bytes[0] === 0x3c)) return svgDimensions(bytes);
    return null;
}

function getZip() {
    if (!globalThis.JSZip) throw new Error('Kitap dizini için JSZip yüklenemedi.');
    return globalThis.JSZip;
}

function checkDeclaredSize(entry, limit) {
    const size = entry?._data?.uncompressedSize;
    if (Number.isFinite(size) && (size < 0 || size > limit)) throw new Error('Kitap dizini için dosya boyutu sınırı aşıldı.');
}

/** Build locally at upload time; no book/image download is needed later to paginate. */
export async function buildLayoutBundle(zip, { onProgress } = {}) {
    const allEntries = Object.values(zip.files);
    if (allEntries.length > MAX_ENTRIES) throw new Error('Kitapta çok fazla dosya var.');
    const entries = allEntries.filter(entry => !entry.dir);
    const index = { version: 1, texts: Object.create(null), images: Object.create(null) };
    let textBytes = 0;
    let processed = 0;
    for (const entry of entries) {
        const path = entry.name;
        if (!safePath(path) || (entry.unsafeOriginalName && !safePath(entry.unsafeOriginalName))) {
            throw new Error('Kitapta güvenli olmayan bir dosya yolu var.');
        }
        if (TEXT_FILE.test(path)) {
            checkDeclaredSize(entry, Math.min(MAX_TEXT_FILE, MAX_TEXT_BYTES - textBytes));
            const bytes = await entry.async('uint8array');
            textBytes += bytes.byteLength;
            if (bytes.byteLength > MAX_TEXT_FILE || textBytes > MAX_TEXT_BYTES) throw new Error('Kitabın metin dizini çok büyük.');
            index.texts[path] = decoder.decode(bytes);
        } else if (IMAGE_FILE.test(path)) {
            checkDeclaredSize(entry, MAX_IMAGE_BYTES);
            const bytes = await entry.async('uint8array');
            if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Kitaptaki bir resim çok büyük.');
            let dimensions = imageDimensions(bytes, path);
            if (!dimensions && typeof globalThis.createImageBitmap === 'function') {
                let bitmap;
                try {
                    bitmap = await globalThis.createImageBitmap(new Blob([bytes]));
                    dimensions = geometry(bitmap.width, bitmap.height, 'application/octet-stream');
                } catch { /* Unsupported or broken images cannot contribute intrinsic geometry. */ }
                finally { bitmap?.close(); }
            }
            if (dimensions) index.images[path] = dimensions;
        }
        onProgress?.({ processed: ++processed, total: entries.length, path });
    }
    const manifest = JSON.stringify(index);
    if (encoder.encode(manifest).byteLength > MAX_MANIFEST_BYTES) throw new Error('Kitabın metin dizini çok büyük.');
    const bundle = new (getZip())();
    bundle.file('manifest.json', manifest);
    const blob = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { blob, index };
}

/** Validate a downloaded layout bundle before it is used as a virtual ZIP index. */
export async function readLayoutBundle(buffer) {
    const length = buffer?.byteLength ?? buffer?.size;
    if (!Number.isFinite(length) || length > MAX_MANIFEST_BYTES) throw new Error('Kitap dizininin boyutu geçersiz.');
    const zip = await getZip().loadAsync(buffer);
    const manifest = zip.file('manifest.json');
    if (!manifest) throw new Error('Kitap dizini eksik.');
    checkDeclaredSize(manifest, MAX_MANIFEST_BYTES);
    const data = await manifest.async('uint8array');
    if (data.byteLength > MAX_MANIFEST_BYTES) throw new Error('Kitap dizini çok büyük.');
    const raw = JSON.parse(decoder.decode(data));
    const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
    if (raw.version !== 1 || !isRecord(raw.texts) || !isRecord(raw.images)) throw new Error('Kitap dizininin biçimi geçersiz.');
    const texts = Object.entries(raw.texts);
    const images = Object.entries(raw.images);
    if (texts.length + images.length > MAX_ENTRIES) throw new Error('Kitap dizininde çok fazla dosya var.');
    const index = { version: 1, texts: Object.create(null), images: Object.create(null) };
    let textBytes = 0;
    for (const [path, value] of texts) {
        if (!safePath(path) || !TEXT_FILE.test(path) || typeof value !== 'string') throw new Error('Kitap dizininde geçersiz metin kaydı var.');
        const bytes = encoder.encode(value).byteLength;
        textBytes += bytes;
        if (bytes > MAX_TEXT_FILE || textBytes > MAX_TEXT_BYTES) throw new Error('Kitabın metin dizini çok büyük.');
        index.texts[path] = value;
    }
    for (const [path, value] of images) {
        if (!safePath(path) || !isRecord(value) || typeof value.type !== 'string' || value.type.length > 100 ||
            !geometry(value.width, value.height, value.type)) throw new Error('Kitap dizininde geçersiz resim kaydı var.');
        index.images[path] = { width: value.width, height: value.height, type: value.type };
    }
    return index;
}
