// Paged reading turns a page only on purpose: the edge buttons, the keyboard, a
// sideways swipe (touch, pen, or a mouse drag that is not a text selection) or a
// sideways wheel/touchpad gesture. Plain clicks and taps never turn a page.
const NOT_A_SWIPE = 'a, button, input, select, textarea, [role="separator"], .pdf-page-image-column, .reader-object-shell, .reader-object-dialog';
const OWN_WHEEL = '.pdf-page-image-column, .reader-object-shell, .reader-object-dialog';

export function installPageTurns({ view, viewport, content, isPaged, turn }) {
    const document = view.ownerDocument;
    const window = document.defaultView;
    let gesture = null;
    let swipedAt = -1;
    let wheelDistance = 0;
    let wheelTurned = false;
    let wheelTimer = null;

    // Native sideways scrollers (a wide table, the PDF comparison on a phone) keep their swipe.
    function scrollsSideways(target) {
        for (let element = target; element && element !== viewport && element !== view; element = element.parentElement) {
            const overflow = window.getComputedStyle(element).overflowX;
            if ((overflow === 'auto' || overflow === 'scroll') && element.scrollWidth > element.clientWidth + 1) return true;
        }
        return false;
    }

    view.addEventListener('pointerdown', event => {
        gesture = null;
        const mouse = event.pointerType === 'mouse';
        if (!event.isPrimary || !isPaged() || !(event.target instanceof window.Element) ||
            (mouse && (event.button !== 0 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) ||
            event.target.closest(NOT_A_SWIPE) || scrollsSideways(event.target)) return;
        gesture = { id: event.pointerId, mouse, x: event.clientX, y: event.clientY, time: event.timeStamp };
    });
    window.addEventListener('pointercancel', () => { gesture = null; });
    window.addEventListener('pointerup', event => {
        const start = gesture;
        gesture = null;
        if (!start || event.pointerId !== start.id || !isPaged()) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) < 1.5 * Math.abs(dy)) return;
        const selection = document.getSelection();
        // A mouse drag over text selects it: only a quick flick, or a drag that selected
        // nothing, is a swipe.
        const swipe = start.mouse
            ? Math.abs(dx) >= 80 && (selection.isCollapsed || event.timeStamp - start.time <= 300)
            : Math.abs(dx) >= 40 && event.timeStamp - start.time <= 1000;
        if (!swipe) return;
        if (start.mouse) {
            if (!selection.isCollapsed) selection.removeAllRanges();
            swipedAt = event.timeStamp;
        }
        turn(dx < 0 ? 1 : -1);
    });
    // The click that ends a mouse swipe is not a click on the page.
    view.addEventListener('click', event => {
        if (swipedAt >= 0 && event.timeStamp - swipedAt < 500) {
            event.stopPropagation();
            event.preventDefault();
        }
        swipedAt = -1;
    }, true);

    // Touchpads and tilting wheels scroll sideways; one gesture turns one page.
    view.addEventListener('wheel', event => {
        if (!isPaged() || event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY) ||
            !(event.target instanceof window.Element) || event.target.closest(OWN_WHEEL) || scrollsSideways(event.target)) return;
        // Also keeps the browser's swipe navigation from leaving the book.
        event.preventDefault();
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => { wheelDistance = 0; wheelTurned = false; }, 250);
        if (wheelTurned) return;
        wheelDistance += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1);
        if (Math.abs(wheelDistance) < 60) return;
        wheelTurned = true;
        turn(wheelDistance > 0 ? 1 : -1);
    }, { passive: false });

    // The strips that reveal the buttons end just before the text: Edge Read Aloud
    // counts a word under another element as hidden, and covered text cannot be selected.
    function update() {
        if (!viewport.clientWidth) return;
        const page = viewport.getBoundingClientRect().left;
        const margin = parseFloat(window.getComputedStyle(content).paddingLeft) || 0;
        const end = page + margin - 8;
        const width = Math.max(12, Math.min(160, end));
        const offset = Math.max(0, end - width);
        const button = Math.min(44, width);
        // In the page's own margin when it has room for the button, else mid-strip.
        const center = margin >= button + 12 ? page + margin / 2 - offset : width / 2;
        view.style.setProperty('--page-turn-width', width + 'px');
        view.style.setProperty('--page-turn-offset', offset + 'px');
        view.style.setProperty('--page-turn-button', button + 'px');
        view.style.setProperty('--page-turn-center', Math.max(button / 2, Math.min(width - button / 2, center)) + 'px');
    }
    window.addEventListener('resize', update);
    const resizes = new window.ResizeObserver(update);
    resizes.observe(viewport);
    resizes.observe(content);
    update();
}
