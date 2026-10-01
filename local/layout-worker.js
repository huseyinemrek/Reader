'use strict';

const fs = require('fs/promises');
const { parentPort, workerData } = require('worker_threads');
const { LAYOUT_MODULE, statIdentity, layoutVersion } = require('./layout-source');

async function build() {
    const { source, temporaryPath } = workerData;
    const moduleSource = await fs.readFile(LAYOUT_MODULE, 'utf8');
    if (await layoutVersion(moduleSource) !== source.layoutVersion) throw new Error('The layout builder changed; restart the server before retrying.');
    const real = await fs.realpath(source.archivePath);
    if (real !== source.archivePath || !(await fs.lstat(real)).isFile()) throw new Error('The book archive is no longer a regular uploads file.');
    const handle = await fs.open(real, 'r');
    let bytes;
    try {
        const matches = stats => JSON.stringify(statIdentity(stats)) === JSON.stringify({
            size: source.size, mtimeNs: source.mtimeNs, ctimeNs: source.ctimeNs,
            birthtimeNs: source.birthtimeNs, dev: source.dev, ino: source.ino
        });
        if (!matches(await handle.stat({ bigint: true }))) throw new Error('The book archive changed before layout generation.');
        bytes = await handle.readFile();
        if (!matches(await handle.stat({ bigint: true }))) throw new Error('The book archive changed during layout generation.');
    } finally {
        await handle.close();
    }
    globalThis.JSZip = require('./libs/jszip.min.js');
    const { buildLayoutBundle } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
    const archive = await globalThis.JSZip.loadAsync(bytes);
    const { blob, index } = await buildLayoutBundle(archive);
    if (Object.keys(index.texts).every(name => !/\.(?:x?html?)$/i.test(name))) {
        throw new Error('The archive contains no HTML chapters for a layout bundle.');
    }
    const bundle = Buffer.from(await blob.arrayBuffer());
    await fs.writeFile(temporaryPath, bundle, { flag: 'wx', mode: 0o600 });
    return { bytes: bundle.byteLength };
}

build().then(result => parentPort.postMessage({ status: 'ready', ...result }), error => {
    parentPort.postMessage({ status: 'failed', error: String(error.message || error).slice(0, 1024) });
});
