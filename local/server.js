try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Yükleme klasörleri
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const COVERS_DIR = path.join(__dirname, 'uploads', 'covers');
const DB_FILE = path.join(__dirname, 'library.json');

// Klasörleri oluştur
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

// Veritabanını yükle
let library = [];
if (fs.existsSync(DB_FILE)) {
    try {
        library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch(e) {
        library = [];
    }
} else {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(library, null, 2));
}

// Multer ayarları (Dosyaları hafızaya alıp sonra diske yazacağız çünkü kapak resmini ayrı alıyoruz)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Statik dosyaları sun (Frontend)
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

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

function getEpubEntryMimeType(entryName) {
    const extension = path.posix.extname(entryName).toLowerCase();
    return EPUB_ENTRY_MIME_TYPES[extension] || 'application/octet-stream';
}

function serveEpubEntry(req, res) {
    const book = library.find(item => item.id === req.params.id);
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
app.get('/api/books/:id/epub', serveEpubEntry);
app.get('/api/books/:id/epub/*', serveEpubEntry);
// API: Tüm kitapları getir

app.get('/api/books', (req, res) => {
    res.json(library);
});

// API: Yeni kitap yükle
app.post('/api/books', upload.fields([{ name: 'bookFile', maxCount: 1 }, { name: 'coverBlob', maxCount: 1 }]), (req, res) => {
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

        res.json({ success: true, book: newBook });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Yükleme sırasında hata oluştu." });
    }
});

// API: Okuma ilerlemesini güncelle
app.put('/api/books/:id/progress', (req, res) => {
    const { id } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const book = library.find(b => b.id === id);

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
app.delete('/api/books/:id', (req, res) => {
    const { id } = req.params;
    const bookIndex = library.findIndex(b => b.id === id);

    if (bookIndex !== -1) {
        const book = library[bookIndex];
        
        // Dosyaları sil
        try {
            if (book.bookUrl) fs.unlinkSync(path.join(__dirname, book.bookUrl));
            if (book.coverUrl) fs.unlinkSync(path.join(__dirname, book.coverUrl));
        } catch(e) { console.warn("Dosya silinemedi:", e.message); }

        library.splice(bookIndex, 1);
        saveDB();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Kitap bulunamadı." });
    }
});
// API kitap yolları hiçbir zaman istemci uygulaması geri dönüşüne düşmez
app.get('/api/books/:id/*', (req, res) => {
    res.status(404).json({ error: "API yolu bulunamadı." });
});

// HTML5 History API fallback - client-side routing için index.html döndür
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIP();
    console.log(`\n=================================================`);
    console.log(`📚 Premium Edge Reader Sunucusu Çalışıyor!`);
    console.log(`=================================================`);
    console.log(`👉 Bilgisayarınızdan erişmek için: http://localhost:${PORT}`);
    console.log(`👉 Telefonunuzdan erişmek için   : http://${localIp}:${PORT}`);
    console.log(`=================================================\n`);
});
