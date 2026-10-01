'use strict';

const fs = require('fs');
const path = require('path');
const source = path.resolve(__dirname, '..', 'local');
const oldEnv = path.join(source, '.env');
const newEnv = path.join(__dirname, '.env');
if (fs.existsSync(oldEnv) && !fs.existsSync(newEnv)) fs.copyFileSync(oldEnv, newEnv, fs.constants.COPYFILE_EXCL);
const requireShared = require('module').createRequire(path.join(source, 'package.json'));
requireShared('dotenv').config({ path: process.env.READER_ENV_FILE || newEnv, quiet: true });
const destination = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(destination, { recursive: true });
const oldLibrary = path.join(source, 'library.json');
// Preserve the legacy server's direct public binding during the first production cutover.
if (fs.existsSync(oldLibrary) && (!fs.existsSync(newEnv) || !/^\s*HOST\s*=/m.test(fs.readFileSync(newEnv, 'utf8')))) {
    fs.appendFileSync(newEnv, '\nHOST=0.0.0.0\n', { mode: 0o600 });
}
const newLibrary = path.join(destination, 'library.json');
if (!fs.existsSync(newLibrary) && fs.existsSync(oldLibrary)) {
    if (!Array.isArray(JSON.parse(fs.readFileSync(oldLibrary, 'utf8')))) throw new Error('The existing local library is not a JSON array.');
    const oldUploads = path.join(source, 'uploads');
    if (fs.existsSync(oldUploads)) fs.cpSync(oldUploads, path.join(destination, 'uploads'), { recursive: true, force: false, errorOnExist: false });
    fs.copyFileSync(oldLibrary, newLibrary, fs.constants.COPYFILE_EXCL);
    console.log('Copied the existing local library and uploads into the VPS data directory. Originals and local/.venv-ocr were not changed.');
} else {
    console.log('VPS library already exists or no local library exists; no library or upload files were changed.');
}
