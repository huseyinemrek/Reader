'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { documentBlocks } = require('./document-blocks');
const { blocksText, validBlocks } = require('./pdf-layout');

const bbox = { x0: 20, y0: 10, x1: 300, y1: 190 };
const context = { bookId: 'document_fixture', pageNumber: 8, width: 320, height: 200,
    imagePrefix: '/uploads/pdf/document_fixture/page-8-v11' };
const textRegion = content => ({ kind: 'text', bbox, content });
const parse = (regions, overrides = {}) => documentBlocks({ width: 320, height: 200, regions }, { ...context, ...overrides });

test('mixed prose preserves inline subscripts and fractions without leaking math into speech text', async () => {
    const blocks = await parse([textRegion(String.raw`Use $\alpha_t(a)$ with step size \(\frac{1}{n}\) and estimate $Q_n$.`)]);
    assert.equal(blocks[0].text, 'Use  with step size  and estimate .');
    assert.deepEqual(blocks[0].runs.filter(run => run.type === 'math').map(run => run.latex),
        [String.raw`\alpha_t(a)`, String.raw`\frac{1}{n}`, 'Q_n']);
    assert.equal(validBlocks(blocks, blocksText(blocks)), true);
});

test('source line breaks and pseudocode indentation survive with a separate multi-line cases equation', async () => {
    const content = String.raw`Initialize, for each action $a$:
    $Q(a) \leftarrow 0$
    $N(a) \leftarrow 0$
Loop forever:
$$A \leftarrow \begin{cases}\arg\max_a Q(a) & \text{with probability }1-\epsilon \\ \text{a random action} & \text{with probability }\epsilon\end{cases}$$
    $R \leftarrow \operatorname{bandit}(A)$
    $N(A) \leftarrow N(A)+1$
    $Q(A) \leftarrow Q(A)+\frac{1}{N(A)}[R-Q(A)]$`;
    const blocks = await parse([textRegion(content)]);
    assert.deepEqual(blocks.map(block => block.type), ['text', 'math', 'text']);
    assert.equal(blocks[0].text, 'Initialize, for each action :\n    \n    \nLoop forever:\n');
    assert.match(blocks[1].latex, /\\begin\{cases\}[\s\S]*1-\\epsilon[\s\S]*\\end\{cases\}/u);
    assert.equal(blocks[2].text, '\n    \n    \n    ');
    assert.equal(blocks[2].runs.filter(run => run.type === 'math').at(-1).latex,
        String.raw`Q(A) \leftarrow Q(A)+\frac{1}{N(A)}[R-Q(A)]`);
});

test('display delimiters and explicit tags preserve equation labels outside selectable LaTeX', async () => {
    const blocks = await parse([
        textRegion(String.raw`Before.
\[Q_n = \frac{1}{n}\sum_{i=1}^{n}R_i\] (2.5)
After.`),
        { kind: 'formula', bbox, content: String.raw`$$Q_{n+1}=Q_n+\frac{1}{n}[R_n-Q_n]\tag{2.6}$$` }
    ]);
    const equations = blocks.filter(block => block.type === 'math');
    assert.deepEqual(equations.map(block => block.label), ['(2.5)', '(2.6)']);
    assert.equal(equations[0].latex, String.raw`Q_n = \frac{1}{n}\sum_{i=1}^{n}R_i`);
    assert.doesNotMatch(equations[1].latex, /\\tag/u);
    assert.equal(blocksText(blocks), 'Before.\n\n\n\nAfter.');
});

test('escaped and ordinary prices do not consume adjacent inline math', async () => {
    const blocks = await parse([textRegion(String.raw`Pay \$5 or $10; use $Q_n$ and $\frac{1}{n}$.`)]);
    assert.equal(blocks[0].text, 'Pay $5 or $10; use  and .');
    assert.deepEqual(blocks[0].runs.filter(run => run.type === 'math').map(run => run.latex), ['Q_n', String.raw`\frac{1}{n}`]);
});

test('headings use explicit source scale only and raw HTML stays literal selectable text', async () => {
    const blocks = await parse([
        { ...textRegion('## 2.5 Nonstationary Problems'), fontScale: 1.25 },
        textRegion('<img src=x onerror=alert(1)>\nTiny glyphs do not determine paragraph size.')
    ]);
    assert.equal(blocks[0].text, '2.5 Nonstationary Problems');
    assert.equal(blocks[0].runs[0].fontScale, 1.25);
    assert.equal(blocks[1].text, '<img src=x onerror=alert(1)>\nTiny glyphs do not determine paragraph size.');
    assert.equal(blocks[1].runs[0].fontScale, 1);
});

test('malformed math fails explicitly instead of masquerading as readable plain OCR', async () => {
    await assert.rejects(parse([textRegion(String.raw`Bad \(\frac{1}{\) result`)]), /unrenderable formula/u);
    await assert.rejects(parse([textRegion(String.raw`Bad \[Q_n result`)]), /unterminated math/u);
    await assert.rejects(parse([{ kind: 'formula', bbox, content: '$$ $$' }]), /empty formula/u);
    await assert.rejects(parse([textRegion(String.raw`Bad $ \frac{1}{n} result`)]), /unterminated math/u);
});

test('page dimensions, crop boundaries and versioned image identity reject source mismatches', async () => {
    await assert.rejects(documentBlocks({ width: 640, height: 200, regions: [] }, context), /source page dimensions/u);
    await assert.rejects(parse([{ ...textRegion('outside'), bbox: { ...bbox, x1: 321 } }]), /Invalid document model region/u);
    await assert.rejects(parse([textRegion('wrong cache')], { imagePrefix: '/uploads/pdf/other/page-8-v11' }), /versioned source image prefix/u);
});

test('figures and untrusted HTML tables retain exact source crops in reading order', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-document-crops-'));
    const canvas = createCanvas(320, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = '#ff0000'; ctx.fillRect(30, 40, 40, 20);
    ctx.fillStyle = '#0000ff'; ctx.fillRect(80, 100, 70, 30);
    try {
        const blocks = await parse([
            textRegion('Before the figure.'),
            { kind: 'figure', bbox: { x0: 30, y0: 40, x1: 70, y1: 60 }, content: '' },
            textRegion('Before the table.'),
            { kind: 'table', bbox: { x0: 80, y0: 100, x1: 150, y1: 130 }, content: '<table onclick="alert(1)"><tr><td>invented</td></tr></table>' }
        ], { cacheDirectory: directory, imageBuffer: canvas.toBuffer('image/png') });
        assert.deepEqual(blocks.map(block => block.type), ['text', 'image', 'text', 'image']);
        assert.equal(blocksText(blocks), 'Before the figure.\n\nBefore the table.');
        for (const [block, color] of [[blocks[1], [255, 0, 0, 255]], [blocks[3], [0, 0, 255, 255]]]) {
            const crop = await loadImage(await fs.readFile(path.join(directory, path.basename(block.imageUrl))));
            const check = createCanvas(crop.width, crop.height).getContext('2d');
            check.drawImage(crop, 0, 0);
            assert.deepEqual([...check.getImageData(0, 0, crop.width, crop.height).data.slice(0, 4)], color);
            assert.equal(crop.width, block.bbox.x1 - block.bbox.x0);
            assert.equal(crop.height, block.bbox.y1 - block.bbox.y0);
            assert.match(block.imageUrl, /page-8-v11-region-/u);
        }
        assert.equal(validBlocks(blocks, blocksText(blocks)), true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('layout-classified pseudocode keeps display-delimited assignments on their source instruction lines', async () => {
    const blocks = await parse([{ ...textRegion('```markdown\nInitialize:\n    $$Q(a) \\leftarrow 0$$\nLoop forever:\n    $$R \\leftarrow \\operatorname{bandit}(A)$$\n```'), layoutLabel: 'algorithm' }]);
    assert.deepEqual(blocks.map(block => block.type), ['text']);
    assert.equal(blocks[0].text, 'Initialize:\n    \nLoop forever:\n    ');
    assert.deepEqual(blocks[0].runs.filter(run => run.type === 'math').map(run => run.latex),
        [String.raw`Q(a) \leftarrow 0`, String.raw`R \leftarrow \operatorname{bandit}(A)`]);
});

test('neural formula numbers label only an unambiguous source equation, not neighboring prose numbers', async () => {
    const equationBox = { x0: 20, y0: 40, x1: 220, y1: 70 };
    const numberBox = { x0: 270, y0: 45, x1: 300, y1: 60 };
    const blocks = await parse([
        { kind: 'formula', bbox: equationBox, content: 'Q_n' },
        { ...textRegion('(2.5)'), bbox: numberBox, layoutLabel: 'formula_number' },
        { ...textRegion('2.6'), bbox: { ...numberBox, y0: 100, y1: 115 } }
    ]);
    assert.equal(blocks[0].label, '(2.5)');
    assert.deepEqual(blocks.map(block => block.type), ['math', 'text']);
    assert.equal(blocks[1].text, '2.6');

    const ambiguous = await parse([
        { kind: 'formula', bbox: equationBox, content: 'Q_n' },
        { kind: 'formula', bbox: { ...equationBox, x1: 150 }, content: 'R_n' },
        { ...textRegion('(2.5)'), bbox: numberBox, layoutLabel: 'formula_number' }
    ]);
    assert.equal(ambiguous[0].label, undefined);
    assert.equal(ambiguous[1].label, undefined);
    assert.equal(ambiguous[2].text, '(2.5)');
});

test('zoomed inline formulas replace only their anchored source slot before Unicode/newline normalization', async () => {
    const content = '😀 heading\r\nUse $Q_n$ twice: $Q_n$ and \\(n\\).';
    const start = content.lastIndexOf('$Q_n$');
    const finalStart = content.indexOf('\\(n\\)');
    const blocks = await parse([{ ...textRegion(content), inlineMath: [
        { start, end: start + '$Q_n$'.length, latex: 'Q_{n+1}', bbox: { x0: 100, y0: 40, x1: 140, y1: 60 } },
        { start: finalStart, end: finalStart + '\\(n\\)'.length, latex: String.raw`\frac{1}{n}`, bbox: { x0: 200, y0: 40, x1: 230, y1: 60 } }
    ] }]);
    assert.equal(blocks[0].text, '😀 heading\nUse  twice:  and .');
    assert.deepEqual(blocks[0].runs.filter(run => run.type === 'math').map(run => run.latex),
        ['Q_n', 'Q_{n+1}', String.raw`\frac{1}{n}`]);
});

test('ambiguous or overlapping inline crop annotations fail instead of changing the wrong prose', async () => {
    const content = 'Use $Q_n$ here.';
    const start = content.indexOf('$Q_n$');
    const span = { start, end: start + '$Q_n$'.length, latex: 'Q_{n+1}', bbox };
    await assert.rejects(parse([{ ...textRegion(content), inlineMath: [{ ...span, start: 0, end: 3 }] }]), /exact source math span/u);
    await assert.rejects(parse([{ ...textRegion(content), inlineMath: [span, span] }]), /annotation boundaries/u);
    await assert.rejects(parse([{ ...textRegion(content), inlineMath: [{ ...span, end: content.length + 1 }] }]), /annotation boundaries/u);
    await assert.rejects(parse([{ ...textRegion(content), inlineMath: [{ ...span, latex: String.raw`\frac{` }] }]), /unrenderable formula/u);
});

test('GLM whitespace-padded math preserves surrounding prose and literal prices', async () => {
    const blocks = await parse([textRegion(String.raw`Pay $5 and $10; use $ \frac{1}{n} $ . Then $ \alpha $ or $ \alpha_{t} (a). $`)]);
    assert.equal(blocks[0].text, 'Pay $5 and $10; use  . Then  or ');
    assert.deepEqual(blocks[0].runs.filter(run => run.type === 'math').map(run => run.latex),
        [String.raw`\frac{1}{n}`, String.raw`\alpha`, String.raw`\alpha_{t} (a).`]);
    const paddedPrices = await parse([textRegion(String.raw`Costs $ 5 and $ 10; choose $ a $.`)]);
    assert.equal(paddedPrices[0].text, 'Costs $ 5 and $ 10; choose .');
    assert.equal(paddedPrices[0].runs.find(run => run.type === 'math').latex, 'a');
});

test('actual GLM algorithm lines remain prose-ordered inline instructions, not centered displays', async () => {
    const content = String.raw`A simple bandit algorithm
Initialize, for a = 1 to k:
$ Q ( a ) \leftarrow 0 $
$ N ( a ) \leftarrow 0 $
Loop forever:
$ R \leftarrow bandit ( A ) $
$ Q ( A ) \leftarrow Q ( A ) + \frac {1}{N ( A )} \left[ R - Q ( A ) \right] $`;
    const blocks = await parse([{ ...textRegion(content), layoutLabel: 'algorithm' }]);
    assert.deepEqual(blocks.map(block => block.type), ['text']);
    assert.equal(blocks[0].text, 'A simple bandit algorithm\nInitialize, for a = 1 to k:\n\n\nLoop forever:\n\n');
    assert.deepEqual(blocks[0].runs.filter(run => run.type === 'math').map(run => run.latex), [
        String.raw`Q ( a ) \leftarrow 0`, String.raw`N ( a ) \leftarrow 0`,
        String.raw`R \leftarrow bandit ( A )`,
        String.raw`Q ( A ) \leftarrow Q ( A ) + \frac {1}{N ( A )} \left[ R - Q ( A ) \right]`
    ]);
});

test('inline metadata cannot substitute prices, code, nested envelopes, or unrelated source regions', async () => {
    const annotated = (content, envelope, box = bbox) => {
        const start = content.indexOf(envelope);
        return { ...textRegion(content), inlineMath: [{ start, end: start + envelope.length, latex: 'x', bbox: box }] };
    };
    await assert.rejects(parse([annotated('Pay $5 and $10.', '$5 and $')]), /exact source math span/u);
    await assert.rejects(parse([annotated('```text\n$x$\n```', '$x$')]), /exact source math span/u);
    await assert.rejects(parse([annotated('Use $$x$$.', '$x$')]), /exact source math span/u);
    await assert.rejects(parse([annotated('Use $x$.', '$x$', { x0: 0, y0: 0, x1: 10, y1: 10 })]), /annotation boundaries/u);
    const content = 'Use $x$ then $y$.';
    const first = { start: 4, end: 7, latex: 'a', bbox: { x0: 100, y0: 40, x1: 130, y1: 60 } };
    const second = { start: 13, end: 16, latex: 'b', bbox: { x0: 50, y0: 40, x1: 80, y1: 60 } };
    await assert.rejects(parse([{ ...textRegion(content), inlineMath: [first, second] }]), /reading order/u);
});

test('an anchored algorithm display envelope remains at its original instruction position', async () => {
    const content = '```markdown\nLoop:\n    $$x$$;\n```';
    const start = content.indexOf('$$x$$');
    const blocks = await parse([{ ...textRegion(content), layoutLabel: 'algorithm',
        inlineMath: [{ start, end: start + 5, latex: String.raw`Q(a) \leftarrow 0`, bbox }] }]);
    assert.deepEqual(blocks.map(block => block.type), ['text']);
    assert.equal(blocks[0].text, 'Loop:\n    ;');
    assert.equal(blocks[0].runs.find(run => run.type === 'math').latex, String.raw`Q(a) \leftarrow 0`);
});

test('a right-margin equation number labels its unambiguous short equation across the source column', async () => {
    const blocks = await parse([
        { kind: 'formula', content: String.raw`Q_{n+1}=Q_n+\alpha[R_n-Q_n]`,
            bbox: { x0: 20, y0: 40, x1: 140, y1: 70 } },
        { kind: 'text', content: '(2.5)', layoutLabel: 'formula_number',
            bbox: { x0: 280, y0: 45, x1: 310, y1: 65 } }
    ]);
    assert.deepEqual(blocks.map(block => block.type), ['math']);
    assert.equal(blocks[0].label, '(2.5)');
});

test('algorithm math retains prose word spacing without rewriting mathematical products or authored formulas', async () => {
    const content = String.raw`A $\leftarrow\begin{cases}\arg\max_a Q(a)&\mathrm{with probability} 1-\epsilon\\\mathrm{a random action}&\epsilon\end{cases}$; $\mathrm{A B}$; $\mathrm{sin x}$; $\mathrm{𝑥 𝑦}$`;
    const algorithm = await parse([{ ...textRegion(content), layoutLabel: 'algorithm' }]);
    const math = algorithm[0].runs.filter(run => run.type === 'math');
    assert.match(math[0].latex, /\\text\{with probability \}/u);
    assert.match(math[0].latex, /\\text\{a random action\}/u);
    assert.equal(math[1].latex, String.raw`\mathrm{A B}`);
    assert.equal(math[2].latex, String.raw`\mathrm{sin x}`);
    assert.equal(math[3].latex, String.raw`\mathrm{𝑥 𝑦}`);
    const ordinary = await parse([textRegion(content)]);
    assert.match(ordinary[0].runs.find(run => run.type === 'math').latex, /\\mathrm\{with probability\}/u);
});
