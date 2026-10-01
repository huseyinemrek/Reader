// Shared column sizing, splitter interaction, and tiled-original viewer lifetime.
// Page assembly, OCR cancellation, and reading-position persistence stay with the reader.
export function createPdfLayoutView({
    root, getSettings, getDocument, getCurrentPage, getStates,
    captureAnchor, restoreAnchor, onSettingsChange, onInteraction, onNavigate
}) {
    let zoom = null;
    let drag = null;
    let suppressClickUntil = 0;
    let destroyed = false;
    const viewerSources = new WeakMap();
    const document = root.ownerDocument;
    const window = document.defaultView;
    const bookViewport = root.closest('#book-viewport');
    let readingFrame = 0;
    let textScrolled = false;
    let reflowing = false;
    let lastWindowTop = window.scrollY;
    let lastBookTop = bookViewport?.scrollTop || 0;
    const observedText = new Map();

    function readingViewport() {
        if (getSettings().readingMode === 'paged') {
            if (!bookViewport) return null;
            const rect = bookViewport.getBoundingClientRect();
            const top = Math.max(0, rect.top + bookViewport.clientTop);
            const bottom = Math.min(window.innerHeight, rect.top + bookViewport.clientTop + bookViewport.clientHeight);
            return {top, bottom, height: bottom - top};
        }
        return {top: 0, bottom: window.innerHeight, height: window.innerHeight};
    }

    function syncReading(section, state, fromScroll = false, force = false) {
        const source = viewerSources.get(state);
        if (!source || !state.viewer || state.viewer.destroyed || !section.isConnected ||
            !root.contains(section) || (getSettings().readingMode === 'paged' &&
            Number(section.dataset.pageIndex) !== getCurrentPage())) return;
        const viewport = readingViewport();
        const text = section.querySelector('.pdf-page-text');
        if (!viewport || viewport.height <= 0 || !text) return;
        const rect = text.getBoundingClientRect();
        if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) return;
        if (fromScroll) source.manual = false;
        if (source.manual) return;
        const range = Math.max(0, rect.height - viewport.height);
        const fraction = range ? Math.max(0, Math.min(1, (viewport.top - rect.top) / range)) : 0;
        if (force || fromScroll || source.progress !== fraction) {
            source.progress = fraction;
            state.viewer.setReadingProgress?.(fraction);
        }
    }

    function scheduleReading(fromScroll = false) {
        if (destroyed || drag) return;
        textScrolled ||= fromScroll;
        if (readingFrame) return;
        readingFrame = window.requestAnimationFrame(() => {
            readingFrame = 0;
            const fromScroll = textScrolled;
            textScrolled = false;
            if (!destroyed && !drag) {
                for (const [section, state] of getStates()) syncReading(section, state, fromScroll);
            }
            reflowing = false;
        });
    }

    function windowScroll(event) {
        if (event.target !== document && event.target !== window) return;
        const top = window.scrollY;
        const changed = top !== lastWindowTop;
        lastWindowTop = top;
        if (changed && getSettings().readingMode !== 'paged') scheduleReading(!reflowing);
    }

    function bookScroll(event) {
        if (event.target !== bookViewport) return;
        const top = bookViewport.scrollTop;
        const changed = top !== lastBookTop;
        lastBookTop = top;
        if (changed && getSettings().readingMode === 'paged') scheduleReading(!reflowing);
    }

    function sourceInteraction(event) {
        if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
        const original = event.target.closest?.('.pdf-original-viewport');
        if (!original) return;
        const state = getStates().get(original.closest('.pdf-page'));
        const source = state && viewerSources.get(state);
        if (source) {
            source.manual = true;
            textScrolled = false;
        }
    }

    function reflow() {
        reflowing = true;
        scheduleReading();
    }

    const resizeObserver = new window.ResizeObserver(reflow);
    resizeObserver.observe(root);
    if (bookViewport) resizeObserver.observe(bookViewport);

    function splitBounds(columns) {
        const columnWidth = columns.clientWidth;
        const width = Math.max(1, columnWidth - 40);
        const minimum = columnWidth ? Math.min(0.49, Math.max(0.2, 220 / width)) : 0.2;
        return {minimum, maximum: 1 - minimum, width};
    }

    function settings() {
        const current = getSettings();
        if (!['text-only', 'text-right', 'text-left'].includes(current.pdfLayout)) current.pdfLayout = 'text-right';
        const ratio = Number(current.pdfTextRatio);
        current.pdfTextRatio = Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.535;
        root.dataset.pdfLayout = current.pdfLayout;
        return current;
    }

    function notify(type) {
        onInteraction?.({type, isDragging: !!drag});
    }

    function finishDrag() {
        const active = drag;
        if (!active) return;
        drag = null;
        if (active.splitter.hasPointerCapture(active.pointerId)) active.splitter.releasePointerCapture(active.pointerId);
        root.ownerDocument.documentElement.classList.remove('pdf-split-dragging');
        suppressClickUntil = performance.now() + 350;
        if (getSettings().pdfTextRatio !== active.startRatio) onSettingsChange?.();
        notify('drag-end');
        reflow();
    }

    function dispose(section, state) {
        if (drag && section.contains(drag.splitter)) finishDrag();
        state.viewer?.destroy();
        state.viewer = null;
        viewerSources.delete(state);
        const text = observedText.get(section);
        if (text) resizeObserver.unobserve(text);
        observedText.delete(section);
        section.querySelector('.pdf-page-image-column')?.replaceChildren();
    }

    function syncState(section, state, current) {
        const columns = section.querySelector('.pdf-page-columns');
        const column = section.querySelector('.pdf-page-image-column');
        if (!columns || !column || !section.isConnected || !root.contains(section)) {
            dispose(section, state);
            return;
        }
        const bounds = splitBounds(columns);
        const text = section.querySelector('.pdf-page-text');
        if (text && observedText.get(section) !== text) {
            const previous = observedText.get(section);
            if (previous) resizeObserver.unobserve(previous);
            observedText.set(section, text);
            resizeObserver.observe(text);
        }
        const textRatio = Math.max(bounds.minimum, Math.min(bounds.maximum, current.pdfTextRatio));
        const leftRatio = current.pdfLayout === 'text-left' ? textRatio : 1 - textRatio;
        columns.style.setProperty('--pdf-left-fr', leftRatio + 'fr');
        columns.style.setProperty('--pdf-right-fr', (1 - leftRatio) + 'fr');
        const splitter = columns.querySelector('.pdf-splitter');
        if (splitter) {
            splitter.setAttribute('aria-valuemin', Math.round(bounds.minimum * 100));
            splitter.setAttribute('aria-valuemax', Math.round(bounds.maximum * 100));
            splitter.setAttribute('aria-valuenow', Math.round(leftRatio * 100));
            splitter.setAttribute('aria-valuetext', `Metin genişliği yüzde ${Math.round(textRatio * 100)}`);
        }
        const pdfDocument = getDocument();
        const pageNumber = Number(section.dataset.pageIndex);
        const wanted = pdfDocument && current.pdfLayout !== 'text-only' &&
            (current.readingMode !== 'paged' || pageNumber === getCurrentPage());
        const source = viewerSources.get(state);
        if (!wanted || (state.viewer && (state.viewer.destroyed || source?.document !== pdfDocument || source?.page !== pageNumber))) {
            dispose(section, state);
        }
        if (!wanted) return;
        if (!state.viewer) {
            const source = {document: pdfDocument, page: pageNumber, progress: null, manual: false};
            viewerSources.set(state, source);
            state.viewer = new window.PdfPageViewer(column, pdfDocument, pageNumber, {
                zoom, onZoom: value => {
                    zoom = value;
                    notify('zoom');
                }, onNavigate,
                onLayout: () => {
                    if (!destroyed && !drag && viewerSources.get(state) === source) syncReading(section, state, false, true);
                },
                textSource: section.dataset.textSource
            });
            syncReading(section, state);
        } else {
            state.viewer.setSource?.(section.dataset.textSource);
            state.viewer.schedule();
        }
        state.viewer.setOcrPage?.(state.ocrPage || null);
        scheduleReading();
    }

    function apply() {
        if (destroyed) return;
        reflow();
        const current = settings();
        if (drag && (current.pdfLayout === 'text-only' || !drag.splitter.isConnected ||
            (current.readingMode === 'paged' && Number(drag.splitter.closest('.pdf-page').dataset.pageIndex) !== getCurrentPage()))) finishDrag();
        for (const [section, state] of getStates()) syncState(section, state, current);
    }

    function sync(section, state) {
        if (!destroyed) syncState(section, state, settings());
    }

    function setRatio(ratio, anchor) {
        getSettings().pdfTextRatio = ratio;
        apply();
        restoreAnchor(anchor);
    }

    function getSplitter(event) {
        return event.target.closest?.('.pdf-splitter');
    }

    function pointerDown(event) {
        const splitter = getSplitter(event);
        if (!splitter || event.button !== 0 || drag || getSettings().pdfLayout === 'text-only') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        root.ownerDocument.defaultView.getSelection()?.removeAllRanges();
        splitter.focus({preventScroll: true});
        drag = {splitter, pointerId: event.pointerId, anchor: captureAnchor(), startRatio: getSettings().pdfTextRatio};
        splitter.setPointerCapture(event.pointerId);
        root.ownerDocument.documentElement.classList.add('pdf-split-dragging');
        notify('drag-start');
    }

    function pointerMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const columns = drag.splitter.parentElement;
        const bounds = splitBounds(columns);
        const left = (event.clientX - columns.getBoundingClientRect().left - 20) / bounds.width;
        const textRatio = getSettings().pdfLayout === 'text-left' ? left : 1 - left;
        setRatio(Math.max(bounds.minimum, Math.min(bounds.maximum, textRatio)), drag.anchor);
    }

    function pointerEnd(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finishDrag();
    }

    function click(event) {
        if (getSplitter(event) || drag || (performance.now() < suppressClickUntil &&
            !event.target.closest?.('button, a, input, select, textarea'))) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    function keyDown(event) {
        const splitter = getSplitter(event);
        if (!splitter || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const current = settings();
        const bounds = splitBounds(splitter.parentElement);
        const textLeft = current.pdfLayout === 'text-left';
        const ratio = Math.max(bounds.minimum, Math.min(bounds.maximum, current.pdfTextRatio));
        const left = textLeft ? ratio : 1 - ratio;
        const next = event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum
            : left + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 0.1 : 0.02);
        const clamped = Math.max(bounds.minimum, Math.min(bounds.maximum, next));
        const previous = current.pdfTextRatio;
        setRatio(textLeft ? clamped : 1 - clamped, captureAnchor());
        if (getSettings().pdfTextRatio !== previous) onSettingsChange?.();
        notify('keyboard');
    }

    const listeners = [
        ['pointerdown', pointerDown], ['pointermove', pointerMove],
        ['pointerup', pointerEnd], ['pointercancel', pointerEnd], ['lostpointercapture', pointerEnd],
        ['click', click], ['keydown', keyDown]
    ];
    for (const [name, handler] of listeners) root.addEventListener(name, handler, true);
    root.ownerDocument.defaultView.addEventListener('blur', finishDrag);
    root.addEventListener('pointerdown', sourceInteraction, true);
    root.addEventListener('wheel', sourceInteraction, {capture: true, passive: true});
    root.addEventListener('keydown', sourceInteraction, true);
    window.addEventListener('scroll', windowScroll, {passive: true});
    window.addEventListener('resize', reflow);
    bookViewport?.addEventListener('scroll', bookScroll, {passive: true});

    function reset() {
        finishDrag();
        for (const [section, state] of getStates()) dispose(section, state);
        if (readingFrame) window.cancelAnimationFrame(readingFrame);
        readingFrame = 0;
        textScrolled = false;
        reflowing = false;
        lastWindowTop = window.scrollY;
        lastBookTop = bookViewport?.scrollTop || 0;
        zoom = null;
        suppressClickUntil = 0;
    }

    function destroy() {
        if (destroyed) return;
        reset();
        destroyed = true;
        for (const [name, handler] of listeners) root.removeEventListener(name, handler, true);
        root.ownerDocument.defaultView.removeEventListener('blur', finishDrag);
        resizeObserver.disconnect();
        root.removeEventListener('pointerdown', sourceInteraction, true);
        root.removeEventListener('wheel', sourceInteraction, true);
        root.removeEventListener('keydown', sourceInteraction, true);
        window.removeEventListener('scroll', windowScroll);
        window.removeEventListener('resize', reflow);
        bookViewport?.removeEventListener('scroll', bookScroll);
    }

    return {apply, sync, dispose, finishDrag, reset, destroy, get isDragging() { return !!drag; }};
}

export function createPdfPage(pageNumber, tools, targetDocument = globalThis.document) {
    const section = targetDocument.createElement('section');
    section.id = 'pdf-page-' + pageNumber;
    section.className = 'pdf-page';
    section.dataset.pageIndex = pageNumber;
    section.dataset.index = pageNumber - 1;
    section.dataset.loaded = 'true';
    section.setAttribute('role', 'region');
    section.setAttribute('aria-label', 'Sayfa ' + pageNumber);
    const text = targetDocument.createElement('div');
    text.className = 'pdf-page-text';
    text.id = 'pdf-text-' + pageNumber;
    text.setAttribute('aria-label', 'Çıkarılan metin');
    text.setAttribute('role', 'region');
    const comparison = targetDocument.createElement('div');
    comparison.className = 'pdf-page-comparison';
    const columns = targetDocument.createElement('div');
    columns.className = 'pdf-page-columns';
    const imageColumn = targetDocument.createElement('div');
    imageColumn.className = 'pdf-page-image-column';
    const splitter = targetDocument.createElement('div');
    splitter.className = 'pdf-splitter';
    splitter.tabIndex = 0;
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.setAttribute('aria-label', 'PDF ve metin sütunu genişlikleri');
    splitter.setAttribute('aria-controls', text.id);
    columns.append(imageColumn, splitter, text);
    comparison.appendChild(columns);
    if (tools) section.appendChild(tools);
    section.appendChild(comparison);
    return section;
}
