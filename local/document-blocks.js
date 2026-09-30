'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const katex = require('katex');
const { blocksText, validBlocks } = require('./pdf-layout');

function escaped(content, index) {
    let slashes = 0;
    while (index > 0 && content[--index] === '\\') slashes += 1;
    return slashes % 2 === 1;
}

function closingDelimiter(content, start, delimiter) {
    let index = content.indexOf(delimiter, start);
    while (index !== -1) {
        if (!escaped(content, index) && (delimiter !== '$' || content[index + 1] !== '$' && content[index - 1] !== '$')) return index;
        index = content.indexOf(delimiter, index + delimiter.length);
    }
    return -1;
}

function mathDelimiter(content, index) {
    if (escaped(content, index)) return null;
    if (content.startsWith('$$', index)) return { open: '$$', close: '$$', display: true };
    if (content.startsWith('\\[', index)) return { open: '\\[', close: '\\]', display: true };
    if (content.startsWith('\\(', index)) return { open: '\\(', close: '\\)', display: false };
    if (content[index] === '$' && content[index - 1] !== '$') return { open: '$', close: '$', display: false };
    return null;
}

function dollarIsText(content, start, end) {
    const body = content.slice(start + 1, end).trim();
    // Currency followed by prose and another price is not a math envelope.
    // GLM deliberately pads real formulas with spaces, so whitespace alone
    // cannot distinguish "$ \\frac{1}{n} $" from literal dollar amounts.
    return /^\d[\d,.]*(?:[;:]?[ \t]+[A-Za-z][^\\_^{}=+*/<>]*)$/u.test(body) ||
        /^\d/u.test(body) && /^\s*\d/u.test(content.slice(end + 1)) ||
        /\n\s*\n/u.test(body);
}

function sourceMathSpans(region) {
    const content = region.content;
    const spans = new Map();
    for (let index = 0; index < content.length;) {
        if ((index === 0 || content[index - 1] === '\n') && content.startsWith('```', index)) {
            const opener = content.indexOf('\n', index);
            const end = opener === -1 ? -1 : content.indexOf('\n```', opener + 1);
            if (end === -1) throw new Error('The document model returned an unterminated code fence.');
            if (region.layoutLabel === 'algorithm') {
                for (const [start, finish] of sourceMathSpans({ ...region, content: content.slice(opener + 1, end) })) {
                    spans.set(opener + 1 + start, opener + 1 + finish);
                }
            }
            index = end + 4;
            continue;
        }
        const delimiter = mathDelimiter(content, index);
        if (!delimiter) { index += 1; continue; }
        const end = closingDelimiter(content, index + delimiter.open.length, delimiter.close);
        if (end === -1 || delimiter.open === '$' && dollarIsText(content, index, end)) { index += 1; continue; }
        if (content.slice(index + delimiter.open.length, end).trim()) spans.set(index, end + delimiter.close.length);
        index = end + delimiter.close.length;
    }
    return spans;
}

function checkedLatex(content, display, proseContext = false) {
    let latex = content.trim();
    if (proseContext) {
        // GLM sometimes puts prose inside \mathrm, where TeX drops word spaces.
        // Preserve those source words in algorithm instructions. Single-letter
        // products and math commands retain their original mathematical meaning.
        latex = latex.replace(/\\mathrm\{(\p{L}+(?:[ \t]+\p{L}+)+)\}([ \t]*)/gu, (macro, words, gap) =>
            words.split(/[ \t]+/u).filter(word => /\p{L}{2}/u.test(word)).length >= 2 ? `\\text{${words}${gap}}` : macro);
    }
    if (!latex) throw new Error('The document model returned an empty formula.');
    try {
        katex.renderToString(latex, { displayMode: display, throwOnError: true, trust: false });
    } catch (error) {
        throw new Error(`The document model returned an unrenderable formula: ${error.message}`);
    }
    return latex;
}

function equation(content, bbox, label) {
    let latex = content.trim();
    const tag = latex.match(/\\tag\*?\{([^{}]+)\}\s*$/u);
    if (tag) {
        label = label || `(${tag[1]})`;
        latex = latex.slice(0, tag.index).trim();
    }
    return { type: 'math', display: true, latex: checkedLatex(latex, true), bbox, ...(label ? { label } : {}) };
}

function formula(region, bbox) {
    let content = region.content.trim();
    let label = region.label;
    const wrapper = content.match(/^(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$([^$]*?)\$)\s*(\(\d+(?:\.\d+)*\))?$/u);
    if (wrapper) {
        content = wrapper[1] ?? wrapper[2] ?? wrapper[3] ?? wrapper[4];
        label = label || wrapper[5];
    }
    return equation(content, bbox, label);
}

function spliceInlineMath(region, width, height) {
    if (region.inlineMath === undefined) return region.content;
    if (region.kind !== 'text' || !Array.isArray(region.inlineMath)) throw new Error('Invalid inline formula annotations.');
    const sourceSpans = sourceMathSpans(region);
    let content = '';
    let previousEnd = 0;
    let previousBox;
    for (const span of region.inlineMath) {
        const box = span?.bbox;
        if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
            span.start < previousEnd || span.end <= span.start || span.end > region.content.length ||
            typeof span.latex !== 'string' || !box ||
            !['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(box[key]) && box[key] >= 0) ||
            box.x1 <= box.x0 || box.y1 <= box.y0 || box.x1 > width || box.y1 > height ||
            box.x0 < region.bbox.x0 || box.y0 < region.bbox.y0 ||
            box.x1 > region.bbox.x1 || box.y1 > region.bbox.y1) {
            throw new Error('Invalid inline formula annotation boundaries.');
        }
        if (sourceSpans.get(span.start) !== span.end) {
            throw new Error('The inline formula annotation does not match an exact source math span.');
        }
        if (previousBox) {
            const overlap = Math.min(box.y1, previousBox.y1) - Math.max(box.y0, previousBox.y0);
            const sameLine = overlap >= Math.min(box.y1 - box.y0, previousBox.y1 - previousBox.y0) * 0.5;
            if (sameLine ? box.x0 < previousBox.x1 :
                box.y0 + box.y1 <= previousBox.y0 + previousBox.y1) {
                throw new Error('Inline formula source regions are not in reading order.');
            }
        }
        const latex = checkedLatex(span.latex, false, region.layoutLabel === 'algorithm');
        content += region.content.slice(previousEnd, span.start) + '\\(' + latex + '\\)';
        previousEnd = span.end;
        previousBox = box;
    }
    return content + region.content.slice(previousEnd);
}

function textBlocks(region, bbox) {
    const content = region.content.replace(/\r\n?/gu, '\n');
    const fontScale = region.fontScale ?? 1;
    const blocks = [];
    let runs = [];
    let plain = '';
    function appendPlain() {
        if (!plain) return;
        const previous = runs[runs.length - 1];
        if (previous?.type === 'text') previous.text += plain;
        else runs.push({ type: 'text', text: plain, fontScale });
        plain = '';
    }
    function flush() {
        appendPlain();
        if (runs.length && runs.some(run => run.type === 'math' || run.text.trim())) {
            blocks.push({ type: 'text', text: runs.filter(run => run.type === 'text').map(run => run.text).join(''), bbox, runs });
        }
        runs = [];
    }
    for (let index = 0; index < content.length;) {
        // Fences preserve literal code. A layout-classified source algorithm is
        // pseudocode instead, so its recognized math remains selectable LaTeX.
        if ((index === 0 || content[index - 1] === '\n') && content.startsWith('```', index)) {
            const opener = content.indexOf('\n', index);
            if (opener === -1) throw new Error('The document model returned an unterminated code fence.');
            const end = content.indexOf('\n```', opener + 1);
            if (end === -1) throw new Error('The document model returned an unterminated code fence.');
            flush();
            const fenced = content.slice(opener + 1, end);
            if (region.layoutLabel === 'algorithm') blocks.push(...textBlocks({ ...region, content: fenced }, bbox));
            else { plain = fenced; flush(); }
            index = end + 4;
            continue;
        }
        if (content.startsWith('\n\n', index)) {
            flush();
            while (content[index] === '\n') index += 1;
            continue;
        }
        if (index === 0 || content[index - 1] === '\n') {
            const heading = content.slice(index).match(/^#{1,6}[ \t]+/u);
            if (heading) { index += heading[0].length; continue; }
        }
        if (content.startsWith('\\$', index) && !escaped(content, index)) {
            plain += '$';
            index += 2;
            continue;
        }
        const delimiter = mathDelimiter(content, index);
        const { open, close, display } = delimiter || {};
        if (!open) { plain += content[index++]; continue; }
        const end = closingDelimiter(content, index + open.length, close);
        // A lone dollar sign (prices, for example) is ordinary source text.
        if (end === -1 && open === '$' && !/^\s*\\[A-Za-z]/u.test(content.slice(index + 1))) {
            plain += content[index++];
            continue;
        }
        if (end === -1) throw new Error(`The document model returned unterminated math (${open}).`);
        const body = content.slice(index + open.length, end);
        // Ordinary prices must not swallow a later, whitespace-padded formula.
        if (open === '$' && dollarIsText(content, index, end)) {
            plain += content[index++];
            continue;
        }
        index = end + close.length;
        if (display && region.layoutLabel !== 'algorithm') {
            flush();
            const trailingLabel = content.slice(index).match(/^[ \t]*(\(\d+(?:\.\d+)*\))/u);
            blocks.push(equation(body, bbox, trailingLabel?.[1] || region.label));
            if (trailingLabel) index += trailingLabel[0].length;
        } else {
            appendPlain();
            runs.push({ type: 'math', display: false, latex: checkedLatex(body, false, region.layoutLabel === 'algorithm'), fontScale });
        }
    }
    flush();
    return blocks;
}

function equationLabels(regions) {
    const labels = new Map();
    const consumed = new Set();
    for (const region of regions) {
        if (region.layoutLabel !== 'formula_number') continue;
        let number = region.content.trim();
        const wrapper = number.match(/^(?:\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\$([^$]*?)\$)$/u);
        if (wrapper) number = (wrapper[1] ?? wrapper[2] ?? wrapper[3]).trim();
        if (!/^(?:\(\d+(?:\.\d+)*\)|\d+(?:\.\d+)*)$/u.test(number)) continue;
        const box = region.bbox;
        const candidates = regions.filter(formula => {
            if (formula.kind !== 'formula' || labels.has(formula) || formula.label && formula.label !== number) return false;
            const target = formula.bbox;
            const overlap = Math.min(box.y1, target.y1) - Math.max(box.y0, target.y0);
            return box.x0 >= target.x1 &&
                overlap >= Math.min(box.y1 - box.y0, target.y1 - target.y0) * 0.5;
        });
        // Ambiguous layout stays visible as its original selectable number.
        if (candidates.length !== 1) continue;
        labels.set(candidates[0], number);
        consumed.add(region);
    }
    return { labels, consumed };
}

async function documentBlocks(result, context) {
    const { bookId, pageNumber, cacheDirectory, imageBuffer, width, height, imagePrefix } = context;
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(bookId) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error('Invalid document page identity.');
    }
    if (typeof imagePrefix !== 'string' ||
        !new RegExp(`^/uploads/pdf/${bookId}/page-${pageNumber}-v[1-9]\\d*$`, 'u').test(imagePrefix)) {
        throw new Error('Invalid versioned source image prefix.');
    }
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
        result?.width !== width || result?.height !== height || !Array.isArray(result.regions)) {
        throw new Error('The document model output does not match the source page dimensions.');
    }
    // Validate before associating labels or writing any source crops.
    const annotatedContent = new Map();
    for (const [index, region] of result.regions.entries()) {
        const bbox = region?.bbox;
        if (!['text', 'formula', 'figure', 'table'].includes(region?.kind) || typeof region.content !== 'string' ||
            !bbox || !['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(bbox[key]) && bbox[key] >= 0) ||
            bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0 || bbox.x1 > width || bbox.y1 > height ||
            region.fontScale !== undefined && (!Number.isFinite(region.fontScale) || region.fontScale <= 0) ||
            region.label !== undefined && typeof region.label !== 'string') {
            throw new Error(`Invalid document model region ${index + 1}.`);
        }
        if (region.inlineMath !== undefined) annotatedContent.set(region, spliceInlineMath(region, width, height));
    }
    const { labels, consumed } = equationLabels(result.regions);
    const blocks = [];
    let image;
    for (const [index, region] of result.regions.entries()) {
        if (consumed.has(region)) continue;
        const bbox = region.bbox;
        if (region.kind === 'text') blocks.push(...textBlocks(
            annotatedContent.has(region) ? { ...region, content: annotatedContent.get(region) } : region, { ...bbox }));
        else if (region.kind === 'formula') blocks.push(formula({ ...region, label: labels.get(region) || region.label }, { ...bbox }));
        else {
            // Tables retain source pixels: model HTML is never trusted or injected.
            if (!image) {
                image = await loadImage(imageBuffer);
                if (image.width !== width || image.height !== height) throw new Error('The source image dimensions changed.');
                await fs.mkdir(cacheDirectory, { recursive: true });
            }
            const crop = { x0: Math.floor(bbox.x0), y0: Math.floor(bbox.y0), x1: Math.ceil(bbox.x1), y1: Math.ceil(bbox.y1) };
            const cropWidth = crop.x1 - crop.x0, cropHeight = crop.y1 - crop.y0;
            const canvas = createCanvas(cropWidth, cropHeight);
            canvas.getContext('2d').drawImage(image, crop.x0, crop.y0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
            const filename = `${path.basename(imagePrefix)}-region-${index + 1}.png`;
            await fs.writeFile(path.join(cacheDirectory, filename), canvas.toBuffer('image/png'));
            blocks.push({ type: 'image', kind: 'figure', bbox: crop, width: cropWidth, height: cropHeight,
                imageUrl: `${imagePrefix}-region-${index + 1}.png`, alt: region.kind === 'table' ? 'Source table' : 'Source figure' });
        }
    }
    if (!validBlocks(blocks, blocksText(blocks))) throw new Error('The recognized document layout is invalid.');
    return blocks;
}

module.exports = { documentBlocks };
