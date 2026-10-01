'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeBlocks, nativePdfLinks, blocksText, validBlocks } = require('../hosting/public/pdf-layout-core.mjs');

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

test('source paragraph indentation is preserved only when actually present in layout', () => {
    const blocks = nativeBlocks({ items: [
        item('Chapter One', 200, 850, 16, 100),
        item('First paragraph starts flush with column edge and continues', 100, 800, 10, 320),
        item('down to the second line of the first paragraph.', 100, 785, 10, 260),
        item('Second paragraph starts with a real indent.', 120, 750, 10, 240),
        item('Its continuation line wraps back to column margin.', 100, 735, 10, 280),
        item('Third paragraph also starts with an indent.', 120, 700, 10, 240),
        item('And continues here normally.', 100, 685, 10, 160)
    ] }, viewport);
    assert.deepEqual(blocks.map(b => b.indented), [undefined, undefined, true, true]);
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

test('linked native PDF rows keep their line breaks and resolve safe internal destinations', async () => {
    const page = {
        getViewport: () => ({ transform: [1, 0, 0, -1, 0, 900] }),
        getAnnotations: async () => [
            { subtype: 'Link', rect: [99, 798, 221, 810], dest: [{ num: 3, gen: 0 }, 'XYZ', 0, 0, null] },
            { subtype: 'Link', rect: [99, 781, 231, 793], url: 'https://example.org/' },
            { subtype: 'Link', rect: [99, 764, 231, 776], url: 'javascript:alert(1)' }
        ]
    };
    const pdfDocument = { numPages: 4, getPageIndex: async reference => reference.num - 1 };
    const links = await nativePdfLinks(page, pdfDocument);
    assert.deepEqual(links.map(({ page: destination, url }) => destination ?? url), [3, 'https://example.org/']);

    const blocks = nativeBlocks({ items: [
        item('First linked chapter', 100, 800, 10, 120),
        item('Second linked chapter', 100, 783, 10, 130)
    ] }, viewport, links);
    assert.deepEqual(blocks.map(block => block.text), ['First linked chapter', 'Second linked chapter']);
    assert.deepEqual(blocks.map(block => block.runs[0].link), [{ page: 3 }, { url: 'https://example.org/' }]);
    consistent(blocks);
});

test('equal-size native runs preserve face, family, italic and numeric weight boundaries', () => {
    const styles = {
        regular: { sourceFontName: 'ABCDEF+Book-Regular', fontFamily: 'serif', fontStyle: 'normal', fontWeight: 400 },
        italic: { sourceFontName: 'ABCDEF+Book-Italic', fontFamily: 'serif', fontStyle: 'italic', fontWeight: 400 },
        bold: { sourceFontName: 'ABCDEF+Book-Bold', fontFamily: 'serif', fontStyle: 'normal', fontWeight: 700 },
        other: { sourceFontName: 'GHIJKL+Other-Regular', fontFamily: 'sans-serif', fontStyle: 'normal', fontWeight: 400 },
        oblique: { sourceFontName: 'GHIJKL+Other-Oblique', fontFamily: 'sans-serif', fontStyle: 'oblique', fontWeight: 450 }
    };
    const faces = ['regular', 'regular', 'italic', 'bold', 'other', 'oblique'];
    const words = ['Ordinary', 'text', 'emphasis', 'strong', 'different', 'slanted'];
    const blocks = nativeBlocks({ items: words.map((word, index) => ({
        ...item(word, 100 + index * 60, 800, 10, 59, index === words.length - 1),
        fontName: faces[index]
    })), styles }, viewport);
    assert.equal(blocks[0].text, words.join(' '));
    assert.deepEqual(blocks[0].runs, [
        { type: 'text', text: 'Ordinary text', fontScale: 1, fontName: styles.regular.sourceFontName, fontFamily: 'serif', fontStyle: 'normal', fontWeight: 400 },
        { type: 'text', text: ' emphasis', fontScale: 1, fontName: styles.italic.sourceFontName, fontFamily: 'serif', fontStyle: 'italic', fontWeight: 400 },
        { type: 'text', text: ' strong', fontScale: 1, fontName: styles.bold.sourceFontName, fontFamily: 'serif', fontStyle: 'normal', fontWeight: 700 },
        { type: 'text', text: ' different', fontScale: 1, fontName: styles.other.sourceFontName, fontFamily: 'sans-serif', fontStyle: 'normal', fontWeight: 400 },
        { type: 'text', text: ' slanted', fontScale: 1, fontName: styles.oblique.sourceFontName, fontFamily: 'sans-serif', fontStyle: 'oblique', fontWeight: 450 }
    ]);
    consistent(blocks);
    for (const field of ['sourceFontName', 'fontFamily', 'fontStyle', 'fontWeight']) {
        const changed = { ...styles.regular, [field]: styles.oblique[field] };
        const boundary = nativeBlocks({ items: [
            { ...item('Same', 100, 800, 10, 40, false), fontName: 'before' },
            { ...item('size', 141, 800, 10, 40), fontName: 'after' }
        ], styles: { before: styles.regular, after: changed } }, viewport);
        assert.deepEqual(boundary[0].runs.map(run => run.text), ['Same', ' size']);
    }
});

test('dehyphenation survives font changes inside a word and a separately styled hyphen', () => {
    const styles = {
        body: { sourceFontName: 'Book-Regular', fontFamily: 'serif', fontStyle: 'normal', fontWeight: 400 },
        italic: { sourceFontName: 'Book-Italic', fontFamily: 'serif', fontStyle: 'italic', fontWeight: 400 }
    };
    const blocks = nativeBlocks({ items: [
        item('Read reinforcement learning using rein', 100, 800, 10, 300, false),
        { ...item('-', 400, 800, 10, 5), fontName: 'italic' },
        { ...item('forcement concepts.', 100, 787, 10, 130), fontName: 'italic' },
        item('A source discretionary soft', 100, 700, 10, 300, false),
        { ...item('\u00ad', 400, 700, 10, 5), fontName: 'italic' },
        item('ware word.', 100, 687, 10, 130)
    ], styles }, viewport);
    assert.deepEqual(blocks.map(block => block.text), [
        'Read reinforcement learning using reinforcement concepts.',
        'A source discretionary software word.'
    ]);
    assert.deepEqual(blocks[0].runs.map(run => [run.text, run.fontStyle]), [
        ['Read reinforcement learning using rein', 'normal'], ['forcement concepts.', 'italic']
    ]);
    consistent(blocks);
});

test('optional native typography is validated without adding styling to legacy OCR runs', () => {
    const block = { type: 'text', text: 'Recognized prose', bbox: { x0: 1, y0: 1, x1: 100, y1: 20 },
        runs: [{ type: 'text', text: 'Recognized prose', fontScale: 1 }] };
    assert.equal(validBlocks([block], block.text), true);
    for (const [field, value] of [
        ['fontName', ''], ['fontName', 42], ['fontName', 'g_d7_f1'],
        ['fontFamily', '  '], ['fontFamily', false],
        ['fontStyle', 'bold'], ['fontWeight', '700'], ['fontWeight', 0],
        ['fontWeight', 1001], ['fontWeight', NaN], ['fontWeight', Infinity]
    ]) {
        const invalid = { ...block, runs: [{ ...block.runs[0], [field]: value }] };
        assert.equal(validBlocks([invalid], invalid.text), false, `${field}: ${value}`);
    }
    const styled = { ...block, runs: [{ ...block.runs[0], fontName: 'ABCDEF+Book',
        fontFamily: 'serif', fontStyle: 'oblique', fontWeight: 450 }] };
    assert.equal(validBlocks([styled], styled.text), true);
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

test('native illustrations split paragraphs, retain column order and do not repeat source labels', () => {
    const figure = { type: 'image', kind: 'figure', imageUrl: '/uploads/pdf/book_1/page-1-v15-native-region-1.png',
        width: 100, height: 20, bbox: { x0: 20, y0: 115, x1: 120, y1: 135 }, alt: 'Source chart' };
    const blocks = nativeBlocks({ items: [
        item('Left column before', 20, 800, 10, 100),
        item('Chart label', 25, 775, 7, 40),
        item('Left column after', 20, 750, 10, 100),
        item('Right column before', 200, 800, 10, 100),
        item('Right column after', 200, 787, 10, 100)
    ] }, viewport, [], [figure]);
    assert.deepEqual(blocks.map(block => block.type === 'image' ? block.alt : block.text),
        ['Left column before', 'Source chart', 'Left column after', 'Right column before Right column after']);
    assert.equal(blocksText(blocks), 'Left column before\n\nLeft column after\n\nRight column before Right column after');
    assert.equal(validBlocks(blocks, blocksText(blocks)), true);
    assert.equal(blocks[2].runs[0].fontScale, 1);
    assert.deepEqual(nativeBlocks({ items: [] }, viewport, [], [figure]), [figure]);
});
