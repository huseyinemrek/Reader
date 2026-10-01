import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfSourceSelection } from '../public/pdf-source-selection.mjs';

// Geometry-only fixture. Browser integration exercises PDF.js, real font metrics,
// mouse events and the system clipboard; these cases isolate range boundaries.
function fixture(contentOrPromise) {
    class Node extends EventTarget {
        constructor(ownerDocument) {
            super();
            this.ownerDocument = ownerDocument;
            this.children = [];
            this.style = {};
            this.attributes = {};
        }
        setAttribute(name, value) { this.attributes[name] = value; }
        appendChild(node) { this.children.push(node); node.parent = this; return node; }
        replaceChildren(...nodes) { this.children = nodes.flatMap(node => node.fragment ? node.children : [node]); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        closest() { return null; }
        focus() { this.ownerDocument.activeElement = this; }
        getBoundingClientRect() { return { left: 0, top: 0 }; }
        getContext() {
            return { measureText: text => ({ width: [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length * 10 }) };
        }
    }
    const document = new EventTarget();
    document.defaultView = new EventTarget();
    document.createElement = () => new Node(document);
    document.createDocumentFragment = () => { const node = new Node(document); node.fragment = true; return node; };
    const viewport = new Node(document);
    const surface = new Node(document);
    viewport.appendChild(surface);
    const base = { width: 200, height: 200, transform: [1, 0, 0, -1, 0, 200] };
    const viewer = { viewport, surface, base, pageViewport: base, scale: 1,
        page: { getTextContent: () => Promise.resolve(contentOrPromise) } };
    const selection = new PdfSourceSelection(viewer);
    const event = (x, y) => ({ clientX: x, clientY: y, button: 0, target: surface,
        preventDefault() {}, stopPropagation() {} });
    return { viewer, selection, event };
}

function item(str, y, extra = {}) {
    return { str, width: [...str].length * 10, height: 10, dir: 'ltr', fontName: 'font',
        transform: [10, 0, 0, 10, 10, y], ...extra };
}
function content(items) { return { items, styles: { font: { ascent: 0.8, descent: -0.2, fontFamily: 'sans-serif' } } }; }

test('native drag ranges preserve line breaks and reverse exactly', async () => {
    const { selection, event } = fixture(content([item('First', 180, { hasEOL: true }), item('Second', 150)]));
    await selection.ready;
    selection.mouseDown(event(10, 18));
    selection.mouseMove(event(70, 48));
    assert.equal(selection.selectedText, 'First\nSecond');
    selection.mouseDown(event(70, 48));
    selection.mouseMove(event(10, 18));
    assert.equal(selection.selectedText, 'First\nSecond');
    selection.mouseMove(event(30, 18));
    assert.equal(selection.selectedText, 'rst\nSecond');
    selection.destroy();
});

test('selection endpoints never split a surrogate or combining grapheme', async () => {
    const { selection, event } = fixture(content([item('A😀e\u0301Z', 180, { width: 40 })]));
    await selection.ready;
    selection.mouseDown(event(20, 18));
    selection.mouseMove(event(40, 18));
    assert.equal(selection.selectedText, '😀e\u0301');
    selection.doubleClick(event(35, 18));
    assert.equal(selection.selectedText, 'e\u0301Z');
    selection.destroy();
});

test('RTL native drag maps visual sides to logical source offsets', async () => {
    const { selection, event } = fixture(content([item('אבג', 180, { dir: 'rtl' })]));
    await selection.ready;
    selection.mouseDown(event(40, 18));
    selection.mouseMove(event(20, 18));
    assert.equal(selection.selectedText, 'אב');
    selection.mouseDown(event(20, 18));
    selection.mouseMove(event(40, 18));
    assert.equal(selection.selectedText, 'אב');
    selection.destroy();
});

test('source range and highlight geometry survive rotated zoom', async () => {
    const { selection, viewer, event } = fixture(content([item('ABCD', 180)]));
    await selection.ready;
    selection.mouseDown(event(10, 18));
    selection.mouseMove(event(30, 18));
    assert.equal(selection.selectedText, 'AB');
    viewer.pageViewport = { width: 400, height: 400, transform: [0, 2, 2, 0, 0, 0] };
    selection.layout();
    const highlight = selection.layer.children[0];
    assert.equal(highlight.style.width, '20px');
    assert.equal(highlight.style.transform, 'matrix(0,2,2,0,0,0)');
    assert.equal(selection.selectedText, 'AB');
    selection.mouseDown(event(360, 20));
    selection.mouseMove(event(360, 60));
    assert.equal(selection.selectedText, 'AB');
    selection.destroy();
});

test('OCR selects whole recognized text/math regions, not invented glyph positions', async () => {
    const { selection, event } = fixture(content([]));
    await selection.ready;
    selection.setOcrPage({ width: 200, height: 200, blocks: [
        { type: 'text', text: 'Recognized  paragraph', bbox: { x0: 10, y0: 10, x1: 110, y1: 40 }, runs: [
            { type: 'text', text: 'Recognized ', fontScale: 1 },
            { type: 'math', latex: '\\alpha', display: false, fontScale: 1 },
            { type: 'text', text: ' paragraph', fontScale: 1 }
        ] },
        { type: 'image', imageUrl: '/recognized-image.png', bbox: { x0: 10, y0: 45, x1: 110, y1: 55 } },
        { type: 'math', latex: 'x^{2} = 4', label: '(1)', display: true, bbox: { x0: 10, y0: 60, x1: 110, y1: 80 } }
    ] });
    selection.mouseDown(event(60, 25));
    assert.equal(selection.selectedText, 'Recognized \\alpha paragraph');
    selection.mouseMove(event(60, 70));
    assert.equal(selection.selectedText, 'Recognized \\alpha paragraph\nx^{2} = 4 (1)');
    selection.mouseDown(event(60, 70));
    selection.mouseMove(event(60, 25));
    assert.equal(selection.selectedText, 'Recognized \\alpha paragraph\nx^{2} = 4 (1)');
    selection.setOcrPage(null);
    selection.keyDown({ key: 'a', ctrlKey: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(selection.selectedText, '');
    selection.destroy();
});

test('destroy discards a pending native response and detached highlight layer', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const { selection, viewer } = fixture(pending);
    await Promise.resolve();
    selection.destroy();
    resolve(content([item('Late source text', 180)]));
    assert.equal(await selection.ready, false);
    assert.equal(selection.selectedText, '');
    assert.equal(viewer.surface.children.includes(selection.layer), false);
    assert.equal(selection.listeners.length, 0);
});
