'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const requireLocal = createRequire(path.join(root, 'local/package.json'));
const projectId = 'demo-reader-regression';

async function port() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const result = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return result;
}

async function stopProcess(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    if (process.platform === 'win32') {
        // firebase-tools owns Java children. Killing just its Node parent leaks
        // emulators, ports and runtime files on Windows.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        await once(killer, 'exit');
    } else {
        process.kill(-child.pid, 'SIGTERM');
    }
    const force = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 5000);
    try { await exited; } finally { clearTimeout(force); }
}

async function startHosting(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-firebase-regression-'));
    let child;
    let proxy;
    t.after(async () => {
        try {
            if (proxy) {
                const closed = new Promise(resolve => proxy.close(resolve));
                proxy.closeAllConnections();
                await closed;
            }
        } finally {
            try { await stopProcess(child); }
            finally { await fs.rm(directory, { recursive: true, force: true }); }
        }
    });
    const ports = {};
    for (const name of ['hosting', 'auth', 'firestore', 'storage', 'hub', 'logging']) {
        let selected;
        do { selected = await port(); } while (Object.values(ports).includes(selected));
        ports[name] = selected;
    }
    await fs.cp(path.join(root, 'hosting/public'), path.join(directory, 'public'), { recursive: true });
    await Promise.all(['firestore.rules', 'storage.rules'].map(file =>
        fs.copyFile(path.join(root, 'hosting', file), path.join(directory, file))));
    const production = JSON.parse(await fs.readFile(path.join(root, 'hosting/firebase.json'), 'utf8'));
    const config = {
        hosting: { ...production.hosting, public: 'public' },
        firestore: { rules: 'firestore.rules' },
        storage: { rules: 'storage.rules' },
        emulators: {
            ...Object.fromEntries(Object.entries(ports).map(([name, value]) => [name, { host: '127.0.0.1', port: value }])),
            ui: { enabled: false }, singleProjectMode: true
        }
    };
    const configFile = path.join(directory, 'firebase.json');
    await fs.writeFile(configFile, JSON.stringify(config));
    const javaHome = process.env.READER_TEST_JAVA_HOME || process.env.JAVA_HOME;
    const env = { ...process.env, CI: 'true', GCLOUD_PROJECT: projectId, GOOGLE_CLOUD_PROJECT: projectId };
    // Never inherit production credentials into an isolated demo-project run.
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.FIREBASE_TOKEN;
    if (javaHome) {
        env.JAVA_HOME = javaHome;
        const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
        env[key] = path.join(javaHome, 'bin') + path.delimiter + (env[key] || '');
    }
    child = spawn(process.execPath, [requireLocal.resolve('firebase-tools/lib/bin/firebase.js'),
        'emulators:start', '--only', 'auth,firestore,storage,hosting', '--project', projectId,
        '--config', configFile, '--non-interactive'], {
        cwd: directory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    let spawnError;
    child.on('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Firebase emulators exited:\n' + logs);
        try {
            const response = await fetch(`http://127.0.0.1:${ports.hub}/emulators`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                const running = await response.json();
                if (['auth', 'firestore', 'storage', 'hosting'].every(name => running[name])) {
                    const publicResponse = await fetch(`http://127.0.0.1:${ports.hosting}/`);
                    if (publicResponse.ok) {
                        // The official Storage emulator does not expose Content-Range
                        // through CORS. Share one origin without changing any bytes,
                        // Range requests, response status, or upstream headers.
                        proxy = http.createServer((request, response) => {
                            const target = request.url.startsWith('/v0/') ? ports.storage : ports.hosting;
                            const upstream = http.request({
                                host: '127.0.0.1', port: target, method: request.method,
                                path: request.url, headers: { ...request.headers, host: `127.0.0.1:${target}` }
                            }, incoming => {
                                response.writeHead(incoming.statusCode, incoming.headers);
                                incoming.pipe(response);
                            });
                            upstream.on('error', error => {
                                if (response.headersSent) response.destroy(error);
                                else { response.writeHead(502); response.end('Emulator upstream unavailable'); }
                            });
                            request.on('aborted', () => upstream.destroy());
                            response.on('close', () => upstream.destroy());
                            request.pipe(upstream);
                        });
                        proxy.listen(0, '127.0.0.1');
                        await once(proxy, 'listening');
                        return { base: `http://127.0.0.1:${proxy.address().port}`, ports };
                    }
                }
            }
        } catch { /* Startup is finite; retain emulator logs for the final failure. */ }
        await delay(100);
    }
    throw new Error('Official Firebase emulators did not become ready. Java 21+ and emulator downloads are required:\n' + logs);
}

async function configureHosting(page, runtime) {
    const configSource = `
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js';
const app = initializeApp({apiKey:'demo-reader-api-key',authDomain:'${projectId}.firebaseapp.com',projectId:'${projectId}',storageBucket:'${projectId}.appspot.com',appId:'demo-reader-app'});
const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:${runtime.ports.auth}', {disableWarnings:true});
const db = getFirestore(app); connectFirestoreEmulator(db,'127.0.0.1',${runtime.ports.firestore});
const storage = getStorage(app); connectStorageEmulator(storage,'127.0.0.1',${Number(new URL(runtime.base).port)});
export { app,auth,db,storage };`;
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === runtime.base && url.pathname === '/firebase-config.js') {
            void request.respond({ status: 200, contentType: 'text/javascript', body: configSource });
        } else if (/^(?:identitytoolkit|securetoken|firestore|firebasestorage)\.googleapis\.com$/.test(url.hostname) || /(?:^|\.)firebaseio\.com$/.test(url.hostname)) {
            // A broken emulator connection is a failing test, never live traffic.
            void request.abort('blockedbyclient');
        } else {
            void request.continue();
        }
    });
}

async function seedHosting(page, runtime, epub) {
    await page.goto(runtime.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof JSZip === 'function');
    const fixtures = [];
    for (const [id, name] of [['book_test_typography', 'typography-outline.pdf'], ['book_test_no_outline', 'without-outline.pdf']]) {
        fixtures.push({ id, name, bytes: (await fs.readFile(path.join(root, 'tests/fixtures', name))).toString('base64') });
    }
    fixtures.push({ id: 'book_test_epub', name: path.basename(epub.file), title: epub.title, bytes: epub.bytes.toString('base64') });
    await page.evaluate(async fixtures => {
        const { auth, db, storage } = await import('/firebase-config.js');
        const { createUserWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js');
        const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
        const { ref, uploadBytes, getDownloadURL } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js');
        const { buildLayoutBundle } = await import('/layout-bundle.js');
        const { user } = await createUserWithEmailAndPassword(auth, 'reader-regression@example.test', 'isolated-regression-password');
        for (const fixture of fixtures) {
            const bytes = Uint8Array.from(atob(fixture.bytes), char => char.charCodeAt(0));
            const storagePath = `users/${user.uid}/books/${fixture.id}_${fixture.name}`;
            const bookRef = ref(storage, storagePath);
            await uploadBytes(bookRef, bytes, { contentType: fixture.name.endsWith('.pdf') ? 'application/pdf' : 'application/epub+zip' });
            let layoutUrl = null, layoutStoragePath = null;
            if (fixture.name.endsWith('.epub')) {
                const zip = await JSZip.loadAsync(bytes);
                const { blob } = await buildLayoutBundle(zip);
                layoutStoragePath = `users/${user.uid}/layouts/${fixture.id}.zip`;
                const layoutRef = ref(storage, layoutStoragePath);
                await uploadBytes(layoutRef, blob);
                layoutUrl = await getDownloadURL(layoutRef);
            }
            await setDoc(doc(db, 'users', user.uid, 'library', fixture.id), {
                id: fixture.id, title: fixture.title || fixture.name, fileName: fixture.id + '_' + fixture.name,
                bookUrl: await getDownloadURL(bookRef), storagePath, layoutUrl, layoutStoragePath,
                coverUrl: null, addedAt: Date.now(), progress: 0,
                toc: [{ title: 'Stale library bookmark', link: '#unrelated' }]
            });
        }
    }, fixtures);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 3, { timeout: 30000 });
}

async function hostingLibrary(page) {
    return page.evaluate(async () => {
        const { auth, db } = await import('/firebase-config.js');
        const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
        assertLoopback();
        function assertLoopback() { if (location.hostname !== '127.0.0.1') throw new Error('Fixture SDK access requires loopback'); }
        return (await getDocs(collection(db, 'users', auth.currentUser.uid, 'library'))).docs.map(doc => doc.data());
    });
}

module.exports = { startHosting, configureHosting, seedHosting, hostingLibrary };
