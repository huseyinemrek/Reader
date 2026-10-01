// Render only visible tiles at the current zoom and device pixel ratio. The page
// surface can grow to 500% without allocating a page-sized high-resolution canvas.
window.PdfPageViewer = class PdfPageViewer {
    constructor(column, pdfDocument, pageNumber, {zoom = null, onZoom, onNavigate} = {}) {
        this.column = column;
        this.zoom = zoom;
        this.onZoom = onZoom;
        this.onNavigate = onNavigate;
        this.pdfDocument = pdfDocument;
        this.tiles = new Map();
        this.links = [];
        this.destroyed = false;
        this.generation = 0;
        this.frame = 0;
        this.ratio = window.devicePixelRatio || 1;
        this.controls = document.createElement('div');
        this.controls.className = 'pdf-zoom-controls';
        this.controls.setAttribute('aria-label', 'Orijinal PDF yakınlaştırma');
        const button = (action, label, title) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = 'mode-btn';
            element.dataset.pdfZoom = action;
            element.textContent = label;
            element.setAttribute('aria-label', title);
            element.addEventListener('click', () => this.setZoom(action));
            this.controls.appendChild(element);
            return element;
        };
        this.minus = button('out', '−', 'PDF uzaklaştır');
        this.output = document.createElement('output');
        this.output.className = 'pdf-zoom-status';
        this.output.setAttribute('aria-live', 'polite');
        this.controls.appendChild(this.output);
        this.plus = button('in', '+', 'PDF yakınlaştır');
        button('fit', 'Sayfaya sığdır', 'PDF sayfasının tamamını sığdır');
        this.viewport = document.createElement('div');
        this.viewport.className = 'pdf-original-viewport';
        this.viewport.tabIndex = 0;
        this.viewport.setAttribute('role', 'region');
        this.viewport.setAttribute('aria-label', 'Sayfa ' + pageNumber + ' — orijinal PDF; kaydırarak inceleyin');
        this.surface = document.createElement('div');
        this.surface.className = 'pdf-original-surface';
        this.linkLayer = document.createElement('div');
        this.linkLayer.className = 'pdf-link-layer';
        this.linkLayer.setAttribute('aria-label', 'PDF bağlantıları');
        this.surface.appendChild(this.linkLayer);
        this.viewport.appendChild(this.surface);
        this.status = document.createElement('div');
        this.status.className = 'pdf-render-status';
        this.status.setAttribute('role', 'status');
        this.status.textContent = 'Orijinal PDF hazırlanıyor…';
        column.replaceChildren(this.controls, this.viewport, this.status);
        this.schedule = () => {
            if (!this.frame && !this.destroyed) this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.renderVisible();
            });
        };
        this.viewport.addEventListener('scroll', this.schedule, {passive: true});
        // Capture also covers the paged book viewport and mobile comparison pane.
        window.addEventListener('scroll', this.schedule, {capture: true, passive: true});
        window.addEventListener('resize', this.schedule);
        this.resizeObserver = new ResizeObserver(this.schedule);
        this.resizeObserver.observe(this.viewport);
        pdfDocument.getPage(pageNumber).then(page => {
            if (this.destroyed) return;
            this.page = page;
            this.base = page.getViewport({scale: 96 / 72});
            void this.loadLinks();
            this.schedule();
        }).catch(error => {
            if (!this.destroyed) this.showError(error);
        });
    }

    setZoom(action) {
        if (!this.page || this.destroyed || !this.layout()) return;
        const next = action === 'fit' ? null : Math.min(5, Math.max(0.25,
            Math.round((this.scale + (action === 'in' ? 0.25 : -0.25)) * 100) / 100));
        const x = (this.viewport.scrollLeft + this.viewport.clientWidth / 2) / this.scale;
        const y = (this.viewport.scrollTop + this.viewport.clientHeight / 2) / this.scale;
        this.zoom = next;
        this.onZoom?.(next);
        this.layout();
        this.viewport.scrollLeft = next === null ? 0 : x * this.scale - this.viewport.clientWidth / 2;
        this.viewport.scrollTop = next === null ? 0 : y * this.scale - this.viewport.clientHeight / 2;
        this.schedule();
    }

    layout() {
        const width = this.viewport.clientWidth;
        const height = this.viewport.clientHeight;
        if (!this.page || !width || !height) return false;
        const scale = this.zoom ?? Math.min(width / this.base.width, height / this.base.height);
        const ratio = window.devicePixelRatio || 1;
        if (this.scale !== scale || this.ratio !== ratio) {
            this.clearTiles();
            this.renderError = false;
            this.scale = scale;
            this.ratio = ratio;
            this.pageViewport = this.page.getViewport({scale: (96 / 72) * scale});
            this.surface.style.width = this.pageViewport.width + 'px';
            this.surface.style.height = this.pageViewport.height + 'px';
        }
        this.positionLinks();
        this.output.textContent = Math.round(scale * 100) + '%' + (this.zoom === null ? ' · Sığdır' : '');
        this.minus.disabled = scale <= 0.25;
        this.plus.disabled = scale >= 5;
        return true;
    }

    async loadLinks() {
        const page = this.page;
        try {
            const annotations = await page.getAnnotations({intent: 'display'});
            if (this.destroyed || page !== this.page) return;
            for (const annotation of annotations) {
                if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) continue;
                const url = this.safeLinkUrl(annotation.url);
                let target = url ? {url} : null;
                if (!target && annotation.dest !== undefined) {
                    try {
                        const destination = typeof annotation.dest === 'string'
                            ? await this.pdfDocument.getDestination(annotation.dest) : annotation.dest;
                        const reference = Array.isArray(destination) ? destination[0] : null;
                        const index = Number.isInteger(reference) ? reference
                            : reference && typeof reference === 'object' ? await this.pdfDocument.getPageIndex(reference) : -1;
                        if (Number.isInteger(index) && index >= 0 && index < this.pdfDocument.numPages) target = {page: index + 1};
                    } catch { /* An unresolved PDF action is left inert. */ }
                }
                if (!target || this.destroyed || page !== this.page) continue;
                const anchor = document.createElement('a');
                anchor.className = 'pdf-original-link';
                anchor.setAttribute('aria-label', annotation.contents || annotation.title || 'PDF bağlantısı');
                if (target.page !== undefined) {
                    anchor.dataset.pdfPage = String(target.page);
                    anchor.href = this.pageHref(target.page);
                    if (this.onNavigate) anchor.addEventListener('click', event => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        this.onNavigate(target.page, event);
                    });
                } else {
                    anchor.href = target.url;
                    anchor.target = '_blank';
                    anchor.rel = 'noopener noreferrer';
                }
                this.linkLayer.appendChild(anchor);
                this.links.push({anchor, rect: annotation.rect});
            }
            this.positionLinks();
        } catch { /* The source remains readable when annotation metadata is malformed. */ }
    }

    safeLinkUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value);
            return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password
                ? url.href : null;
        } catch { return null; }
    }

    pageHref(page) {
        const url = new URL(window.location.href);
        url.searchParams.set('page', String(page));
        url.searchParams.delete('ch');
        url.searchParams.delete('local');
        url.hash = '';
        return url.href;
    }

    positionLinks() {
        if (!this.pageViewport) return;
        for (const {anchor, rect} of this.links) {
            const [a, b, c, d, e, f] = this.pageViewport.transform;
            const corners = [[rect[0], rect[1]], [rect[0], rect[3]], [rect[2], rect[1]], [rect[2], rect[3]]]
                .map(([x, y]) => ({x: a * x + c * y + e, y: b * x + d * y + f}));
            const left = Math.min(...corners.map(point => point.x));
            const top = Math.min(...corners.map(point => point.y));
            const width = Math.max(...corners.map(point => point.x)) - left;
            const height = Math.max(...corners.map(point => point.y)) - top;
            Object.assign(anchor.style, {
                left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px'
            });
        }
    }

    renderVisible() {
        if (this.destroyed || !this.column.isConnected || !this.layout()) return;
        const rect = this.viewport.getBoundingClientRect();
        const surfaceRect = this.surface.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.left + this.viewport.clientWidth, innerWidth);
        const bottom = Math.min(rect.top + this.viewport.clientHeight, innerHeight);
        const visible = right > left && bottom > top;
        // A tile is never larger than 1024 x 1024 physical pixels, including DPR.
        const size = 1024 / this.ratio;
        const wanted = new Set();
        if (visible) {
            const x0 = Math.max(0, Math.floor((left - surfaceRect.left) / size));
            const y0 = Math.max(0, Math.floor((top - surfaceRect.top) / size));
            const x1 = Math.min(Math.ceil(this.pageViewport.width / size) - 1, Math.floor((right - surfaceRect.left) / size));
            const y1 = Math.min(Math.ceil(this.pageViewport.height / size) - 1, Math.floor((bottom - surfaceRect.top) / size));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) wanted.add(x + ':' + y);
        }
        for (const [key, tile] of this.tiles) {
            if (!wanted.has(key)) {
                this.releaseTile(tile);
                this.tiles.delete(key);
            }
        }
        for (const key of wanted) {
            if (this.tiles.has(key)) continue;
            const [x, y] = key.split(':').map(Number);
            this.renderTile(key, x * size, y * size, size);
        }
    }

    renderTile(key, x, y, size) {
        const width = Math.min(size, this.pageViewport.width - x);
        const height = Math.min(size, this.pageViewport.height - y);
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-original-tile';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.width = Math.min(1024, Math.ceil(width * this.ratio));
        canvas.height = Math.min(1024, Math.ceil(height * this.ratio));
        Object.assign(canvas.style, {left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px'});
        this.surface.appendChild(canvas);
        const tile = {canvas, released: false};
        this.tiles.set(key, tile);
        const generation = this.generation;
        try {
            tile.task = this.page.render({
                canvasContext: canvas.getContext('2d', {alpha: false}),
                viewport: this.pageViewport,
                transform: [this.ratio, 0, 0, this.ratio, -x * this.ratio, -y * this.ratio],
                background: 'rgb(255, 255, 255)'
            });
            tile.task.promise.then(() => {
                if (!this.destroyed && !tile.released && !this.renderError && generation === this.generation) this.status.textContent = '';
            }).catch(error => {
                if (!this.destroyed && !tile.released && error.name !== 'RenderingCancelledException') this.showError(error);
            }).finally(() => {
                tile.settled = true;
                if (tile.released) canvas.width = canvas.height = 0;
            });
        } catch (error) {
            tile.settled = true;
            this.showError(error);
        }
    }

    showError(error) {
        this.renderError = true;
        console.error('Orijinal PDF çizilemedi:', error);
        this.status.textContent = 'Orijinal PDF çizilemedi: ' + error.message;
    }

    releaseTile(tile) {
        tile.released = true;
        tile.task?.cancel();
        tile.canvas.remove();
        if (tile.settled || !tile.task) tile.canvas.width = tile.canvas.height = 0;
    }

    clearTiles() {
        this.generation++;
        for (const tile of this.tiles.values()) this.releaseTile(tile);
        this.tiles.clear();
    }

    destroy() {
        this.destroyed = true;
        cancelAnimationFrame(this.frame);
        this.clearTiles();
        this.resizeObserver.disconnect();
        this.viewport.removeEventListener('scroll', this.schedule);
        window.removeEventListener('scroll', this.schedule, true);
        window.removeEventListener('resize', this.schedule);
    }
};
