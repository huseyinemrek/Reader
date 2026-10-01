const SFNT = 0x00010000;
const OPENTYPE = 0x4f54544f;
const TRUETYPE = 0x74727565;
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy']);

function familyName(view, offset, length) {
    if (length < 6) return undefined;
    const count = view.getUint16(offset + 2);
    const storage = view.getUint16(offset + 4);
    if (6 + count * 12 > length || storage > length) return undefined;
    let best;
    let score = -1;
    for (let index = 0; index < count; index += 1) {
        const record = offset + 6 + index * 12;
        const platform = view.getUint16(record);
        const encoding = view.getUint16(record + 2);
        const language = view.getUint16(record + 4);
        const id = view.getUint16(record + 6);
        const size = view.getUint16(record + 8);
        const start = storage + view.getUint16(record + 10);
        if (![1, 16].includes(id) || start + size > length) continue;
        const unicode = platform === 0 || platform === 3 && [0, 1, 10].includes(encoding);
        if (!unicode && !(platform === 1 && encoding === 0)) continue;
        if (unicode && size % 2) continue;
        let value = '';
        if (unicode) {
            for (let cursor = 0; cursor < size; cursor += 2) value += String.fromCharCode(view.getUint16(offset + start + cursor));
        } else {
            const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + start, size);
            value = new TextDecoder('macintosh').decode(bytes);
        }
        value = value.replace(/\u0000/gu, '').trim();
        if (!value || /[\u0000-\u001f]/u.test(value)) continue;
        const priority = (id === 16 ? 8 : 0) + (unicode ? 4 : 0) + (language === 0x409 || language === 0 ? 2 : 0);
        if (priority > score) {
            best = value;
            score = priority;
        }
    }
    return best;
}

function sourceFamily(name) {
    // Subset prefixes and face suffixes are part of the source font's identity,
    // not a family. SFNT family names take precedence over this name fallback.
    return name.replace(/^[A-Z]{6}\+/u, '').replace(/[-, ](?:(?:Extra|Ultra|Semi|Demi)?(?:Bold|Light)|Black|Heavy|Thin|Medium|Regular|Roman|Book|Italic|Oblique)(?:[-, ]?(?:Italic|Oblique))?(?:MT|PS)?$/iu, '').trim();
}

function cssFamily(family, fallback) {
    const generic = GENERIC_FAMILIES.has(fallback) ? fallback : undefined;
    if (!family) return generic;
    if (GENERIC_FAMILIES.has(family)) return family;
    const quoted = '"' + family.replace(/["\\]/gu, '\\$&').replace(/[\u0000-\u001f]/gu, '') + '"';
    return generic ? `${quoted}, ${generic}` : quoted;
}

/** Source typography only: absent metadata stays absent, never normal/400 by default. */
export function nativeFontStyle(font) {
    if (!font || typeof font !== 'object') return {};
    const name = typeof font.name === 'string' && font.name.trim() && !/^(?:g_d\d+_f|InvalidPDFjsFont_)/u.test(font.name)
        ? font.name.trim() : undefined;
    const css = font.cssFontInfo;
    let weight;
    let italic = false;
    let oblique = false;
    let knownStyle = false;
    let family;
    const data = font.data;
    // Reuse the native SFNT inspection. PDF.js retains repaired font tables;
    // CFF conversion synthesizes OS/2 weight 500, not a source weight.
    if (data instanceof Uint8Array && data.byteLength >= 12) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const signature = view.getUint32(0);
        const count = view.getUint16(4);
        if ([SFNT, OPENTYPE, TRUETYPE].includes(signature) && 12 + count * 16 <= data.byteLength) {
            const cff = signature === OPENTYPE;
            for (let index = 0; index < count; index += 1) {
                const record = 12 + index * 16;
                const tag = view.getUint32(record);
                const offset = view.getUint32(record + 8);
                const length = view.getUint32(record + 12);
                if (offset + length > data.byteLength) continue;
                if (tag === 0x4f532f32 && length >= 64) { // OS/2
                    const value = view.getUint16(offset + 4);
                    if (!cff && value >= 1 && value <= 1000) weight = value;
                    const selection = view.getUint16(offset + 62);
                    italic ||= !!(selection & 1);
                    oblique ||= !!(selection & 512);
                    knownStyle ||= !cff || !!(selection & (1 | 512));
                } else if (tag === 0x68656164 && length >= 46) { // head
                    italic ||= !!(view.getUint16(offset + 44) & 2);
                    knownStyle ||= !cff || italic;
                } else if (tag === 0x706f7374 && length >= 8) { // post
                    italic ||= view.getInt32(offset + 4) !== 0;
                    knownStyle ||= !cff || italic;
                } else if (tag === 0x6e616d65) { // name
                    family = familyName(view, offset, length);
                }
            }
        }
    }
    const cssWeight = Number(css?.fontWeight);
    if (css?.fontWeight !== undefined && cssWeight >= 1 && cssWeight <= 1000) weight = cssWeight;
    else if (css?.fontWeight === 'bold') weight = 700;
    else if (css?.fontWeight === 'normal') weight = 400;
    const faceName = (name || '').replace(/^[A-Z]{6}\+/u, '');
    const weightName = faceName.match(/(?:^|[-, ])((?:extra|ultra|semi|demi)?[ -]?(?:bold|light)|black|heavy|thin|medium|regular|roman|book)(?:[-, ]?(?:italic|oblique))?(?:MT|PS)?$/iu)?.[1].replace(/[ -]/gu, '').toLowerCase();
    if (weight === undefined) {
        if (font.black === true || ['black', 'heavy'].includes(weightName)) weight = 900;
        else if (['extrabold', 'ultrabold'].includes(weightName)) weight = 800;
        else if (['semibold', 'demibold'].includes(weightName)) weight = 600;
        else if (font.bold === true || weightName === 'bold') weight = 700;
        else if (['extralight', 'ultralight'].includes(weightName)) weight = 200;
        else if (weightName === 'light') weight = 300;
        else if (weightName === 'thin') weight = 100;
        else if (weightName === 'medium') weight = 500;
        else if (['regular', 'roman', 'book'].includes(weightName)) weight = 400;
    }
    const faceStyle = faceName.match(/(?:^|[-, ])(?:(?:Extra|Ultra|Semi|Demi)?[ -]?(?:Bold|Light)|Black|Heavy|Thin|Medium)?[-, ]?(Italic|Oblique)(?:MT|PS)?$/iu)?.[1].toLowerCase();
    if (!knownStyle) {
        oblique ||= faceStyle === 'oblique';
        italic ||= font.italic === true || faceStyle === 'italic';
        knownStyle = italic || oblique || ['regular', 'roman', 'book'].includes(weightName);
    }
    if (italic && faceStyle === 'oblique') oblique = true;
    const angle = css?.italicAngle !== undefined && css.italicAngle !== null && css.italicAngle !== ''
        ? Number(css.italicAngle) : NaN;
    oblique ||= Number.isFinite(angle) && angle !== 0;
    knownStyle ||= Number.isFinite(angle);
    // Standard PDF face identities define weight/style even without SFNT data.
    const standardName = name?.replace(/^[A-Z]{6}\+/u, '');
    if (/^(?:(?:Helvetica|Courier)(?:-Bold|-Oblique|-BoldOblique)?|Times-(?:Roman|Bold|Italic|BoldItalic)|Symbol|ZapfDingbats)$/u.test(standardName || '')) {
        weight ??= /Bold/u.test(standardName) ? 700 : 400;
        knownStyle = true;
    }
    const explicitFamily = typeof css?.fontFamily === 'string' && css.fontFamily.trim() ? css.fontFamily.trim() : undefined;
    const fontFamily = cssFamily(explicitFamily || (family ? family.replace(/^[A-Z]{6}\+/u, '') : name ? sourceFamily(name) : undefined), font.fallbackName);
    const result = {};
    if (name) result.sourceFontName = name;
    if (fontFamily) result.fontFamily = fontFamily;
    if (knownStyle) result.fontStyle = oblique ? 'oblique' : italic ? 'italic' : 'normal';
    if (weight !== undefined) result.fontWeight = weight;
    return result;
}

/** Read genuine per-font metadata; no canvas, OCR, server, or font-name stand-ins. */
export async function nativeTextContent(page) {
    const content = await page.getTextContent();
    const names = [...new Set(content.items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => item.fontName))];
    if (!names.length) return content;
    // Fonts are loaded by operators; rendering a source page is unnecessary.
    await page.getOperatorList();
    await Promise.all(names.map(async name => {
        const font = await new Promise(resolve => page.commonObjs.get(name, resolve));
        if (font) content.styles[name] = { ...content.styles[name], ...nativeFontStyle(font) };
    }));
    return content;
}
