'use strict';

const path = require('path');
module.exports = {
    apps: [{
        name: 'reader',
        script: path.join(__dirname, 'server.js'),
        cwd: __dirname,
        instances: 1,
        exec_mode: 'fork',
        kill_timeout: 15000,
        env: { NODE_ENV: 'production' }
    }]
};
