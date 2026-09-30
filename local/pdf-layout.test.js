'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ocrBlocks, nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');

function line(text, y, options = {}) {
    const { size = 10, x = 100, width = 500, wordSizes = {} } = options;
    const words = text.split(' ').map(word => {
        const font = wordSizes[word] || size;
        return {
            text: word,
            symbols: [...word].map(character => ({
                text: character,
                bbox: { x0: x, y0: y + 20 - (/^[A-Z0-9bdfhikl]$/.test(character) ? font * 1.5 : font), x1: x + font, y1: y + 20 }
            }))
        };
    });
    return {
        text,
        words,
        bbox: { x0: x, y0: y, x1: x + width, y1: y + 20 },
        baseline: { x0: x, y0: y + 20, x1: x + width, y1: y + 20 },
        rowAttributes: { rowHeight: size * 2, ascenders: size / 2, descenders: size / 2 }
    };
}

function page(paragraphs) {
    return { blocks: [{ paragraphs: paragraphs.map(lines => ({ lines })) }] };
}

function consistent(blocks) {
    assert.equal(validBlocks(blocks, blocksText(blocks)), true);
    for (const block of blocks) {
        assert.equal(block.runs.map(run => run.text).join(''), block.text);
        assert.doesNotMatch(block.text, /\n/);
    }
}

test('OCR measures every size, including inline fonts and digit-only small footers', () => {
    const body = 'Here are many common words in normal prose so the dominant body size is measured reliably';
    const footer = line('25', 450, { size: 8, x: 330, width: 24 });
    footer.rowAttributes = { rowHeight: 27, ascenders: 8, descenders: 6 };
    const blocks = ocrBlocks(page([
        [line('Chapter', 20, { size: 20 })],
        [line('Same size heading', 100)],
        [line(`${body} large`, 180, { wordSizes: { large: 20 } }), line(body, 206)],
        [line('Small caption', 350, { size: 7 })],
        [footer]
    ]));
    assert.equal(blocks[0].runs[0].fontScale, 2);
    assert.equal(blocks[1].runs[0].fontScale, 1);
    assert.ok(blocks[2].runs.some(run => run.text.includes('large') && run.fontScale === 2));
    assert.equal(blocks[3].runs[0].fontScale, 0.7);
    assert.equal(blocks[4].runs[0].fontScale, 0.8);
    consistent(blocks);
});

test('uncertain single-glyph OCR boxes do not enlarge ordinary inline words', () => {
    const prose = line('Here are many ordinary words with This and We in the same font', 100);
    for (const word of prose.words) {
        if (!['This', 'We'].includes(word.text)) continue;
        const symbol = word.symbols.find(symbol => /^[se]$/.test(symbol.text));
        symbol.bbox.y0 = symbol.bbox.y1 - 15;
    }
    const blocks = ocrBlocks(page([[prose]]));
    assert.ok(blocks[0].runs.every(run => run.fontScale === 1));
    consistent(blocks);
});

test('contradictory lowercase and ascender boxes cannot invent a font change', () => {
    const prose = line('Many ordinary words explain learning tasks and their normal size', 100);
    for (const symbol of prose.words.find(word => word.text === 'tasks').symbols) {
        if (symbol.text === 's') symbol.bbox.y0 = symbol.bbox.y1 - 15;
    }
    const blocks = ocrBlocks(page([[prose]]));
    assert.ok(blocks[0].runs.every(run => run.fontScale === 1));
    consistent(blocks);
});

test('oversized ascender boxes do not override reliable lowercase font measurements', () => {
    const prose = line('Many ordinary words explain confidence in the same normal font', 100);
    for (const symbol of prose.words.find(word => word.text === 'confidence').symbols) {
        if (/^[fi]$/.test(symbol.text)) symbol.bbox.y0 = symbol.bbox.y1 - 20;
    }
    const blocks = ocrBlocks(page([[prose]]));
    assert.ok(blocks[0].runs.every(run => run.fontScale === 1));
    consistent(blocks);
});

test('OCR pixel noise within prose consolidates without flattening smaller captions', () => {
    const blocks = ocrBlocks(page([
        [
            line('A long ordinary prose line has many normal words in a single visual paragraph', 100, { size: 13 }),
            line('Raster quantization changes this continuation by one pixel', 134, { size: 12 })
        ],
        [line('Small caption', 240, { size: 9 })]
    ]));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].runs.length, 1);
    assert.equal(blocks[0].runs[0].fontScale, 1);
    assert.equal(blocks[1].runs[0].fontScale, 0.692);
    consistent(blocks);
});

test('normal-spaced false OCR paragraphs merge, real indentation and footer separate', () => {
    const blocks = ocrBlocks(page([
        [line('Here is the first full prose line', 100), line('Another full line of prose', 126)],
        [line('An indented paragraph starts here', 152, { x: 120, width: 480 }), line('It continues at the normal left margin', 178)],
        [line('This full line was falsely split', 204)],
        [line('And another continuation was split', 230)],
        [line('The last body line remains prose', 256), line('25', 310, { size: 8, x: 330, width: 24 })]
    ]));
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].text, 'Here is the first full prose line Another full line of prose');
    assert.equal(blocks[1].text, 'An indented paragraph starts here It continues at the normal left margin This full line was falsely split And another continuation was split The last body line remains prose');
    assert.equal(blocks[2].text, '25');
    consistent(blocks);
});

test('wrapped discretionary and true compound hyphens are distinguished by page vocabulary', () => {
    const blocks = ocrBlocks(page([[
        line('Here reinforcement learning is discussed using rein-', 100),
        line('forcement while a k-', 126),
        line('armed problem remains k-armed and a soft\u00ad', 152),
        line('ware example follows', 178)
    ]]));
    assert.equal(blocks[0].text, 'Here reinforcement learning is discussed using reinforcement while a k-armed problem remains k-armed and a software example follows');
    consistent(blocks);
});

const viewport = { scale: 1, transform: [1, 0, 0, -1, 0, 900] };
function item(str, x, y, size, width, hasEOL = true) {
    return { str, transform: [size, 0, 0, size, x, y], width, height: size, hasEOL, fontName: 'body' };
}

test('native PDF font heights preserve title, caption, footer and mixed-font prose ratios', () => {
    const blocks = nativeBlocks({ items: [
        item('Title', 100, 850, 25, 80),
        item('Here are many words in ordinary body prose', 100, 750, 10, 220, false),
        item(' BIG', 320, 750, 20, 40, false),
        item(' ending', 360, 750, 10, 50),
        item('Wrapped continuation with normal body text', 100, 737, 10, 310),
        item('Small caption', 100, 650, 7, 60),
        item('25', 250, 40, 8, 10)
    ], styles: { body: { ascent: 0.8 } } }, viewport);
    assert.equal(blocks.length, 4);
    assert.equal(blocks[0].runs[0].fontScale, 2.5);
    assert.equal(blocks[1].text, 'Here are many words in ordinary body prose BIG ending Wrapped continuation with normal body text');
    assert.ok(blocks[1].runs.some(run => run.text === ' BIG' && run.fontScale === 2));
    assert.equal(blocks[2].runs[0].fontScale, 0.7);
    assert.equal(blocks[3].runs[0].fontScale, 0.8);
    assert.deepEqual(blocks[0].bbox, { x0: 100, y0: 30, x1: 180, y1: 55 });
    consistent(blocks);
});

test('column reading order is retained without interleaving equal-y rows', () => {
    const blocks = nativeBlocks({ items: [
        item('Left column first', 20, 800, 10, 100),
        item('Left column next', 20, 787, 10, 100),
        item('Right column first', 200, 800, 10, 100),
        item('Right column next', 200, 787, 10, 100)
    ] }, viewport);
    assert.deepEqual(blocks.map(block => block.text), ['Left column first Left column next', 'Right column first Right column next']);
    consistent(blocks);
});

test('unstructured or internally inconsistent cached layouts are rejected', () => {
    assert.equal(validBlocks(undefined, 'Old cache'), false);
    const blocks = ocrBlocks(page([[line('Here is ordinary body text', 100)]]));
    blocks[0].runs[0].text = 'Different text';
    assert.equal(validBlocks(blocks, blocksText(blocks)), false);
});

test('mixed cached layouts exclude equations and figures from speech text and reject unsafe images or obsolete math images', () => {
    const bbox = { x0: 10, y0: 20, x1: 110, y1: 50 };
    const blocks = [
        { type: 'text', bbox, text: 'Before  after', runs: [
            { type: 'text', text: 'Before ', fontScale: 1 },
            { type: 'math', latex: 'Q_t(a)', display: false, fontScale: 1 },
            { type: 'text', text: ' after', fontScale: 1 }
        ] },
        { type: 'math', latex: '\\sum_i R_i', display: true, bbox, label: '(2.1)' },
        { type: 'image', kind: 'figure', imageUrl: '/uploads/pdf/book_1/page-3-region-1.png',
            width: 100, height: 30, bbox, alt: 'Figure 2.1' }
    ];
    assert.equal(blocksText(blocks), 'Before  after');
    assert.equal(validBlocks(blocks, 'Before  after'), true);
    for (const imageUrl of ['/uploads/pdf/book_1/../secret.png', 'https://example.org/image.png',
        '/uploads/pdf/book_1/page-3.jpg', '/uploads/pdf/book_1/page-3-region-0.png']) {
        assert.equal(validBlocks([...blocks.slice(0, 2), { ...blocks[2], imageUrl }], blocksText(blocks)), false);
    }
    assert.equal(validBlocks([...blocks.slice(0, 2), { ...blocks[2], kind: 'equation' }], blocksText(blocks)), false);
    assert.equal(validBlocks([{ ...blocks[1], latex: '' }], ''), false);
    assert.equal(validBlocks([{ ...blocks[2], width: 0 }], ''), false);
    assert.equal(validBlocks([{ ...blocks[0], type: undefined }], blocks[0].text), false);
});
