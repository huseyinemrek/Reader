// Browser-native selection in a closed shadow root. The source text is absent
// from the reader's light DOM and accessibility tree; speech reads the reflow once.
const styleText = `
:host { position: absolute; inset: 0; z-index: 1; cursor: text; }
.textLayer { position: absolute; inset: 0; overflow: clip; line-height: 1;
    text-align: initial; transform-origin: 0 0; color-scheme: only light;
    forced-color-adjust: none; text-size-adjust: none; user-select: text;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size)); }
.textLayer span, .textLayer br { color: transparent; position: absolute;
    white-space: pre; cursor: text; transform-origin: 0 0; }
.textLayer > :not(.markedContent), .markedContent span:not(.markedContent) {
    z-index: 1; font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1; --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
.markedContent { display: contents; }
::selection { background: rgba(45, 118, 230, .3); color: transparent; }
.ocrLayer { position: absolute; inset: 0; user-select: text; }
.ocrLayer span { position: absolute; display: block; overflow: hidden;
    color: transparent; font: 12px/1 sans-serif; white-space: pre-wrap;
    user-select: all; cursor: text; }
`;

function recognizedText(block) {
    if (block.type === 'math') {
        if (typeof block.latex !== 'string' || !block.latex) return '';
        return block.latex + (typeof block.label === 'string' && block.label ? ' ' + block.label : '');
    }
    if (block.type !== 'text') return '';
    return Array.isArray(block.runs) ? block.runs.map(recognizedText).join('')
        : typeof block.text === 'string' ? block.text : '';
}

export class PdfSourceSelection {
    constructor(viewer) {
        this.viewer = viewer;
        this.document = viewer.surface.ownerDocument;
        this.host = this.document.createElement('div');
        this.host.className = 'pdf-source-text';
        this.host.setAttribute('aria-hidden', 'true');
        this.host.setAttribute('data-tts-ignore', 'true');
        this.shadow = this.host.attachShadow({ mode: 'closed' });
        const style = this.document.createElement('style');
        style.textContent = styleText;
        this.layer = this.document.createElement('div');
        this.layer.className = 'textLayer';
        this.shadow.append(style, this.layer);
        viewer.surface.append(this.host);
        this.keyDown = event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                event.stopPropagation();
                const range = this.document.createRange();
                range.selectNodeContents(this.layer);
                const selection = this.document.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
        };
        viewer.viewport.addEventListener('keydown', this.keyDown);
        // Do not intercept pointer, contextmenu or copy: Chromium/Edge own the
        // actual selection and their normal right-click Copy action.
        this.ready = viewer.page.getTextContent().then(async content => {
            if (this.destroyed) return false;
            this.content = content;
            if (!this.ocrPage) await this.renderNative();
            return !this.destroyed;
        }).catch(error => {
            if (!this.destroyed) viewer.showError(error);
            return false;
        });
    }

    async renderNative() {
        this.textLayer?.cancel();
        this.layer.replaceChildren();
        this.layer.className = 'textLayer';
        if (!this.content || !this.content.items.some(item => typeof item.str === 'string' && item.str.trim())) {
            this.viewer.surface.setAttribute('data-pdf-selectable', 'false');
            return;
        }
        this.layout();
        const task = new this.document.defaultView.pdfjsLib.TextLayer({
            textContentSource: this.content, container: this.layer,
            viewport: this.viewer.pageViewport || this.viewer.base
        });
        this.textLayer = task;
        this.rendered = false;
        this.layoutViewport = null;
        try {
            await task.render();
            if (this.destroyed || this.textLayer !== task || this.ocrPage) return;
            this.rendered = true;
            this.layout();
            this.viewer.surface.setAttribute('data-pdf-selectable', 'true');
        } catch (error) {
            if (!this.destroyed && this.textLayer === task && !this.ocrPage) this.viewer.showError(error);
        }
    }

    setOcrPage(result) {
        if (this.destroyed || this.ocrPage === result) return;
        this.ocrPage = result || null;
        this.textLayer?.cancel();
        this.textLayer = null;
        this.rendered = false;
        this.layer.replaceChildren();
        this.viewer.surface.setAttribute('data-pdf-selectable', 'false');
        if (!result) {
            if (this.content) void this.renderNative();
            return;
        }
        this.layer.className = 'ocrLayer';
        let count = 0;
        if (result.width > 0 && result.height > 0 && Array.isArray(result.blocks)) {
            for (const block of result.blocks) {
                const text = recognizedText(block);
                const box = block.bbox;
                if (!text || !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) ||
                    box.x1 <= box.x0 || box.y1 <= box.y0) continue;
                // OCR supplies region boxes, not glyph positions. Each real
                // recognized region is atomic; no source font or glyphs invented.
                const span = this.document.createElement('span');
                span.textContent = text;
                span.style.left = box.x0 / result.width * 100 + '%';
                span.style.top = box.y0 / result.height * 100 + '%';
                span.style.width = (box.x1 - box.x0) / result.width * 100 + '%';
                span.style.height = (box.y1 - box.y0) / result.height * 100 + '%';
                this.layer.append(span, this.document.createElement('br'));
                count++;
            }
        }
        this.viewer.surface.setAttribute('data-pdf-selectable', String(count > 0));
    }

    layout() {
        if (this.destroyed || this.ocrPage) return;
        const viewport = this.viewer.pageViewport || this.viewer.base;
        if (this.layoutViewport === viewport) return;
        this.layoutViewport = viewport;
        this.layer.style.setProperty('--total-scale-factor', viewport.scale);
        this.layer.style.setProperty('--scale-round-x', '1px');
        this.layer.style.setProperty('--scale-round-y', '1px');
        if (this.rendered) this.textLayer.update({ viewport });
    }

    destroy() {
        this.destroyed = true;
        this.textLayer?.cancel();
        this.viewer.viewport.removeEventListener('keydown', this.keyDown);
        this.host.remove();
        this.content = null;
        this.ocrPage = null;
    }
}
