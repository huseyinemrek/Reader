'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts = null;
let certsExpiry = 0;
let fetchPromise = null;

/**
 * Google'ın resmi Firebase ID Token doğrulama sertifikalarını çeker ve önbelleğe alır.
 */
async function getGooglePublicCerts() {
    const now = Date.now();
    if (cachedCerts && now < certsExpiry) {
        return cachedCerts;
    }

    if (fetchPromise) {
        return fetchPromise;
    }

    fetchPromise = new Promise((resolve, reject) => {
        https.get(GOOGLE_CERTS_URL, (res) => {
            if (res.statusCode !== 200) {
                fetchPromise = null;
                return reject(new Error(`Google certs endpoint returned HTTP ${res.statusCode}`));
            }

            // Cache-Control başlığını ayrıştır
            let maxAgeSeconds = 3600; // Varsayılan 1 saat
            const cacheControl = res.headers['cache-control'];
            if (cacheControl) {
                const match = cacheControl.match(/max-age=(\d+)/i);
                if (match) {
                    maxAgeSeconds = parseInt(match[1], 10);
                }
            }

            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                fetchPromise = null;
                try {
                    cachedCerts = JSON.parse(body);
                    certsExpiry = Date.now() + (maxAgeSeconds * 1000);
                    resolve(cachedCerts);
                } catch (err) {
                    reject(new Error(`Failed to parse Google certs JSON: ${err.message}`));
                }
            });
        }).on('error', (err) => {
            fetchPromise = null;
            reject(err);
        });
    });

    return fetchPromise;
}

/**
 * Firebase Project ID'yi ortam değişkeninden veya local/firebase-config.js dosyasından güvenle okur.
 */
function resolveProjectId() {
    if (process.env.FIREBASE_PROJECT_ID) {
        return process.env.FIREBASE_PROJECT_ID.trim();
    }
    const configPath = path.join(__dirname, 'firebase-config.js');
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const match = content.match(/projectId\s*:\s*["']([^"']+)["']/);
            if (match) {
                return match[1].trim();
            }
        } catch (_) {}
    }
    return null;
}

/**
 * Firebase ID Token'ı (RS256 JWT) doğrular ve kullanıcı bilgilerini döner.
 */
async function verifyFirebaseIdToken(token, expectedProjectId, options = {}) {
    if (!token || typeof token !== 'string') {
        throw new Error('Token bulunamadı.');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Geçersiz JWT formatı.');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    let header, payload;
    try {
        header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (_) {
        throw new Error('JWT başlık veya yükü çözülemedi.');
    }

    if (header.alg !== 'RS256') {
        throw new Error(`Desteklenmeyen algoritma: ${header.alg}. RS256 bekleniyor.`);
    }

    if (!header.kid) {
        throw new Error('JWT başlığında kid (Key ID) eksik.');
    }

    const certs = options.certs || await getGooglePublicCerts();
    const cert = certs[header.kid];
    if (!cert) {
        throw new Error(`Google sertifikaları arasında bu anahtar kimliği bulunamadı: ${header.kid}`);
    }

    // RS256 imza doğrulaması (Node.js crypto)
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    const signatureBuffer = Buffer.from(signatureB64, 'base64url');
    const isSignatureValid = verifier.verify(cert, signatureBuffer);

    if (!isSignatureValid) {
        throw new Error('Geçersiz token imzası.');
    }

    // Firebase spesifik talep (claim) doğrulamaları
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < nowSeconds) {
        throw new Error('Oturum süresi dolmuş. Lütfen tekrar giriş yapın.');
    }

    if (expectedProjectId) {
        if (payload.aud !== expectedProjectId) {
            throw new Error(`Token hedef kitlesi (aud) geçersiz: ${payload.aud}. Beklenen: ${expectedProjectId}`);
        }
        if (payload.iss !== `https://securetoken.google.com/${expectedProjectId}`) {
            throw new Error(`Token sağlayıcısı (iss) geçersiz: ${payload.iss}`);
        }
    }

    if (!payload.sub || typeof payload.sub !== 'string') {
        throw new Error('Token içinde geçerli bir kullanıcı kimliği (sub/uid) bulunamadı.');
    }

    return {
        uid: payload.sub,
        email: payload.email || null,
        name: payload.name || null,
        picture: payload.picture || null,
        authTime: payload.auth_time || null
    };
}

/**
 * Express middleware: İsteklerdeki Bearer veya ?token değerini doğrular
 */
function createAuthMiddleware(options = {}) {
    return async function requireAuth(req, res, next) {
        const projectId = options.projectId !== undefined ? options.projectId : resolveProjectId();

        // Eğer Firebase projesi yapılandırılmamışsa veya DISABLE_AUTH açıksa:
        // Doğrudan yerel tek kullanıcılı modda çalış (Sıfır pürüz / Out-of-the-box yerel okuyucu)
        if (!projectId || process.env.DISABLE_AUTH === 'true') {
            req.user = { uid: 'local_user', email: 'local@reader.internal' };
            return next();
        }
        let token = null;

        // 1. Authorization: Bearer <token> başlığından oku
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim();
        }

        // 2. Query parametresi olarak da kabul et (örn. iframe veya dosya indirme bağlantıları için)
        if (!token && req.query && typeof req.query.token === 'string') {
            token = req.query.token.trim();
        }

        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli. Lütfen giriş yapın.' });
        }

        try {
            const user = await verifyFirebaseIdToken(token, projectId);
            req.user = user;
            next();
        } catch (error) {
            return res.status(401).json({ error: `Yetkilendirme hatası: ${error.message}` });
        }
    };
}

module.exports = {
    getGooglePublicCerts,
    resolveProjectId,
    verifyFirebaseIdToken,
    createAuthMiddleware
};
