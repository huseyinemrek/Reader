'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const PYTHON = path.join(__dirname, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const WORKER = path.join(__dirname, 'document-ocr-worker.py');
const MAX_QUEUED = 8;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function createDocumentOcr() {
    let child;
    let pending;
    let serial = Promise.resolve();
    let queued = 0;
    let nextId = 1;
    let stopped = false;
    let stderr = '';

    function start() {
        if (child) return;
        if (!fs.existsSync(PYTHON)) {
            throw new Error('Document OCR is not installed. Run npm run ocr:setup (CUDA GPU or OCR_DEVICE=cpu).');
        }
        stderr = '';
        const processChild = spawn(PYTHON, ['-u', WORKER], {
            cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        child = processChild;
        const lines = readline.createInterface({ input: processChild.stdout });
        processChild.stderr.on('data', chunk => {
            const text = chunk.toString();
            stderr = (stderr + text).slice(-8192);
            process.stderr.write(text);
        });
        lines.on('line', line => {
            if (child !== processChild) return;
            try {
                const response = JSON.parse(line);
                if (!pending || response.id !== pending.id) throw new Error('Unexpected document OCR worker response.');
                const active = pending;
                pending = undefined;
                clearTimeout(active.timer);
                if (response.error) active.reject(new Error(response.error));
                else active.resolve(response.result);
            } catch (error) {
                if (pending) {
                    clearTimeout(pending.timer);
                    pending.reject(error);
                    pending = undefined;
                }
                processChild.kill();
            }
        });
        function failed(error) {
            lines.close();
            if (child !== processChild) return;
            child = undefined;
            if (pending) {
                clearTimeout(pending.timer);
                pending.reject(error);
                pending = undefined;
            }
        }
        processChild.on('error', failed);
        processChild.on('exit', (code, signal) => failed(new Error(`Document OCR worker exited (${signal || code}). ${stderr.trim()}`)));
        // Broken pipes are reported through the in-flight request, never as uncaught events.
        processChild.stdin.on('error', failed);
    }

    function transaction(work) {
        if (stopped) return Promise.reject(new Error('Document OCR has shut down.'));
        if (queued >= MAX_QUEUED) return Promise.reject(new Error('Document OCR queue is full.'));
        queued++;
        const job = serial.then(() => {
            if (stopped) throw new Error('Document OCR has shut down.');
            return work();
        });
        serial = job.catch(() => {}).finally(() => { queued--; });
        return job;
    }

    function request(op, payload = {}) {
        if (stopped) return Promise.reject(new Error('Document OCR has shut down.'));
        start();
        return new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                if (!pending || pending.id !== id) return;
                pending = undefined;
                reject(new Error('Document OCR timed out; its worker was stopped.'));
                child?.kill();
            }, REQUEST_TIMEOUT_MS);
            pending = { id, resolve, reject, timer };
            child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
        });
    }

    function imagePayload({ imageBuffer, width, height }) {
        if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length || imageBuffer.length > MAX_IMAGE_BYTES) {
            throw new Error('Document OCR requires a PNG buffer no larger than 32 MiB.');
        }
        if ((width !== undefined && (!Number.isInteger(width) || width <= 0)) ||
            (height !== undefined && (!Number.isInteger(height) || height <= 0))) {
            throw new Error('Document OCR source dimensions must be positive integers.');
        }
        return { image: imageBuffer.toString('base64'), ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
    }

    async function recognizePage(input) {
        if (input.width === undefined || input.height === undefined) throw new Error('Page OCR requires source width and height.');
        const payload = imagePayload(input);
        if (input.renderRegion !== undefined && typeof input.renderRegion !== 'function') {
            throw new Error('Document OCR renderRegion must be a function.');
        }
        return transaction(async () => {
            const started = Date.now();
            const plan = await request('layout', payload);
            const images = [];
            if (input.renderRegion) {
                // Rendering and both RPCs occupy one queue slot: another page cannot replace this plan.
                for (const window of plan.windows) {
                    const imageBuffer = await input.renderRegion(window);
                    images.push({ id: window.id, ...imagePayload({ imageBuffer }) });
                }
            }
            const result = await request('regions', { planId: plan.planId, images });
            result.elapsedMs = Date.now() - started;
            return result;
        });
    }

    async function recognizeFormula(input) {
        const payload = imagePayload(input);
        return transaction(() => request('formula', payload));
    }

    async function shutdown() {
        if (stopped) return;
        stopped = true;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Document OCR has shut down.'));
            pending = undefined;
        }
        if (child) {
            const processChild = child;
            child = undefined;
            await new Promise(resolve => {
                if (processChild.exitCode !== null || processChild.signalCode !== null) return resolve();
                processChild.once('exit', resolve);
                processChild.kill();
            });
        }
        await serial;
    }

    return { recognizePage, recognizeFormula, prepare: () => transaction(() => request('prepare')), shutdown };
}

async function run(command, args) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: __dirname, windowsHide: true, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)));
    });
}

async function setup() {
    await run('uv', ['venv', '--python', '3.12.14', '--allow-existing', path.join(__dirname, '.venv-ocr')]);
    await run('uv', ['pip', 'install', '--python', PYTHON, '--index-url', 'https://download.pytorch.org/whl/cu128', '-r', path.join(__dirname, 'document-ocr-cuda-requirements.txt')]);
    await run('uv', ['pip', 'install', '--python', PYTHON, '-r', path.join(__dirname, 'document-ocr-requirements.txt')]);
    const runtime = createDocumentOcr();
    try {
        console.log(JSON.stringify(await runtime.prepare(), null, 2));
    } finally {
        await runtime.shutdown();
    }
}

module.exports = createDocumentOcr;
if (require.main === module) {
    if (process.argv[2] !== '--setup') {
        console.error('Usage: node document-ocr.js --setup');
        process.exitCode = 1;
    } else {
        setup().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
