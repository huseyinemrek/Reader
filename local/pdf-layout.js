'use strict';

// Geometry is processing-only: cached/client blocks contain the public contract,
// while region recognition can still address individual source glyphs.
const sourceLines = new WeakMap();

function median(samples) {
    if (!samples.length) return null;
    const sorted = samples.filter(sample => sample.value > 0 && sample.weight > 0).sort((a, b) => a.value - b.value);
    const halfway = sorted.reduce((sum, sample) => sum + sample.weight, 0) / 2;
    let weight = 0;
    for (const sample of sorted) {
        weight += sample.weight;
        if (weight >= halfway) return sample.value;
    }
    return null;
}

function union(a, b) {
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function clean(text) {
    return text.replace(/\s+/gu, ' ').trim();
}

function weight(text) {
    return Math.max(1, (text.match(/[\p{L}\p{N}]/gu) || []).length);
}

function nativeBlocks(content, viewport) {
    const lines = [];
    const matrix = viewport.transform;
    const point = (x, y) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] });
    let previousItem = null;
    for (const item of content.items) {
        if (typeof item.str !== 'string' || !clean(item.str)) continue;
        const t = item.transform;
        const size = Math.hypot(t[2], t[3]) * viewport.scale;
        if (!(size > 0)) continue;
        const origin = point(t[4], t[5]);
        const end = point(t[4] + item.width * t[0] / Math.hypot(t[0], t[1]), t[5] + item.width * t[1] / Math.hypot(t[0], t[1]));
        const up = { x: (matrix[0] * t[2] + matrix[2] * t[3]) / size, y: (matrix[1] * t[2] + matrix[3] * t[3]) / size };
        const style = (content.styles || {})[item.fontName] || {};
        const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.8;
        const corners = [origin, end].flatMap(p => [
            { x: p.x + up.x * size * ascent, y: p.y + up.y * size * ascent },
            { x: p.x - up.x * size * (1 - ascent), y: p.y - up.y * size * (1 - ascent) }
        ]);
        const bbox = { x0: Math.min(...corners.map(p => p.x)), y0: Math.min(...corners.map(p => p.y)), x1: Math.max(...corners.map(p => p.x)), y1: Math.max(...corners.map(p => p.y)) };
        let line = lines[lines.length - 1];
        const sameRow = line && !previousItem.hasEOL && Math.abs(line.baselineY - origin.y) <= Math.min(size, line.size) * 0.25 &&
            bbox.x0 >= line.bbox.x0 - size * 0.25 && bbox.x0 - line.bbox.x1 < Math.max(size, line.size) * 3;
        const text = clean(item.str);
        if (!sameRow) {
            line = { bbox, baselineY: origin.y, size, text: '', parts: [] };
            lines.push(line);
        }
        const needsSpace = line.parts.length && (bbox.x0 - line.bbox.x1 > size * 0.08 || /^\s/u.test(item.str) || /\s$/u.test(previousItem.str));
        const part = { text: `${needsSpace ? ' ' : ''}${text}`, size, bbox, fontName: style.sourceFontName || item.fontName,
            fontFamily: style.fontFamily || '' };
        line.parts.push(part);
        line.text += part.text;
        line.bbox = union(line.bbox, bbox);
        line.size = median(line.parts.map(run => ({ value: run.size, weight: weight(run.text) })));
        previousItem = item;
    }
    return layoutBlocks(lines);
}

function layoutBlocks(lines) {
    if (!lines.length) return [];
    const reference = median(lines.flatMap(line => line.parts.map(part => ({ value: part.size, weight: weight(part.text) }))));
    const spacings = [];
    for (let i = 1; i < lines.length; i += 1) {
        const before = lines[i - 1];
        const after = lines[i];
        const distance = after.baselineY - before.baselineY;
        if (Math.abs(after.size / before.size - 1) < 0.2 && distance > before.size && distance < before.size * 3 &&
            Math.abs(after.bbox.x0 - before.bbox.x0) < before.size * 3) {
            spacings.push({ value: distance / ((before.size + after.size) / 2), weight: Math.min(weight(before.text), weight(after.text)) });
        }
    }
    const leading = median(spacings) || 1.6;
    const groups = [];
    for (const line of lines) {
        const group = groups[groups.length - 1];
        const previous = group && group[group.length - 1];
        let merge = false;
        if (previous) {
            const size = (previous.size + line.size) / 2;
            const distance = line.baselineY - previous.baselineY;
            const left = Math.min(...group.map(row => row.bbox.x0));
            const right = Math.max(...group.map(row => row.bbox.x1));
            const width = right - left;
            const overlap = Math.min(right, line.bbox.x1) - Math.max(left, line.bbox.x0);
            const indented = line.bbox.x0 - left > size * 0.8;
            const previousShort = previous.bbox.x1 - previous.bbox.x0 < width * 0.85;
            merge = distance > size * 0.5 && distance <= leading * size * 1.22 &&
                Math.abs(line.size / previous.size - 1) < 0.25 && overlap > Math.min(width, line.bbox.x1 - line.bbox.x0) * 0.5 &&
                !indented && !previousShort;
        }
        if (merge) group.push(line);
        else groups.push([line]);
    }
    const vocabulary = new Set(lines.flatMap(line => clean(line.text).toLowerCase().match(/[\p{L}]+(?:-[\p{L}]+)*/gu) || []));
    return groups.map(group => {
        const runs = [];
        let bbox = group[0].bbox;
        const append = (text, size) => {
            if (!text) return;
            const fontScale = Math.round(size / reference * 1000) / 1000;
            const previous = runs[runs.length - 1];
            if (previous && previous.fontScale === fontScale) previous.text += text;
            else runs.push({ type: 'text', text, fontScale });
        };
        group.forEach((line, index) => {
            bbox = union(bbox, line.bbox);
            if (index) {
                const previous = runs[runs.length - 1];
                const ending = previous.text.match(/([\p{L}]+)([-\u00ad])$/u);
                const beginning = line.parts[0].text.match(/^([\p{Ll}]+)/u);
                if (ending && beginning) {
                    const joined = (ending[1] + beginning[1]).toLowerCase();
                    const compound = `${ending[1]}-${beginning[1]}`.toLowerCase();
                    if (ending[2] === '\u00ad' || vocabulary.has(joined) && !vocabulary.has(compound)) previous.text = previous.text.slice(0, -1);
                } else append(' ', line.size);
            }
            for (const part of line.parts) append(part.text, part.size);
        });
        const block = { type: 'text', text: runs.map(run => run.text).join(''), bbox, runs };
        sourceLines.set(block, { lines: group, reference });
        return block;
    });
}

function blocksText(blocks) {
    return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n');
}

function validBbox(box) {
    return box && ['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(box[key]) && box[key] >= 0) &&
        box.x1 > box.x0 && box.y1 > box.y0;
}

function validImage(image) {
    return image.kind === 'figure' && typeof image.alt === 'string' &&
        /^\/uploads\/pdf\/[A-Za-z0-9_-]{1,128}\/page-[1-9]\d*-v[1-9]\d*-region-[1-9]\d*\.png$/.test(image.imageUrl) &&
        Number.isSafeInteger(image.width) && image.width > 0 &&
        Number.isSafeInteger(image.height) && image.height > 0 && validBbox(image.bbox);
}

function validMath(math, display) {
    return math.type === 'math' && math.display === display &&
        typeof math.latex === 'string' && math.latex.trim().length > 0 &&
        (display ? validBbox(math.bbox) : Number.isFinite(math.fontScale) && math.fontScale > 0) &&
        (math.label === undefined || typeof math.label === 'string');
}

function validBlocks(blocks, text) {
    return Array.isArray(blocks) && blocks.every(block => {
        if (!block) return false;
        if (block.type === 'image') return validImage(block) && block.text === undefined && block.runs === undefined;
        if (block.type === 'math') return validMath(block, true) && block.text === undefined && block.runs === undefined;
        return block.type === 'text' && typeof block.text === 'string' && validBbox(block.bbox) &&
            Array.isArray(block.runs) && block.runs.length > 0 && block.runs.every(run =>
                run && (validMath(run, false) || run.type === 'text' && typeof run.text === 'string' &&
                    run.text.length > 0 && Number.isFinite(run.fontScale) && run.fontScale > 0)) &&
            block.runs.filter(run => run.type === 'text').map(run => run.text).join('') === block.text;
    }) && blocksText(blocks) === text;
}

function blockGeometry(block) {
    return sourceLines.get(block);
}

module.exports = { nativeBlocks, blocksText, validBlocks, blockGeometry };
