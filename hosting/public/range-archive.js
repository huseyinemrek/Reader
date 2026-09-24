/* Read remote EPUB/ZIP members without downloading the whole archive.
 * JSZip must be loaded before reading DEFLATE entries. cacheKey, when supplied,
 * must identify the signed-in user AND an immutable book version.
 */
const TAIL_BYTES = 22 + 65535;
const MEMORY_LIMIT = 16 * 1024 * 1024;
const CACHE_LIMIT = 64 * 1024 * 1024;
const CACHE_ITEMS = 128;
const MAX_DIRECTORY = 16 * 1024 * 1024;
const MAX_ENTRY = 128 * 1024 * 1024;
const CACHE_NAME = 'edge-reader-ranges-v1';
let cacheWrites = Promise.resolve();

function abortError() { return new DOMException('Kitap isteği iptal edildi.', 'AbortError'); }
function checkSignal(signal) { if (signal?.aborted) throw signal.reason || abortError(); }
function invalid(message) { return new Error(`ZIP arşivi okunamadı: ${message}`); }
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

// Each caller can cancel independently. The underlying request is cancelled once
// every subscriber leaves, or when the archive itself closes.
function shared(jobs, key, loader, signal) {
    checkSignal(signal);
    let job = jobs.get(key);
    if (!job) {
        job = { controller: new AbortController(), subscribers: 0, settled: false };
        jobs.set(key, job);
        job.promise = Promise.resolve().then(() => loader(job.controller.signal)).finally(() => {
            job.settled = true;
            if (jobs.get(key) === job) jobs.delete(key);
        });
    }
    job.subscribers++;
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (callback, value) => {
            if (finished) return;
            finished = true;
            signal?.removeEventListener('abort', onAbort);
            job.subscribers--;
            if (!job.subscribers && !job.settled) {
                if (jobs.get(key) === job) jobs.delete(key);
                job.controller.abort();
            }
            callback(value);
        };
        const onAbort = () => finish(reject, signal.reason || abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        job.promise.then(value => finish(resolve, value), error => finish(reject, error));
        if (signal?.aborted) onAbort();
    });
}

export class RemoteZip {
    static async open(url, { signal, cacheKey } = {}) {
        checkSignal(signal);
        const archive = new RemoteZip(url, signal);
        try {
            if (cacheKey && globalThis.caches && globalThis.crypto?.subtle) {
                try {
                    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${cacheKey}\n${url}`));
                    const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
                    archive.cachePrefix = `${globalThis.location?.origin || 'https://edge-reader.invalid'}/__reader_ranges__/${hash}/`;
                    archive.cache = await caches.open(CACHE_NAME);
                } catch { /* Cache availability must not affect reading. */ }
            }
            await archive._initialize();
            return archive;
        } catch (error) {
            archive.close();
            throw error;
        }
    }

    constructor(url, signal) {
        this.url = String(url);
        this.entries = new Map();
        this.memory = new Map();
        this.memoryBytes = 0;
        this.rangeJobs = new Map();
        this.entryJobs = new Map();
        this.controller = new AbortController();
        this.parentSignal = signal;
        this.onParentAbort = () => this.close();
        signal?.addEventListener('abort', this.onParentAbort, { once: true });
        this.closed = false;
    }

    has(path) { return this.entries.has(path); }
    names() { return Array.from(this.entries.keys()); }

    async read(path, type = 'string', signal) {
        this._check(signal);
        if (!['string', 'blob', 'uint8array'].includes(type)) throw new TypeError(`Desteklenmeyen ZIP çıktı türü: ${type}`);
        const entry = this.entries.get(path);
        if (!entry || path.endsWith('/')) throw invalid(`Dosya bulunamadı: ${path}`);
        const memoryKey = `entry:${path}`;
        let bytes = this._remembered(memoryKey);
        if (!bytes) {
            bytes = await shared(this.entryJobs, path, async requestSignal => {
                const decoded = await this._readEntry(entry, requestSignal);
                this._check(requestSignal);
                this._remember(memoryKey, decoded);
                return decoded;
            }, signal);
        }
        this._check(signal);
        if (type === 'string') return new TextDecoder().decode(bytes);
        if (type === 'blob') return new Blob([bytes]);
        return bytes.slice();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.parentSignal?.removeEventListener('abort', this.onParentAbort);
        this.controller.abort();
        for (const job of [...this.rangeJobs.values(), ...this.entryJobs.values()]) job.controller.abort();
        this.rangeJobs.clear();
        this.entryJobs.clear();
        this.memory.clear();
        this.memoryBytes = 0;
    }

    _check(signal) {
        if (this.closed) throw abortError();
        checkSignal(this.controller.signal);
        checkSignal(signal);
    }

    _remembered(key) {
        const value = this.memory.get(key);
        if (value) { this.memory.delete(key); this.memory.set(key, value); }
        return value;
    }

    _remember(key, value) {
        if (this.closed || value.byteLength > MEMORY_LIMIT) return;
        const previous = this.memory.get(key);
        if (previous) { this.memoryBytes -= previous.byteLength; this.memory.delete(key); }
        while (this.memoryBytes + value.byteLength > MEMORY_LIMIT) {
            const oldest = this.memory.keys().next().value;
            this.memoryBytes -= this.memory.get(oldest).byteLength;
            this.memory.delete(oldest);
        }
        this.memory.set(key, value);
        this.memoryBytes += value.byteLength;
    }

    async _initialize() {
        const tail = await this._range(null, TAIL_BYTES, this.controller.signal);
        const data = view(tail.bytes);
        let endOffset = -1;
        for (let i = tail.bytes.length - 22; i >= 0; i--) {
            if (data.getUint32(i, true) === 0x06054b50 && i + 22 + data.getUint16(i + 20, true) === tail.bytes.length) {
                endOffset = i;
                break;
            }
        }
        if (endOffset < 0) throw invalid('ZIP son dizin kaydı bulunamadı.');
        const disk = data.getUint16(endOffset + 4, true);
        const centralDisk = data.getUint16(endOffset + 6, true);
        const diskEntries = data.getUint16(endOffset + 8, true);
        const count = data.getUint16(endOffset + 10, true);
        const directorySize = data.getUint32(endOffset + 12, true);
        const directoryOffset = data.getUint32(endOffset + 16, true);
        const absoluteEnd = tail.start + endOffset;
        if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
            (endOffset >= 20 && data.getUint32(endOffset - 20, true) === 0x07064b50)) {
            throw invalid('ZIP64 kitapları henüz desteklenmiyor.');
        }
        if (disk || centralDisk || diskEntries !== count) throw invalid('Çok parçalı ZIP desteklenmiyor.');
        if (directorySize > MAX_DIRECTORY || directoryOffset + directorySize > absoluteEnd || count * 46 > directorySize) {
            throw invalid('Merkez dizin sınırları geçersiz veya dizin çok büyük.');
        }
        this.size = tail.total;
        this.directoryOffset = directoryOffset;
        if (!count) {
            if (directorySize) throw invalid('Boş arşivin merkez dizini geçersiz.');
            return;
        }
        const directory = directoryOffset >= tail.start
            ? tail.bytes.subarray(directoryOffset - tail.start, directoryOffset - tail.start + directorySize)
            : (await this._range(directoryOffset, directoryOffset + directorySize - 1, this.controller.signal)).bytes;
        const central = view(directory);
        let offset = 0;
        for (let i = 0; i < count; i++) {
            if (offset + 46 > directory.length || central.getUint32(offset, true) !== 0x02014b50) throw invalid('Merkez dizin kaydı eksik veya bozuk.');
            const nameLength = central.getUint16(offset + 28, true);
            const extraLength = central.getUint16(offset + 30, true);
            const commentLength = central.getUint16(offset + 32, true);
            const recordLength = 46 + nameLength + extraLength + commentLength;
            if (!nameLength || offset + recordLength > directory.length) throw invalid('Merkez dizin dosya adı sınırları geçersiz.');
            const name = new TextDecoder().decode(directory.subarray(offset + 46, offset + 46 + nameLength));
            const entry = {
                name, flags: central.getUint16(offset + 8, true), method: central.getUint16(offset + 10, true),
                crc: central.getUint32(offset + 16, true), compressed: central.getUint32(offset + 20, true),
                size: central.getUint32(offset + 24, true), offset: central.getUint32(offset + 42, true)
            };
            if (entry.compressed === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw invalid('ZIP64 kitapları henüz desteklenmiyor.');
            if (central.getUint16(offset + 34, true)) throw invalid('Çok parçalı ZIP desteklenmiyor.');
            if (entry.offset + 30 + entry.compressed > directoryOffset || name.includes('\0') || this.entries.has(name)) throw invalid('Dosya kaydı sınırları veya adı geçersiz.');
            this.entries.set(name, entry);
            offset += recordLength;
        }
        if (offset !== directory.length) throw invalid('Merkez dizin boyutu kayıtlarla uyuşmuyor.');
    }

    async _readEntry(entry, signal) {
        this._check(signal);
        if (entry.flags & 0x41) throw invalid('Şifreli ZIP dosyaları desteklenmiyor.');
        if (![0, 8].includes(entry.method)) throw invalid(`Sıkıştırma yöntemi desteklenmiyor: ${entry.method}`);
        if (entry.size > MAX_ENTRY || entry.compressed > MAX_ENTRY) throw invalid('Tek bir kitap bölümü veya görseli 128 MiB sınırını aşıyor.');
        const header = view((await this._range(entry.offset, entry.offset + 29, signal)).bytes);
        if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(8, true) !== entry.method || header.getUint16(6, true) !== entry.flags) throw invalid('Yerel dosya başlığı merkez dizinle uyuşmuyor.');
        const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        if (start + entry.compressed > this.directoryOffset) throw invalid('Dosya içeriği arşiv sınırlarını aşıyor.');
        const compressed = entry.compressed ? (await this._range(start, start + entry.compressed - 1, signal)).bytes : new Uint8Array();
        this._check(signal);
        if (!globalThis.JSZip) throw new Error('Kitap açmak için JSZip yüklenemedi.');
        // Wrap the original compressed bytes in a tiny, valid single-member ZIP.
        // JSZip handles raw DEFLATE and verifies the original CRC and size.
        const packed = new Uint8Array(100 + compressed.length);
        const output = view(packed);
        output.setUint32(0, 0x04034b50, true);
        output.setUint16(4, 20, true);
        output.setUint16(8, entry.method, true);
        output.setUint32(14, entry.crc, true);
        output.setUint32(18, entry.compressed, true);
        output.setUint32(22, entry.size, true);
        output.setUint16(26, 1, true);
        packed[30] = 120; // "x"
        packed.set(compressed, 31);
        const directory = 31 + compressed.length;
        output.setUint32(directory, 0x02014b50, true);
        output.setUint16(directory + 4, 20, true);
        output.setUint16(directory + 6, 20, true);
        output.setUint16(directory + 10, entry.method, true);
        output.setUint32(directory + 16, entry.crc, true);
        output.setUint32(directory + 20, entry.compressed, true);
        output.setUint32(directory + 24, entry.size, true);
        output.setUint16(directory + 28, 1, true);
        packed[directory + 46] = 120;
        const end = directory + 47;
        output.setUint32(end, 0x06054b50, true);
        output.setUint16(end + 8, 1, true);
        output.setUint16(end + 10, 1, true);
        output.setUint32(end + 12, 47, true);
        output.setUint32(end + 16, directory, true);
        const zip = await globalThis.JSZip.loadAsync(packed, { checkCRC32: true });
        this._check(signal);
        const bytes = await zip.file('x').async('uint8array');
        if (bytes.length !== entry.size) throw invalid('Açılan dosyanın boyutu beklenen boyutla uyuşmuyor.');
        return bytes;
    }

    _range(start, end, signal) {
        this._check(signal);
        const range = start === null ? `bytes=-${end}` : `bytes=${start}-${end}`;
        const remembered = this._remembered(`range:${range}`);
        if (remembered) return Promise.resolve({ bytes: remembered, start, total: this.size });
        return shared(this.rangeJobs, range, async requestSignal => {
            this._check(requestSignal);
            const cacheUrl = this.cachePrefix && `${this.cachePrefix}${encodeURIComponent(range)}`;
            if (cacheUrl && this.cache) {
                try {
                    const cached = await this.cache.match(cacheUrl);
                    if (cached?.headers.get('X-Reader-Range') === '1') {
                        const result = await this._responseBytes(new Response(cached.body, { status: 206, headers: cached.headers }), start, end, requestSignal);
                        this._check(requestSignal);
                        if (this.size !== undefined && result.total !== this.size) throw invalid('Önbellekteki kitap boyutu uyuşmuyor.');
                        if (start !== null) this._remember(`range:${range}`, result.bytes);
                        return result;
                    }
                } catch (error) { this._check(requestSignal); /* Ignore corrupt/unavailable cache. */ }
            }
            const controller = new AbortController();
            const abort = () => controller.abort();
            requestSignal.addEventListener('abort', abort, { once: true });
            this.controller.signal.addEventListener('abort', abort, { once: true });
            try {
                this._check(requestSignal);
                const response = await fetch(this.url, {
                    headers: { Range: range }, signal: controller.signal, mode: 'cors', credentials: 'omit', cache: 'no-store'
                });
                const result = await this._responseBytes(response, start, end, requestSignal);
                this._check(requestSignal);
                if (this.size !== undefined && result.total !== this.size) throw invalid('Kitap dosyası okuma sırasında değişti; kitabı yeniden açın.');
                if (start !== null) this._remember(`range:${range}`, result.bytes);
                if (cacheUrl && this.cache) this._cacheRange(cacheUrl, result);
                return result;
            } finally {
                requestSignal.removeEventListener('abort', abort);
                this.controller.signal.removeEventListener('abort', abort);
            }
        }, signal);
    }

    async _responseBytes(response, start, end, signal) {
        const rejectResponse = async message => {
            try { await response.body?.cancel(); } catch { /* Already closed. */ }
            throw new Error(message);
        };
        if (response.status !== 206) {
            if (response.status === 200) return rejectResponse('Sunucu parçalı indirmeyi (HTTP Range) desteklemiyor. Tüm kitap indirilmedi. Storage Range/CORS ayarlarını kontrol edin.');
            return rejectResponse(`Kitap parçası indirilemedi (HTTP ${response.status}). Storage erişimini ve kotasını kontrol edin.`);
        }
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        if (!match) return rejectResponse('Parçalı kitap yanıtında Content-Range okunamıyor. Storage CORS ayarında Content-Range başlığını dışa açın.');
        const [actualStart, actualEnd, total] = match.slice(1).map(Number);
        const expectedStart = start === null ? Math.max(0, total - end) : start;
        const expectedEnd = start === null ? total - 1 : end;
        if (![actualStart, actualEnd, total].every(Number.isSafeInteger) || total < 22 || actualStart !== expectedStart || actualEnd !== expectedEnd || actualEnd < actualStart || actualEnd >= total) {
            return rejectResponse('Sunucunun Content-Range sınırları istenen kitap parçasıyla uyuşmuyor.');
        }
        const expectedLength = actualEnd - actualStart + 1;
        if (expectedLength > MAX_ENTRY) return rejectResponse('İstenen kitap parçası boyut sınırını aşıyor.');
        const bytes = new Uint8Array(expectedLength);
        const reader = response.body?.getReader();
        if (!reader) return rejectResponse('Sunucu kitap parçasını boş döndürdü.');
        let offset = 0;
        try {
            while (true) {
                this._check(signal);
                const part = await reader.read();
                if (part.done) break;
                if (offset + part.value.length > expectedLength) throw invalid('Sunucu istenenden fazla veri gönderdi.');
                bytes.set(part.value, offset);
                offset += part.value.length;
            }
            if (offset !== expectedLength) throw invalid('İndirilen kitap parçası eksik.');
        } catch (error) {
            try { await reader.cancel(); } catch { /* Preserve original error. */ }
            throw error;
        } finally { reader.releaseLock(); }
        return { bytes, start: actualStart, total };
    }

    _cacheRange(url, result) {
        const cache = this.cache;
        // Cache API rejects status 206 on put; store bytes as a complete cached
        // object and restore status 206 when reading its range metadata.
        cacheWrites = cacheWrites.catch(() => {}).then(async () => {
            const requests = await cache.keys();
            let size = result.bytes.length;
            const previous = [];
            for (const request of requests) {
                if (request.url === url) continue;
                const response = await cache.match(request);
                const length = Number(response?.headers.get('Content-Length')) || 0;
                size += length;
                previous.push({ request, length });
            }
            while (previous.length && (size > CACHE_LIMIT || previous.length >= CACHE_ITEMS)) {
                const oldest = previous.shift();
                await cache.delete(oldest.request);
                size -= oldest.length;
            }
            if (result.bytes.length <= CACHE_LIMIT) {
                await cache.put(url, new Response(result.bytes, { headers: {
                    'Content-Length': String(result.bytes.length),
                    'Content-Range': `bytes ${result.start}-${result.start + result.bytes.length - 1}/${result.total}`,
                    'X-Reader-Range': '1'
                } }));
            }
        }).catch(() => {});
    }
}
