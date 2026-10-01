// PDF strings stay in memory. Only empty, aria-hidden highlight rectangles enter
// the source DOM; a browser text layer would make speech read the page twice.
const graphemes = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const words = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

function multiply(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function inverse(m) {
    const determinant = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    return [m[3] / determinant, -m[1] / determinant, -m[2] / determinant,
        m[0] / determinant, (m[2] * m[5] - m[3] * m[4]) / determinant,
        (m[1] * m[4] - m[0] * m[5]) / determinant];
}

function point(m, x, y) {
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function segments(text) {
    return graphemes ? Array.from(graphemes.segment(text), part => ({ text: part.segment, index: part.index }))
        : Array.from(text).reduce((parts, value) => {
            parts.push({ text: value, index: parts.length ? parts.at(-1).index + parts.at(-1).text.length : 0 });
            return parts;
        }, []);
}

// PDF.js exposes logical strings, not per-glyph positions. Respect its direction,
// retaining left-to-right number/Latin runs inside a right-to-left text item.
function visualOrder(parts, rtl) {
    if (!rtl) return parts.map((_, index) => index);
    const runs = [];
    for (let i = 0; i < parts.length; i++) {
        const ltr = /[\p{Script=Latin}\p{N}]/u.test(parts[i].text);
        const direction = ltr ? 'ltr' : /[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(parts[i].text) ? 'rtl'
            : runs.at(-1)?.direction || 'rtl';
        if (runs.at(-1)?.direction === direction) runs.at(-1).indices.push(i);
        else runs.push({ direction, indices: [i] });
    }
    return runs.reverse().flatMap(run => run.direction === 'rtl' ? run.indices.reverse() : run.indices);
}

function nativeItems(content, base, context) {
    const items = [];
    let text = '';
    const baseScale = Math.hypot(base.transform[0], base.transform[1]);
    for (const item of content.items || []) {
        if (typeof item.str !== 'string') continue;
        const start = text.length;
        text += item.str;
        if (item.str && Array.isArray(item.transform) && item.transform.length === 6) {
            const style = content.styles?.[item.fontName] || {};
            const transform = multiply(base.transform, item.transform);
            let axis = [transform[0], transform[1]];
            let up = [transform[2], transform[3]];
            let fontSize = Math.hypot(...up);
            if (style.vertical) {
                axis = [-transform[1], transform[0]];
                up = [-axis[1], axis[0]];
                fontSize = Math.hypot(transform[0], transform[1]);
            }
            const axisSize = Math.hypot(...axis);
            const upSize = Math.hypot(...up);
            const width = Math.abs(style.vertical ? item.height : item.width) * baseScale;
            if (axisSize > 0 && upSize > 0 && fontSize > 0 && width > 0 && Number.isFinite(width)) {
                axis = axis.map(value => value / axisSize);
                up = up.map(value => value / upSize);
                const matrix = [axis[0], axis[1], up[0], up[1], transform[4], transform[5]];
                const inv = inverse(matrix);
                if (inv) {
                    const ascent = Number.isFinite(style.ascent) ? style.ascent
                        : Number.isFinite(style.descent) ? 1 + style.descent : 0.8;
                    const descent = Number.isFinite(style.descent) ? style.descent : ascent - 1;
                    const parts = segments(item.str);
                    context.font = `${fontSize}px ${style.fontFamily || 'sans-serif'}`;
                    context.direction = item.dir === 'rtl' ? 'rtl' : 'ltr';
                    const total = context.measureText(item.str).width;
                    let previous = 0;
                    const advances = parts.map(part => {
                        const next = context.measureText(item.str.slice(0, part.index + part.text.length)).width;
                        const advance = Math.max(0, next - previous);
                        previous = next;
                        return advance;
                    });
                    const measured = advances.reduce((sum, value) => sum + value, 0);
                    let x = 0;
                    const glyphs = [];
                    for (const index of visualOrder(parts, item.dir === 'rtl')) {
                        const part = parts[index];
                        const advance = measured > 0 && total > 0 ? advances[index] / measured * width : width / parts.length;
                        glyphs.push({ x0: x, x1: x + advance, start: start + part.index,
                            end: start + part.index + part.text.length, rtl: item.dir === 'rtl' && !/[\p{Script=Latin}\p{N}]/u.test(part.text) });
                        x += advance;
                    }
                    items.push({ start, end: start + item.str.length, matrix, inverse: inv, width,
                        bottom: Math.min(descent, ascent) * fontSize, top: Math.max(ascent, descent) * fontSize, glyphs });
                }
            }
        }
        if (item.hasEOL) text += '\n';
    }
    return { text, items };
}

function recognizedText(block) {
    if (block.type === 'math') {
        if (typeof block.latex !== 'string' || !block.latex) return '';
        return block.latex + (typeof block.label === 'string' && block.label ? ' ' + block.label : '');
    }
    if (block.type !== 'text') return '';
    // In the OCR contract block.text deliberately excludes inline formulas;
    // ordered runs are the complete recognized paragraph, with no glyph boxes.
    return Array.isArray(block.runs) ? block.runs.map(recognizedText).join('')
        : typeof block.text === 'string' ? block.text : '';
}

function ocrItems(result, base) {
    if (!(result?.width > 0 && result?.height > 0) || !Array.isArray(result.blocks)) return { text: '', items: [] };
    const sx = base.width / result.width;
    const sy = base.height / result.height;
    const items = [];
    let text = '';
    for (const block of result.blocks) {
        const box = block.bbox;
        const recognized = recognizedText(block);
        if (!recognized ||
            !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) ||
            box.x1 <= box.x0 || box.y1 <= box.y0) continue;
        if (text) text += '\n';
        const start = text.length;
        text += recognized;
        const matrix = [1, 0, 0, 1, box.x0 * sx, box.y0 * sy];
        items.push({ start, end: text.length, matrix, inverse: inverse(matrix), width: (box.x1 - box.x0) * sx,
            bottom: 0, top: (box.y1 - box.y0) * sy, region: true });
    }
    return { text, items };
}

export class PdfSourceSelection {
    constructor(viewer) {
        this.viewer = viewer;
        this.document = viewer.viewport.ownerDocument;
        this.window = this.document.defaultView;
        this.destroyed = false;
        this.native = { text: '', items: [] };
        this.source = this.native;
        this.ocr = null;
        this.anchor = this.focus = 0;
        this.drag = null;
        this.copyRequested = false;
        this.layer = this.document.createElement('div');
        this.layer.className = 'pdf-source-selection-layer';
        this.layer.setAttribute('aria-hidden', 'true');
        this.layer.setAttribute('data-tts-ignore', 'true');
        viewer.surface.appendChild(this.layer);
        this.listeners = [];
        this.listen(viewer.surface, 'mousedown', event => this.mouseDown(event));
        this.listen(viewer.surface, 'dblclick', event => this.doubleClick(event));
        this.listen(this.document, 'mousemove', event => this.mouseMove(event));
        this.listen(this.document, 'mouseup', event => {
            if (event.button === 0 && this.drag) { this.mouseMove(event); this.drag = null; }
        });
        this.listen(this.window, 'blur', () => { this.drag = null; });
        this.listen(viewer.viewport, 'keydown', event => this.keyDown(event), true);
        this.listen(this.document, 'copy', event => this.copyEvent(event), true);
        const page = viewer.page;
        this.ready = Promise.resolve().then(() => {
            if (this.destroyed || viewer.destroyed || viewer.page !== page) return null;
            return page.getTextContent();
        }).then(content => {
            if (!content || this.destroyed || viewer.destroyed || viewer.page !== page) return false;
            // A tiny detached measuring canvas is never a page render or text DOM.
            const canvas = this.document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d');
            if (!context) return false;
            this.native = nativeItems(content, viewer.base, context);
            if (!this.ocr) this.source = this.native;
            viewer.surface.setAttribute('data-pdf-selectable', String(this.source.items.length > 0));
            this.layout();
            return true;
        }).catch(() => false);
    }

    listen(target, name, handler, options = false) {
        target.addEventListener(name, handler, options);
        this.listeners.push(() => target.removeEventListener(name, handler, options));
    }

    get selectedText() {
        return this.destroyed ? '' : this.source.text.slice(Math.min(this.anchor, this.focus), Math.max(this.anchor, this.focus));
    }

    setOcrPage(result) {
        if (this.destroyed) return;
        this.ocr = result || null;
        this.source = result ? ocrItems(result, this.viewer.base) : this.native;
        this.viewer.surface.setAttribute('data-pdf-selectable', String(this.source.items.length > 0));
        this.clear();
    }

    clear() {
        this.anchor = this.focus = 0;
        this.drag = null;
        this.drawn = null;
        this.layer.replaceChildren();
    }

    interactive(target) {
        return !!target?.closest?.('a, button, input, textarea, select, [contenteditable="true"]');
    }

    coordinate(event) {
        const viewport = this.viewer.pageViewport;
        if (!viewport) return null;
        const transform = inverse(viewport.transform);
        if (!transform) return null;
        const bounds = this.viewer.surface.getBoundingClientRect();
        const pdf = point(transform, event.clientX - bounds.left, event.clientY - bounds.top);
        return point(this.viewer.base.transform, pdf.x, pdf.y);
    }

    hit(event, nearest = false) {
        const position = this.coordinate(event);
        if (!position) return null;
        let best = null;
        let distance = Infinity;
        for (const item of this.source.items) {
            const local = point(item.inverse, position.x, position.y);
            const dx = Math.max(0, -local.x, local.x - item.width);
            const dy = Math.max(0, item.bottom - local.y, local.y - item.top);
            const squared = dx * dx + dy * dy;
            if ((!nearest && squared > 0) || squared >= distance) continue;
            distance = squared;
            if (item.region) {
                best = { item, offset: local.x < item.width / 2 ? item.start : item.end };
                continue;
            }
            let glyph = item.glyphs[0];
            let glyphDistance = Infinity;
            for (const candidate of item.glyphs) {
                const delta = Math.max(0, candidate.x0 - local.x, local.x - candidate.x1);
                if (delta < glyphDistance) { glyph = candidate; glyphDistance = delta; }
            }
            const before = local.x < (glyph.x0 + glyph.x1) / 2;
            best = { item, glyph, offset: before !== glyph.rtl ? glyph.start : glyph.end };
        }
        return best;
    }

    mouseDown(event) {
        if (this.destroyed || event.button !== 0 || this.interactive(event.target)) return;
        const hit = this.hit(event);
        if (!hit) { this.clear(); return; }
        event.preventDefault();
        this.viewer.viewport.focus({ preventScroll: true });
        this.drag = hit;
        if (hit.item.region) {
            this.anchor = hit.item.start;
            this.focus = hit.item.end;
        } else {
            this.anchor = event.shiftKey ? this.anchor : hit.offset;
            this.focus = hit.offset;
        }
        this.layout();
    }

    mouseMove(event) {
        if (this.destroyed || !this.drag) return;
        const hit = this.hit(event, true);
        if (!hit) return;
        event.preventDefault();
        if (this.drag.item.region) {
            this.anchor = hit.item.start < this.drag.item.start ? this.drag.item.end : this.drag.item.start;
            this.focus = hit.item.start < this.drag.item.start ? hit.item.start : hit.item.end;
        } else this.focus = hit.offset;
        this.layout();
    }

    doubleClick(event) {
        if (this.destroyed || event.button !== 0 || this.interactive(event.target)) return;
        const hit = this.hit(event);
        if (!hit) return;
        event.preventDefault();
        this.drag = null;
        if (hit.item.region) {
            this.anchor = hit.item.start;
            this.focus = hit.item.end;
        } else {
            const index = hit.glyph.start;
            const text = this.source.text;
            const word = words ? Array.from(words.segment(text)).find(part => index >= part.index && index < part.index + part.segment.length) : null;
            if (word) { this.anchor = word.index; this.focus = word.index + word.segment.length; }
            else {
                let left = index;
                let right = hit.glyph.end;
                while (left > 0 && !/\s/u.test(text[left - 1])) left--;
                while (right < text.length && !/\s/u.test(text[right])) right++;
                this.anchor = left;
                this.focus = right;
            }
        }
        this.layout();
    }

    keyDown(event) {
        if (this.destroyed || this.interactive(event.target)) return;
        if (event.key === 'Escape') {
            this.clear();
            event.preventDefault();
            event.stopPropagation();
        } else if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === 'a') {
                this.anchor = 0;
                this.focus = this.source.text.length;
                this.layout();
                event.preventDefault();
                event.stopPropagation();
            } else if (key === 'c' && this.selectedText) {
                // Do not cancel the browser's real copy command. Capture stops
                // reader shortcuts while its subsequent copy event writes data.
                event.stopPropagation();
            }
        }
    }

    copyEvent(event) {
        if (this.destroyed || !event.clipboardData ||
            (!this.copyRequested && (!this.viewer.viewport.contains(this.document.activeElement) ||
                this.interactive(this.document.activeElement)))) return;
        const text = this.selectedText;
        if (!text) return;
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopPropagation();
        this.copyWritten = true;
    }

    copy() {
        if (this.destroyed || !this.selectedText || typeof this.document.execCommand !== 'function') return false;
        this.copyRequested = true;
        this.copyWritten = false;
        try {
            this.document.execCommand('copy');
            return this.copyWritten;
        } catch { return false; }
        finally { this.copyRequested = false; }
    }

    layout() {
        if (this.destroyed) return;
        const viewport = this.viewer.pageViewport;
        if (!viewport) return;
        const start = Math.min(this.anchor, this.focus);
        const end = Math.max(this.anchor, this.focus);
        const drawn = this.drawn;
        if (drawn && drawn.source === this.source && drawn.start === start && drawn.end === end &&
            viewport.transform.every((value, index) => value === drawn.transform[index])) return;
        this.drawn = { source: this.source, start, end, transform: viewport.transform.slice() };
        if (start === end) { this.layer.replaceChildren(); return; }
        const inv = inverse(this.viewer.base.transform);
        if (!inv) return;
        const delta = multiply(viewport.transform, inv);
        const fragment = this.document.createDocumentFragment();
        for (const item of this.source.items) {
            if (item.end <= start || item.start >= end) continue;
            let ranges;
            if (item.region) ranges = [[0, item.width]];
            else {
                ranges = [];
                for (const glyph of item.glyphs) {
                    if (glyph.end <= start || glyph.start >= end) continue;
                    const previous = ranges.at(-1);
                    if (previous && Math.abs(previous[1] - glyph.x0) < 1e-6) previous[1] = glyph.x1;
                    else ranges.push([glyph.x0, glyph.x1]);
                }
            }
            const matrix = multiply(delta, item.matrix);
            for (const [left, right] of ranges) {
                if (right <= left) continue;
                const origin = point(matrix, left, item.bottom);
                const highlight = this.document.createElement('div');
                highlight.className = 'pdf-source-selection-highlight';
                Object.assign(highlight.style, {
                    left: origin.x + 'px', top: origin.y + 'px', width: (right - left) + 'px',
                    height: (item.top - item.bottom) + 'px',
                    transform: `matrix(${matrix[0]},${matrix[1]},${matrix[2]},${matrix[3]},0,0)`
                });
                fragment.appendChild(highlight);
            }
        }
        this.layer.replaceChildren(fragment);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const remove of this.listeners) remove();
        this.listeners.length = 0;
        this.layer.remove();
        this.drag = this.ocr = this.drawn = null;
        this.source = this.native = { text: '', items: [] };
        this.anchor = this.focus = 0;
    }
}
