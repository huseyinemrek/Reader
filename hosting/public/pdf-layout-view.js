// Shared column sizing, splitter interaction, and tiled-original viewer lifetime.
// Page assembly, OCR cancellation, and reading-position persistence stay with the reader.
export function createPdfLayoutView({
    root, getSettings, getDocument, getCurrentPage, getStates,
    captureAnchor, restoreAnchor, onSettingsChange, onInteraction
}) {
    let zoom = null;
    let drag = null;
    let suppressClickUntil = 0;
    let destroyed = false;
    const viewerSources = new WeakMap();

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
    }

    function dispose(section, state) {
        if (drag && section.contains(drag.splitter)) finishDrag();
        state.viewer?.destroy();
        state.viewer = null;
        viewerSources.delete(state);
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
            state.viewer = new window.PdfPageViewer(column, pdfDocument, pageNumber, {
                zoom, onZoom: value => {
                    zoom = value;
                    notify('zoom');
                }
            });
            viewerSources.set(state, {document: pdfDocument, page: pageNumber});
        } else state.viewer.schedule();
    }

    function apply() {
        if (destroyed) return;
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

    function reset() {
        finishDrag();
        for (const [section, state] of getStates()) dispose(section, state);
        zoom = null;
        suppressClickUntil = 0;
    }

    function destroy() {
        if (destroyed) return;
        reset();
        destroyed = true;
        for (const [name, handler] of listeners) root.removeEventListener(name, handler, true);
        root.ownerDocument.defaultView.removeEventListener('blur', finishDrag);
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
