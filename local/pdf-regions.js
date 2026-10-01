'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { blockGeometry } = require('../hosting/public/pdf-layout-core.mjs');

const CAPTION = /^(?:Figure|Fig\.|Şekil|Sekil)\s*\d+(?:[.\-]\d+)*\s*[:：]/iu;
const EQUATION_LABEL = /\((\d+(?:\.\d+)*)\)\s*[,.;]?$/u;
// OCR can confuse an assignment arrow with a dash, plus, or guillemet.
// These are crop-location hints only; the source recognizer determines LaTeX.
const OPERATOR = /^(?:[=+−–—\-*/<>≤≥|←→⇐⇒«»]+|\d[\d.,…]*|[=+−–—\-←→«»<>]+\d[\d.,…]*)$/u;
const ASSIGNMENT = /^[A-Za-z](?:[\p{L}\d_]*[)\]]|\([^)]*\)|[_\d]*)\s*[=+−–—\-←⇐«<>]/u;
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function bounded(box, width, height, padding = 0) {
    return { x0: Math.max(0, Math.floor(box.x0 - padding)), y0: Math.max(0, Math.floor(box.y0 - padding)),
        x1: Math.min(width, Math.ceil(box.x1 + padding)), y1: Math.min(height, Math.ceil(box.y1 + padding)) };
}

function prose(block) {
    const words = block.text.match(/[\p{L}]{3,}/gu) || [];
    return words.length >= 10 && words.join('').length / Math.max(1, block.text.replace(/\s/gu, '').length) > 0.64;
}

// Projection is restricted to the whitespace-separated source interval, not to
// OCR's graphic labels: faint distributions and axes may have no OCR boxes.
function inkBounds(pixels, width, height, box) {
    const search = bounded(box, width, height);
    let x0 = search.x1, y0 = search.y1, x1 = search.x0, y1 = search.y0;
    for (let y = search.y0; y < search.y1; y += 1) {
        for (let x = search.x0; x < search.x1; x += 1) {
            const offset = (y * width + x) * 4;
            if (Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 235 && pixels[offset + 3] > 0) {
                x0 = Math.min(x0, x); y0 = Math.min(y0, y);
                x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
            }
        }
    }
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

function tokensForLine(line) {
    const tokens = [];
    for (const part of line.parts) {
        const raw = part.text.trim();
        if (!part.bbox || !raw) continue;
        for (const match of raw.matchAll(/\S+/gu)) {
            let bbox;
            const symbols = part.symbols || [];
            if (symbols.length && symbols.map(symbol => symbol.text).join('') === raw) {
                const selected = symbols.slice(match.index, match.index + match[0].length).filter(symbol => symbol.bbox);
                bbox = selected.reduce((box, symbol) => box ? union(box, symbol.bbox) : symbol.bbox, null);
            }
            if (!bbox) {
                const span = part.bbox.x1 - part.bbox.x0;
                bbox = { ...part.bbox, x0: part.bbox.x0 + span * match.index / raw.length,
                    x1: part.bbox.x0 + span * (match.index + match[0].length) / raw.length };
            }
            tokens.push({ text: match[0], gap: match.index > 0 || /^\s/u.test(part.text) ? ' ' : '',
                bbox, size: part.size, symbols: part.symbols,
                mathFont: /math|symbol|cmmi|cmsy|cmex|msam|msbm/iu.test(`${part.fontName || ''} ${part.fontFamily || ''}`) });
        }
    }
    return tokens;
}

function isNotation(token) {
    const text = token.text.replace(/[,.;:]$/u, '');
    return token.mathFont || /[α-ωΑ-Ωϵϑϕ∑∏∫√∞≤≥≠≈∈ℝℕ¢£©]/u.test(text) ||
        /^[A-Za-z][A-Za-z_*+;:.\d-]*\([^)]*\)/u.test(text) || /^[A-Za-z][A-Za-z\d_]{0,2}\)$/u.test(text) || /[_^]/u.test(text) ||
        /^(?:arg\s*max|argmax|log|exp|sin|cos)\b/u.test(text);
}

function mathSpans(line) {
    const tokens = tokensForLine(line);
    const selected = new Set();
    const prefix = new Map();
    tokens.forEach((token, index) => {
        if (/^[εϵeEk]-?(?:greedy|armed)\b/iu.test(token.text)) {
            // The prose suffix remains selectable; only the source variable is math.
            prefix.set(index, 1);
            selected.add(index);
        } else if (isNotation(token)) selected.add(index);
        else if (/^[A-Za-z]$/u.test(token.text.replace(/[,.;]$/u, ''))) {
            const before = tokens.slice(Math.max(0, index - 3), index).map(item => item.text).join(' ');
            const after = tokens[index + 1] && tokens[index + 1].text;
            if (OPERATOR.test(after || '') ||
                /(?:action|step|reward|variable|probability|denoted|prior to)\s*$/iu.test(before) && !/^a$/u.test(token.text) ||
                /action\s*$/iu.test(before) && /^a[,.;]?$/u.test(token.text)) selected.add(index);
        }
    });
    // Grow notation only across operators/operands, never through prose words.
    for (const index of [...selected]) {
        if (prefix.has(index)) continue;
        let end = index;
        while (end + 1 < tokens.length && (OPERATOR.test(tokens[end + 1].text) ||
            isNotation(tokens[end + 1]) || /^(?:[A-Za-z][,.;]?|\([^)]*\))$/u.test(tokens[end + 1].text))) {
            const next = tokens[end + 1];
            if (/^[A-Za-z][,.;]?$/u.test(next.text) && !OPERATOR.test(tokens[end].text)) break;
            selected.add(++end);
        }
        let start = index;
        while (start > 0 && OPERATOR.test(tokens[start - 1].text)) selected.add(--start);
    }
    const spans = [];
    for (let index = 0; index < tokens.length; index += 1) {
        if (!selected.has(index)) continue;
        const first = index;
        let bbox = tokens[index].bbox;
        if (prefix.has(index)) {
            const token = tokens[index];
            const symbol = (token.symbols || []).find(item => item.text === token.text[0] && item.bbox);
            bbox = symbol ? symbol.bbox : { ...bbox, x1: bbox.x0 + (bbox.x1 - bbox.x0) / token.text.length };
            const neighbor = symbol && token.symbols[token.symbols.indexOf(symbol) + 1];
            const right = neighbor?.bbox?.x0 ?? bbox.x1;
            spans.push({ text: token.text.slice(0, 1), anchor: token.text, bbox, right, size: token.size });
            continue;
        }
        while (index + 1 < tokens.length && selected.has(index + 1) && !prefix.has(index + 1)) bbox = union(bbox, tokens[++index].bbox);
        let text = tokens.slice(first, index + 1).map((token, offset) => `${offset ? token.gap : ''}${token.text}`).join('');
        let right;
        // Sentence punctuation belongs to the prose, not to the formula recognizer.
        if (/[,.;]$/u.test(text) && !/\.\.\.$/u.test(text)) {
            text = text.slice(0, -1);
            const last = tokens[index];
            const symbol = (last.symbols || []).slice(-1)[0];
            if (symbol && symbol.bbox && symbol.bbox.x0 > bbox.x0) {
                right = symbol.bbox.x0;
                bbox = { ...bbox, x1: right };
            }
        }
        if (text) spans.push({ text, bbox, right, size: tokens[first].size });
    }
    return spans;
}

function detectRegions(blocks, { pixels, width, height }) {
    const geometries = blocks.map(block => blockGeometry(block));
    const references = geometries.filter(Boolean).map(geometry => geometry.reference).sort((a, b) => a - b);
    const reference = references[Math.floor(references.length / 2)] || 16;
    const figures = [];
    blocks.forEach((caption, index) => {
        if (!CAPTION.test(caption.text)) return;
        const previous = blocks.slice(0, index).reverse().find(block => block.bbox.y1 < caption.bbox.y0 && prose(block) && !CAPTION.test(block.text));
        const top = previous ? previous.bbox.y1 + 3 : Math.max(0, caption.bbox.y0 - height * 0.65);
        const bottom = caption.bbox.y0 - 3;
        if (bottom - top < reference * 4) return;
        const search = { x0: 0, y0: top, x1: width, y1: bottom };
        const ink = inkBounds(pixels, width, height, search);
        if (!ink || ink.y1 - ink.y0 < reference * 3) return;
        const bbox = bounded(ink, width, height, 5);
        bbox.y0 = Math.max(bbox.y0, Math.ceil(top));
        bbox.y1 = Math.min(bbox.y1, Math.floor(bottom));
        figures.push({ kind: 'figure', bbox, captionIndex: index,
            remove: blocks.map((block, n) => n < index && n !== blocks.indexOf(previous) && overlaps(block.bbox, search) ? n : -1).filter(n => n >= 0),
            alt: caption.text.match(CAPTION)[0].replace(/[:：]$/u, '').trim() });
    });
    const removed = new Set(figures.flatMap(figure => figure.remove));
    const displays = [];
    const left = Math.min(...blocks.filter(prose).map(block => block.bbox.x0), width * 0.15);
    const verticalGap = (a, b) => Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
    blocks.forEach((block, index) => {
        if (removed.has(index) || CAPTION.test(block.text) || displays.some(display => display.indices.includes(index))) return;
        const labelMatch = block.text.match(EQUATION_LABEL);
        const hasOperator = /[=∑∫←→⇐⇒<>+−–—«|]|argmax/u.test(block.text);
        const notation = (geometries[index]?.lines || []).some(line => tokensForLine(line).some(isNotation));
        const words = block.text.split(/\s+/u).filter(word => /^[\p{L}]{3,}[,;:]?$/u.test(word));
        const compactFormula = words.length < 2 || ASSIGNMENT.test(block.text) ||
            (notation && /^[A-Za-z]\w?\s*\|/u.test(block.text));
        const indentedFormula = !prose(block) && compactFormula && block.bbox.x0 > left + reference * 1.5 && hasOperator;
        const numberedFormula = labelMatch && hasOperator && (!prose(block) ||
            (geometries[index]?.lines.length <= 2 && block.bbox.x0 > left + reference * 1.5));
        if (!numberedFormula && !indentedFormula) return;
        let bbox = block.bbox;
        const indices = [index];
        // Fractions and limits are often split into overlapping OCR paragraphs.
        blocks.forEach((other, n) => {
            if (n === index || removed.has(n) || CAPTION.test(other.text) ||
                displays.some(display => display.indices.includes(n))) return;
            const sameRow = other.bbox.y0 < bbox.y1 && other.bbox.y1 > bbox.y0;
            const detachedLabel = sameRow && other.bbox.x0 > width * 0.6 &&
                /^\(\d+(?:\.\d+)*\)\s*[,.;]?$/u.test(other.text.trim());
            const overlapY = sameRow && other.bbox.x0 < bbox.x1 && other.bbox.x1 > bbox.x0 && !prose(other);
            const smallIndices = /^(?:[A-Za-z]+\s*=\s*\d+\s*)+$/u.test(other.text) &&
                geometries[n]?.lines.every(line => line.size < reference * 0.9);
            const limitGap = verticalGap(other.bbox, block.bbox);
            const nearerEquation = blocks.some((candidate, m) => m !== index && m !== n && !prose(candidate) &&
                /[=∑∫←⇐]/u.test(candidate.text) &&
                other.bbox.x0 >= candidate.bbox.x0 - reference && other.bbox.x1 <= candidate.bbox.x1 + reference &&
                verticalGap(other.bbox, candidate.bbox) < limitGap);
            const nearbyLimit = !prose(other) && (other.text.trim().length < 6 || smallIndices) &&
                limitGap < reference * 1.8 && !nearerEquation &&
                other.bbox.x0 >= block.bbox.x0 - reference && other.bbox.x1 <= block.bbox.x1 + reference;
            if (overlapY || detachedLabel || nearbyLimit) { indices.push(n); bbox = union(bbox, other.bbox); }
        });
        let label;
        const groupedLabel = labelMatch || indices.map(n => blocks[n].text.match(EQUATION_LABEL)).find(Boolean);
        if (groupedLabel) {
            label = `(${groupedLabel[1]})`;
            const allTokens = indices.flatMap(n => (geometries[n]?.lines || []).flatMap(tokensForLine));
            const number = allTokens.find(token => token.text.includes(label) && token.bbox.x0 > width * 0.6);
            if (number) bbox = { ...bbox, x1: Math.min(bbox.x1, number.bbox.x0 - reference * 0.5) };
        }
        // Project away the now-excluded number and retain actual fraction/limit ink.
        const search = bounded(bbox, width, height, Math.ceil(reference * 0.4));
        if (label) search.x1 = Math.min(search.x1, Math.floor(bbox.x1));
        // Padding must not introduce ink from the preceding/following equation.
        // OCR boxes already include the grouped fraction and detached limits.
        let top = 0, bottom = height;
        blocks.forEach((other, n) => {
            if (indices.includes(n) || removed.has(n) || other.bbox.x0 >= bbox.x1 || other.bbox.x1 <= bbox.x0) return;
            if (other.bbox.y1 <= bbox.y0) top = Math.max(top, Math.ceil((other.bbox.y1 + bbox.y0) / 2));
            if (other.bbox.y0 >= bbox.y1) bottom = Math.min(bottom, Math.floor((other.bbox.y0 + bbox.y1) / 2));
        });
        search.y0 = Math.max(search.y0, top);
        search.y1 = Math.min(search.y1, bottom);
        const ink = inkBounds(pixels, width, height, search);
        if (ink) bbox = { ...bounded(ink, width, height, 4), y0: Math.max(top, ink.y0 - 4), y1: Math.min(bottom, ink.y1 + 4) };
        displays.push({ kind: 'math', display: true, bbox, label, indices: indices.sort((a, b) => a - b) });
    });
    const displayIndices = new Set(displays.flatMap(display => display.indices));
    const inline = [];
    blocks.forEach((block, index) => {
        if (removed.has(index) || displayIndices.has(index)) return;
        let cursor = 0;
        for (const line of geometries[index]?.lines || []) {
            const rowText = line.parts.map(part => part.text).join('').replace(/\s+/gu, ' ').trim();
            const rowStart = block.text.indexOf(rowText.slice(0, Math.min(24, rowText.length)), cursor);
            if (rowStart >= 0) cursor = rowStart;
            for (const span of mathSpans(line)) {
                const start = block.text.indexOf(span.anchor || span.text, cursor);
                if (start < 0) continue;
                const end = start + span.text.length;
                const bbox = bounded(span.bbox, width, height, 3);
                if (span.right !== undefined) bbox.x1 = Math.min(bbox.x1, span.right);
                inline.push({ kind: 'math', display: false, bbox, index, start, end,
                    fontScale: Math.round(span.size / geometries[index].reference * 1000) / 1000 });
                cursor = end;
            }
            if (rowStart >= 0) cursor = Math.max(cursor, rowStart + rowText.length - 1);
        }
    });
    return { figures, displays, inline };
}

function cropBuffer(source, bbox) {
    const canvas = createCanvas(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
    canvas.getContext('2d').drawImage(source, bbox.x0, bbox.y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const buffer = canvas.toBuffer('image/png');
    canvas.width = 0; canvas.height = 0;
    return buffer;
}

function replaceInline(block, regions) {
    const runs = [];
    let cursor = 0;
    const textRuns = block.runs.filter(run => run.type === 'text');
    function appendText(start, end) {
        let offset = 0;
        for (const run of textRuns) {
            const from = Math.max(start, offset), to = Math.min(end, offset + run.text.length);
            if (to > from) runs.push({ ...run, text: run.text.slice(from - offset, to - offset) });
            offset += run.text.length;
        }
    }
    for (const region of regions.sort((a, b) => a.start - b.start)) {
        if (region.start < cursor) continue;
        appendText(cursor, region.start);
        runs.push({ type: 'math', latex: region.latex, display: false, fontScale: region.fontScale });
        cursor = region.end;
    }
    appendText(cursor, block.text.length);
    return { ...block, runs, text: runs.filter(run => run.type === 'text').map(run => run.text).join('') };
}

async function processRegions({ blocks, imageBuffer, width, height, cacheDirectory, imagePrefix, renderRegion, recognizeMath }) {
    if (!/^\/uploads\/pdf\/[A-Za-z0-9_-]{1,128}\/page-[1-9]\d*-v[1-9]\d*$/.test(imagePrefix)) {
        throw new Error('Invalid source-region image prefix.');
    }
    const source = await loadImage(imageBuffer);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0);
    const regions = detectRegions(blocks, { pixels: context.getImageData(0, 0, width, height).data, width, height });
    canvas.width = 0; canvas.height = 0;
    let regionNumber = 0;
    const figures = new Map();
    for (const region of regions.figures) {
        const filename = `${path.basename(imagePrefix)}-region-${++regionNumber}.png`;
        const crop = cropBuffer(source, region.bbox);
        const destination = path.join(cacheDirectory, filename);
        const temporary = `${destination}.${process.pid}.tmp`;
        try {
            await fs.promises.writeFile(temporary, crop);
            await fs.promises.rename(temporary, destination);
        } finally { await fs.promises.rm(temporary, { force: true }); }
        figures.set(region.captionIndex, { type: 'image', kind: 'figure', imageUrl: `${imagePrefix}-region-${regionNumber}.png`,
            width: region.bbox.x1 - region.bbox.x0, height: region.bbox.y1 - region.bbox.y0, bbox: region.bbox, alt: region.alt });
    }
    for (const region of [...regions.displays, ...regions.inline]) {
        if (typeof recognizeMath !== 'function') throw new Error('Formula recognition is unavailable. A source-math recognizer is required.');
        const windowImage = renderRegion ? await renderRegion({ ...region, kind: 'formula' }) : cropBuffer(source, region.bbox);
        const latex = await recognizeMath({ imageBuffer: windowImage, bbox: region.bbox, display: region.display });
        if (typeof latex !== 'string' || !latex.trim()) throw new Error('Formula recognition returned an empty equation.');
        region.latex = latex.trim();
    }
    const removed = new Set([...regions.figures.flatMap(region => region.remove), ...regions.displays.flatMap(region => region.indices)]);
    const displayAt = new Map(regions.displays.map(region => [Math.min(...region.indices), region]));
    const result = [];
    blocks.forEach((block, index) => {
        if (figures.has(index)) result.push(figures.get(index));
        if (displayAt.has(index)) {
            const region = displayAt.get(index);
            result.push({ type: 'math', latex: region.latex, display: true, bbox: region.bbox,
                ...(region.label ? { label: region.label } : {}) });
        }
        if (!removed.has(index)) result.push(replaceInline(block, regions.inline.filter(region => region.index === index)));
    });
    return result;
}

module.exports = { detectRegions, processRegions };
