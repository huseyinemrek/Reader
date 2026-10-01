'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LAYOUT_MODULE = path.join(__dirname, '..', 'hosting', 'public', 'layout-bundle.js');
const CACHE_VERSION = 1;

function layoutError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

function validateBookId(bookId) {
    if (typeof bookId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(bookId)) {
        throw layoutError(400, 'Invalid layout book identifier.');
    }
}

function statIdentity(stats) {
    return {
        size: String(stats.size), mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs),
        birthtimeNs: String(stats.birthtimeNs), dev: String(stats.dev), ino: String(stats.ino)
    };
}

async function layoutVersion(moduleSource) {
    const source = moduleSource ?? await fs.readFile(LAYOUT_MODULE);
    return crypto.createHash('sha256').update(`reader-layout-cache:${CACHE_VERSION}\n`).update(source).digest('hex');
}

async function describeSource(archivePath, uploadsDir, version) {
    if (typeof archivePath !== 'string' || archivePath.includes('\0')) {
        throw layoutError(400, 'Invalid layout archive path.');
    }
    const root = path.resolve(uploadsDir);
    const filename = path.resolve(archivePath);
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith('.') || relative.includes('/') || relative.includes('\\') || path.isAbsolute(relative)) {
        throw layoutError(400, 'The layout archive must be a direct, non-protected uploads file.');
    }
    if (!/\.(?:epub|htmlz|zip)$/i.test(relative)) {
        throw layoutError(415, 'Layout bundles are only available for EPUB, HTMLZ and ZIP books.');
    }
    try {
        const [real, stats] = await Promise.all([fs.realpath(filename), fs.lstat(filename, { bigint: true })]);
        if (real !== filename || !stats.isFile()) {
            throw layoutError(400, 'The layout archive must be a regular uploads file, not a symbolic link.');
        }
        const source = { archivePath: filename, layoutVersion: version, ...statIdentity(stats) };
        const sourceVersion = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
        return { source, sourceVersion };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw layoutError(404, 'Book archive not found.');
        throw error;
    }
}

module.exports = { CACHE_VERSION, LAYOUT_MODULE, layoutError, validateBookId, statIdentity, layoutVersion, describeSource };
