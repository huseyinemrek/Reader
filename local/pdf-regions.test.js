'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { ocrBlocks, nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');
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
    return ocrBlocks({ blocks: rows.map(line => ({ paragraphs: [{ lines: [line] }] })) });
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
            width: source.width, height: source.height, bookId: 'fixture', pageNumber: 6, cacheDirectory: directory });
        assert.deepEqual(result.map(block => block.type), ['text', 'image', 'text']);
        assert.equal(result[0].text, blocks[0].text);
        assert.match(result[2].text, /^Figure 8.12:/);
        assert.equal(result[1].imageUrl, '/uploads/pdf/fixture/page-6-region-1.png');
        assert.ok(result[1].bbox.x0 <= 70 && result[1].bbox.y0 <= 100);
        assert.ok(result[1].bbox.x1 >= 730 && result[1].bbox.y1 >= 335);
        assert.ok(result[1].bbox.y0 > blocks[0].bbox.y1 && result[1].bbox.y1 < blocks[4].bbox.y0);
        assert.doesNotMatch(blocksText(result), /Reward distribution|Action/);
        const crop = await loadImage(await fs.readFile(path.join(directory, 'page-6-region-1.png')));
        assert.equal(crop.width, result[1].width);
        assert.equal(crop.height, result[1].height);
        assert.equal(validBlocks(result, blocksText(result)), true);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('overlapping fraction rows and detached limits become one equation region without neighboring prose or label', () => {
    const source = surface();
    const numerator = row('sum of rewards prior to t', 110, 160);
    const fraction = row('Q(a) = denominator (2.1)', 115, 100);
    // PDF equation number is a separate, right-aligned source word.
    const number = fraction.words.at(-1);
    number.bbox = { x0: 900, y0: 115, x1: 945, y1: 125 };
    number.symbols.forEach((symbol, index) => { symbol.bbox = { x0: 900 + index * 6, y0: 115, x1: 905 + index * 6, y1: 125 }; });
    fraction.bbox.x1 = 945;
    const blocks = layout([
        row('The following paragraph explains how the sample means are estimated from the observed rewards.', 20),
        numerator, fraction, row('a', 133, 180),
        row('The next paragraph continues the discussion with ordinary readable explanatory body prose.', 190)
    ]);
    source.context.fillStyle = '#000';
    source.context.fillRect(100, 110, 400, 35);
    source.context.fillRect(900, 115, 45, 10);
    const regions = detect(blocks, source);
    assert.equal(regions.displays.length, 1);
    assert.deepEqual(regions.displays[0].indices, [1, 2, 3]);
    assert.equal(regions.displays[0].label, '(2.1)');
    assert.ok(regions.displays[0].bbox.x1 < 900);
    assert.ok(regions.displays[0].bbox.y0 > blocks[0].bbox.y1);
    assert.ok(regions.displays[0].bbox.y1 < blocks[4].bbox.y0);
});

test('inline notation regions do not consume surrounding prose or turn equation references into display blocks', () => {
    const source = surface();
    const blocks = layout([
        row('The estimates q*(a), a = 1,...,10, describe the action values in the experiment.', 20),
        row('The discussion of the mathematical method ends with a reference to equation (2.1).', 100),
        row('We assess e-greedy selection where the probability is £ = 0.5, and the remaining words stay readable.', 200)
    ]);
    const regions = detect(blocks, source);
    assert.equal(regions.displays.length, 0);
    const spans = regions.inline.map(region => blocks[region.index].text.slice(region.start, region.end));
    assert.ok(spans.some(span => span.includes('q*(a)')));
    assert.ok(spans.some(span => span.includes('a = 1,...,10')));
    assert.ok(spans.includes('£ = 0.5'));
    assert.ok(spans.includes('e'));
    const prefix = regions.inline.find(region => region.index === 2 && blocks[2].text.slice(region.start, region.end) === 'e');
    assert.equal(prefix.start, blocks[2].text.indexOf('e-greedy'));
    assert.equal(prefix.end, prefix.start + 1);
    for (const region of regions.inline) {
        const span = blocks[region.index].text.slice(region.start, region.end);
        assert.doesNotMatch(span, /estimates|describe|discussion|remaining|greedy/);
        assert.ok(region.end - region.start < blocks[region.index].text.length / 2);
    }
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
