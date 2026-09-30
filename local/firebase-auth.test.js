'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyFirebaseIdToken, createAuthMiddleware } = require('./firebase-auth');

// Test RSA keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const testCert = publicKey.export({ type: 'pkcs1', format: 'pem' });
const mockCerts = { 'test_key_1': testCert };

function createSignedTestToken(payloadOverrides = {}, headerOverrides = {}, signKey = privateKey) {
    const header = Buffer.from(JSON.stringify({
        alg: 'RS256',
        typ: 'JWT',
        kid: 'test_key_1',
        ...headerOverrides
    })).toString('base64url');

    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
        sub: 'test_user_456',
        email: 'user@example.com',
        aud: 'test-project',
        iss: 'https://securetoken.google.com/test-project',
        exp: now + 3600,
        iat: now,
        auth_time: now,
        ...payloadOverrides
    })).toString('base64url');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(signKey, 'base64url');

    return `${header}.${payload}.${signature}`;
}

test('verifyFirebaseIdToken rejects malformed tokens', async () => {
    await assert.rejects(verifyFirebaseIdToken('not-a-jwt', 'test-project', { certs: mockCerts }), /Geçersiz JWT formatı/);
    await assert.rejects(verifyFirebaseIdToken('', 'test-project', { certs: mockCerts }), /Token bulunamadı/);
});

test('verifyFirebaseIdToken accepts valid signed token and extracts user info', async () => {
    const token = createSignedTestToken({ sub: 'uid_abc_123', email: 'valid@test.com' });
    const user = await verifyFirebaseIdToken(token, 'test-project', { certs: mockCerts });

    assert.equal(user.uid, 'uid_abc_123');
    assert.equal(user.email, 'valid@test.com');
});

test('verifyFirebaseIdToken rejects invalid signature', async () => {
    const otherKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forgedToken = createSignedTestToken({}, {}, otherKeyPair.privateKey);

    await assert.rejects(
        verifyFirebaseIdToken(forgedToken, 'test-project', { certs: mockCerts }),
        /Geçersiz token imzası/
    );
});

test('verifyFirebaseIdToken rejects mismatched aud claim', async () => {
    const token = createSignedTestToken({ aud: 'wrong-project' });

    await assert.rejects(
        verifyFirebaseIdToken(token, 'test-project', { certs: mockCerts }),
        /Token hedef kitlesi \(aud\) geçersiz/
    );
});

test('verifyFirebaseIdToken rejects expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = createSignedTestToken({ exp: now - 100 });

    await assert.rejects(
        verifyFirebaseIdToken(expiredToken, 'test-project', { certs: mockCerts }),
        /Oturum süresi dolmuş/
    );
});

test('createAuthMiddleware rejects requests without authorization header or token', async () => {
    const middleware = createAuthMiddleware({ projectId: 'test-project' });
    let statusCode = null;
    let jsonResponse = null;

    const req = { headers: {} };
    const res = {
        status(code) { statusCode = code; return this; },
        json(body) { jsonResponse = body; return this; }
    };
    let nextCalled = false;

    await middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.match(jsonResponse.error, /Yetkilendirme gerekli/);
});

test('createAuthMiddleware bypasses when DISABLE_AUTH=true', async () => {
    process.env.DISABLE_AUTH = 'true';
    try {
        const middleware = createAuthMiddleware({ projectId: 'test-project' });
        const req = { headers: {} };
        const res = {};
        let nextCalled = false;

        await middleware(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, true);
        assert.equal(req.user.uid, 'default_local_user');
    } finally {
        delete process.env.DISABLE_AUTH;
    }
});
