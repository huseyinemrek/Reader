'use strict';

const path = require('path');
process.env.READER_MODE = 'vps';
process.env.READER_DEFAULT_DATA_DIR = __dirname;
process.env.READER_ENV_FILE ||= path.join(__dirname, '.env');
// The VPS always keeps its own CPU inference path; remote jobs are a separate mode.
process.env.OCR_DEVICE = 'cpu';
require('../local/server');
