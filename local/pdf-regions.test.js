'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');
const { detectRegions, processRegions } = require('./pdf-regions');

function row(text, y, x = 25, size = 10) {
    let left = x;
    const words = text.split(' ').map(text => {
        const start = left;
        const symbols = [...text].map(character => {
            const bbox = { x0: left, y0: y, x1: left + 5, y1: y + size };
            left += 6;
            return { text: character, bbox };
        });
        const bbox = { x0: start, y0: y, x1: left - 1, y1: y + size };
        left += 5;
        return { text, symbols, bbox };
    });
    return { text, words, bbox: { x0: x, y0: y, x1: left, y1: y + size },
        baseline: { x0: x, y0: y + size, x1: left, y1: y + size } };
}

function layout(rows) {
    const items = rows.flatMap(line => line.words.map((word, index) => ({
        str: word.text, width: word.bbox.x1 - word.bbox.x0, fontName: 'body',
        hasEOL: index === line.words.length - 1,
        transform: [line.bbox.y1 - line.bbox.y0, 0, 0, line.bbox.y1 - line.bbox.y0, word.bbox.x0, 500 - word.bbox.y1]
    })));
    return nativeBlocks({ items, styles: { body: { ascent: 1 } } },
        { scale: 1, transform: [1, 0, 0, -1, 0, 500] });
}

function surface(width = 1000, height = 500) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    return { canvas, context, width, height };
}

function detect(blocks, source) {
    return detectRegions(blocks, { pixels: source.context.getImageData(0, 0, source.width, source.height).data,
        width: source.width, height: source.height });
}

test('caption-bounded source crops retain graph axes and labels, suppress OCR junk and follow preceding prose', async () => {
    const source = surface();
    const blocks = layout([
        row('This complete body paragraph describes the measurements and their distributions before the graph appears.', 20),
        row('3', 130, 250), row('Reward distribution', 200, 80), row('Action', 280, 430),
        row('Figure 8.12: A distribution of the values measured in the experiment.', 350)
    ]);
    source.context.fillStyle = '#111';
    source.context.fillRect(40, 20, 800, 10); // neighboring prose must not enter the crop
    source.context.fillRect(70, 160, 110, 12); // distribution label extends beyond the graph
    source.context.fillRect(250, 100, 3, 210); // complete vertical axis
    source.context.fillRect(250, 307, 480, 3);
    source.context.fillRect(410, 325, 55, 10); // horizontal-axis label
    source.context.fillRect(25, 350, 800, 10); // caption must not enter the crop
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-figure-regression-'));
    try {
        const result = await processRegions({ blocks, imageBuffer: source.canvas.toBuffer('image/png'),
            width: source.width, height: source.height, imagePrefix: '/uploads/pdf/fixture/page-6-v11', cacheDirectory: directory });
        assert.deepEqual(result.map(block => block.type), ['text', 'image', 'text']);
        assert.equal(result[0].text, blocks[0].text);
        assert.match(result[2].text, /^Figure 8.12:/);
        assert.ok(result[1].bbox.x0 <= 70 && result[1].bbox.y0 <= 100);
        assert.ok(result[1].bbox.x1 >= 730 && result[1].bbox.y1 >= 335);
        assert.ok(result[1].bbox.y0 > blocks[0].bbox.y1 && result[1].bbox.y1 < blocks[4].bbox.y0);
        assert.doesNotMatch(blocksText(result), /Reward distribution|Action/);
        const crop = await loadImage(await fs.readFile(path.join(directory, path.basename(result[1].imageUrl))));
        assert.equal(crop.width, result[1].width);
        assert.equal(crop.height, result[1].height);
        assert.equal(validBlocks(result, blocksText(result)), true);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('native math-font items retain no-space inline grouping and exclude a detached right-hand equation number', () => {
    const source = surface();
    const item = (str, x, y, width, fontName = 'body', hasEOL = true) =>
        ({ str, width, fontName, hasEOL, transform: [10, 0, 0, 10, x, 500 - y] });
    const blocks = nativeBlocks({ items: [
        item('These ordinary explanatory words introduce the mathematical notation used in the discussion.', 25, 35, 580),
        item('The estimate ', 25, 80, 70, 'body', false),
        item('Q', 95, 80, 10, 'math', false),
        item('t', 105, 80, 5, 'math', false),
        item('(a)', 110, 80, 20, 'math', false),
        item(' remains a useful quantity for comparing actions.', 130, 80, 300),
        item('Q(a) = r', 100, 200, 120, 'math'),
        item('(9.3)', 900, 200, 45)
    ], styles: { body: { ascent: 0.8 }, math: { ascent: 0.8, sourceFontName: 'CMMI10' } } },
    { scale: 1, transform: [1, 0, 0, -1, 0, 500] });
    source.context.fillStyle = '#000';
    source.context.fillRect(100, 192, 120, 10);
    source.context.fillRect(900, 192, 45, 10);
    const regions = detect(blocks, source);
    assert.ok(regions.inline.some(region => blocks[region.index].text.slice(region.start, region.end) === 'Qt(a)'));
    assert.equal(regions.displays.length, 1);
    assert.equal(regions.displays[0].label, '(9.3)');
    assert.ok(regions.displays[0].bbox.x1 < 900);
});

test('display grouping does not consume a same-height paragraph in another column', () => {
    const source = surface();
    const blocks = layout([
        row('This explanatory paragraph establishes the normal body margin and the usual font size for this page.', 20),
        row('F(x) = 0', 100, 100),
        row('A short separate heading', 100, 600)
    ]);
    const regions = detect(blocks, source);
    assert.deepEqual(regions.displays.map(region => region.indices), [[1]]);
    assert.ok(regions.displays[0].bbox.x1 < blocks[2].bbox.x0);
});

test('source crop padding excludes ink belonging to the next assignment', () => {
    const source = surface();
    // Build independently segmented native paragraphs: page layout may legitimately
    // merge two flush-left formula rows into a single multiline equation.
    const blocks = [
        ...layout([row('This explanatory paragraph establishes the normal body margin and the usual font size for this page.', 20)]),
        ...layout([row('F(x) = 0', 100, 100)]),
        ...layout([row('G(x) = 1', 112, 100)])
    ];
    source.context.fillStyle = '#000';
    for (const block of blocks.slice(1)) {
        source.context.fillRect(block.bbox.x0, block.bbox.y0, block.bbox.x1 - block.bbox.x0, block.bbox.y1 - block.bbox.y0);
    }
    const regions = detect(blocks, source);
    assert.equal(regions.displays.length, 2);
    assert.ok(regions.displays[0].bbox.y1 <= blocks[2].bbox.y0);
    assert.ok(regions.displays[1].bbox.y0 >= blocks[1].bbox.y1);
});

test('a detached upper summation limit attaches to the closer equation, not the preceding row', () => {
    const source = surface();
    const blocks = layout([
        row('This explanatory paragraph establishes the normal body margin and the usual font size for this page.', 20),
        row('F(x) = x', 100, 100),
        row('n', 120, 140, 5),
        row('G(x) = ∑ x', 130, 100)
    ]);
    const regions = detect(blocks, source);
    assert.deepEqual(regions.displays.map(region => region.indices), [[1], [2, 3]]);
});
