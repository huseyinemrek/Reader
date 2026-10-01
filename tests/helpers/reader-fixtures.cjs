'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const requireLocal = createRequire(path.join(root, 'local/package.json'));
const JSZip = require(path.join(root, 'local/libs/jszip.min.js'));
const { createCanvas } = requireLocal('@napi-rs/canvas');

function illustration(color) {
    const canvas = createCanvas(256, 256);
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(256, 256);
    let seed = 173;
    for (let i = 0; i < pixels.data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[i + channel] = seed >>> 24;
        }
        pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    ctx.fillStyle = color;
    ctx.fillRect(64, 64, 128, 128);
    return canvas.toBuffer('image/png');
}

async function makeEpub(directory, title = 'Generated parity journey') {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/package.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">generated-reader-regression</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/><item id="later" href="later.xhtml" media-type="application/xhtml+xml"/><item id="css" href="journey.css" media-type="text/css"/><item id="red" href="images/first.png" media-type="image/png"/><item id="blue" href="images/later.png" media-type="image/png"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="first"/><itemref idref="later"/></spine></package>`);
    zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="first.xhtml">First journey</a></li><li><a href="later.xhtml">Later journey</a></li></ol></nav></body></html>');
    zip.file('OEBPS/journey.css', 'body { font-family: Georgia, serif; color: #593219; } p {font-size: 14px;} .large {font-size: 21px;} .small {font-size: 10px;} em {font-style: italic;} strong {font-weight:700;} img {width:160px;height:160px;} .css-illustration {width:32px;height:32px;background-size:100% 100%;} .css-First {background-image:url(images/first.png);} .css-Later {background-image:url(images/later.png);}');
    const paragraphs = chapter => Array.from({ length: 55 }, (_, i) => `<p id="${chapter}-${i}">${chapter} passage ${String(i).padStart(2, '0')}. The quiet traveller reads the river, remembers the turning road, and carries a lantern through the evening. A patient companion follows the path beyond the hill, watching the sky while the village slowly fades behind them.</p>`).join('');
    const chapter = (name, image) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name} journey</title><link rel="stylesheet" href="journey.css"/></head><body><div class="css-illustration css-${name}"></div><img alt="${name} illustration" src="images/${image}.png"/><h1>${name} journey</h1><p class="source-runs">Plain words <em>gentle emphasis</em> then plain <strong>strong emphasis</strong>.</p><p class="large">Larger source lettering</p><p class="small">Smaller source lettering</p>${paragraphs(name)}</body></html>`;
    zip.file('OEBPS/first.xhtml', chapter('First', 'first'));
    zip.file('OEBPS/later.xhtml', chapter('Later', 'later'));
    zip.file('OEBPS/images/first.png', illustration('#e82020'), { compression: 'STORE' });
    zip.file('OEBPS/images/later.png', illustration('#2040e8'), { compression: 'STORE' });
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const file = path.join(directory, title.toLowerCase().replaceAll(' ', '-') + '.epub');
    await fs.writeFile(file, bytes);
    let cursor = 0;
    let laterImage;
    while (bytes.readUInt32LE(cursor) === 0x04034b50) {
        const size = bytes.readUInt32LE(cursor + 18);
        const nameLength = bytes.readUInt16LE(cursor + 26);
        const extraLength = bytes.readUInt16LE(cursor + 28);
        const name = bytes.toString('utf8', cursor + 30, cursor + 30 + nameLength);
        const start = cursor + 30 + nameLength + extraLength;
        if (name === 'OEBPS/images/later.png') laterImage = { start, end: start + size - 1 };
        cursor = start + size;
    }
    return { file, title, bytes, laterImage };
}

module.exports = { makeEpub };
