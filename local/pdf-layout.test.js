'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeBlocks, blocksText, validBlocks } = require('./pdf-layout');

function consistent(blocks) {
    assert.equal(validBlocks(blocks, blocksText(blocks)), true);
    for (const block of blocks) {
        assert.equal(block.runs.map(run => run.text).join(''), block.text);
        assert.doesNotMatch(block.text, /\n/);
    }
}


test('wrapped discretionary and true compound hyphens are distinguished by page vocabulary', () => {
    const blocks = nativeBlocks({ items: [
        item('Here reinforcement learning is discussed using rein-', 100, 800, 10, 330),
        item('forcement concepts.', 100, 787, 10, 130),
        item('Another example illustrates the k-armed problem using k-', 100, 720, 10, 330),
        item('armed actions.', 100, 707, 10, 130),
        item('The final example contains a source discretionary soft\u00ad', 100, 640, 10, 330),
        item('ware word.', 100, 627, 10, 130)
    ] }, viewport);
    assert.deepEqual(blocks.map(block => block.text), [
        'Here reinforcement learning is discussed using reinforcement concepts.',
        'Another example illustrates the k-armed problem using k-armed actions.',
        'The final example contains a source discretionary software word.'
    ]);
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
    const blocks = nativeBlocks({ items: [item('Here is ordinary body text', 100, 800, 10, 180)] }, viewport);
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
        { type: 'image', kind: 'figure', imageUrl: '/uploads/pdf/book_1/page-3-v11-region-1.png',
            width: 100, height: 30, bbox, alt: 'Figure 2.1' }
    ];
    assert.equal(blocksText(blocks), 'Before  after');
    assert.equal(validBlocks(blocks, 'Before  after'), true);
    for (const imageUrl of ['/uploads/pdf/book_1/../secret.png', 'https://example.org/image.png',
        '/uploads/pdf/book_1/page-3.jpg', '/uploads/pdf/book_1/page-3-v11-region-0.png',
        '/uploads/pdf/book_1/page-3-region-1.png']) {
        assert.equal(validBlocks([...blocks.slice(0, 2), { ...blocks[2], imageUrl }], blocksText(blocks)), false);
    }
    assert.equal(validBlocks([...blocks.slice(0, 2), { ...blocks[2], kind: 'equation' }], blocksText(blocks)), false);
    assert.equal(validBlocks([{ ...blocks[1], latex: '' }], ''), false);
    assert.equal(validBlocks([{ ...blocks[2], width: 0 }], ''), false);
    assert.equal(validBlocks([{ ...blocks[0], type: undefined }], blocks[0].text), false);
});
