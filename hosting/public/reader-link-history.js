import { revealReaderObjectTarget } from './epub-object-view.js';

// Link excursions belong to the open book, independently of normal page turns.
export function createReaderLinkHistory({ toast, settingsButton, settingsGroup, capture, restore, onReturn }) {
    const entries = [];
    let timer;
    let generation = 0;
    let busy = false;

    function hideToast() {
        clearTimeout(timer);
        if (toast.contains(document.activeElement)) document.getElementById('settings-toggle').focus();
        toast.hidden = true;
    }

    function update() {
        const position = entries.at(-1);
        settingsGroup.hidden = !position;
        toast.disabled = settingsButton.disabled = busy;
        if (!position) { hideToast(); return; }
        const page = position.globalPage ? ' · Sayfa ' + position.globalPage : '';
        toast.querySelector('span').textContent = 'Okuduğun yere dön' + page;
        settingsButton.querySelector('span').textContent = 'Link öncesi konuma dön' + page;
    }

    async function follow(action) {
        if (busy) return false;
        const position = capture();
        if (!position) return false;
        const token = generation;
        busy = true;
        update();
        try {
            if (!await action() || token !== generation) return false;
            entries.push(position);
            update();
            hideToast();
            toast.hidden = false;
            timer = setTimeout(hideToast, 5000);
            return true;
        } finally {
            if (token === generation) { busy = false; update(); }
        }
    }

    async function back() {
        const position = entries.at(-1);
        if (!position || busy) return;
        const token = generation;
        busy = true;
        update();
        try {
            onReturn();
            if (await restore(position) && token === generation) {
                entries.pop();
                hideToast();
            }
        } finally {
            if (token === generation) { busy = false; update(); }
        }
    }

    toast.addEventListener('click', back);
    settingsButton.addEventListener('click', back);
    return { follow, clear() { generation++; busy = false; entries.length = 0; hideToast(); update(); } };
}

function textNodes(root) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node; (node = walker.nextNode());) {
        if (node.textContent.trim() && !node.parentElement.closest('style, script, [data-reader-ui]')) nodes.push(node);
    }
    return nodes;
}

function readingBounds(viewport, paged) {
    const rect = viewport.getBoundingClientRect();
    return { left: Math.max(0, rect.left), right: Math.min(innerWidth, rect.right),
        top: paged ? Math.max(0, rect.top) : 80,
        bottom: paged ? Math.min(innerHeight, rect.bottom) : innerHeight };
}

// Store a source character rather than a pixel scroll offset or reflowed page number.
export function captureReaderTextAnchor(root, viewport, paged) {
    if (!root) return null;
    const bounds = readingBounds(viewport, paged);
    const visible = rect => rect.right > bounds.left + 1 && rect.left < bounds.right - 1 &&
        rect.bottom > bounds.top && rect.top < bounds.bottom;
    const nodes = textNodes(root);
    const range = root.ownerDocument.createRange();
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const objectViewport = node.parentElement.closest('.reader-object-viewport');
        const objectBounds = objectViewport?.getBoundingClientRect();
        const visibleHere = rect => visible(rect) && (!objectBounds || rect.right > objectBounds.left &&
            rect.left < objectBounds.right && rect.bottom > objectBounds.top && rect.top < objectBounds.bottom);
        range.selectNodeContents(node);
        if (!Array.from(range.getClientRects()).some(visibleHere)) continue;
        for (let offset = 0; offset < node.length; offset++) {
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            if (visibleHere(rect)) return { index, offset, top: rect.top - bounds.top, paged };
        }
    }
    return null;
}

function columnOf(rect, viewport) {
    return Math.max(0, Math.floor((rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft) / viewport.clientWidth));
}

// Edge Read Aloud wraps the spoken word and line in msreadout-* spans. While it
// speaks (or is paused), that word is the reading position, not the page start.
export function speechHighlight(root) {
    return root?.querySelector('.msreadout-word-highlight') || root?.querySelector('.msreadout-line-highlight') || null;
}

export function speechHighlightColumn(root, viewport) {
    const spoken = speechHighlight(root);
    return spoken ? columnOf(spoken.getBoundingClientRect(), viewport) : null;
}

// Edge exposes no events, so its highlight spans are the only signal. `started`
// marks the first highlight after none was shown: a new Read Aloud start rather
// than the next word, a pause or Edge's previous/next paragraph buttons.
export function watchSpeechHighlight(document, onHighlight) {
    let shown = false;
    const observer = new document.defaultView.MutationObserver(() => {
        const highlight = speechHighlight(document);
        const started = !!highlight && !shown;
        shown = !!highlight;
        if (highlight) onHighlight(highlight, started);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
}

// True when no book text precedes the highlight inside container, i.e. Edge began
// at the container's first readable text instead of a point the reader chose.
export function speechStartsContainer(container, highlight, isBookText = () => true) {
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
        if (highlight.contains(node)) return true;
        if (node.textContent.trim() && !node.parentElement.closest('style, script, [data-reader-ui]') && isBookText(node)) return false;
    }
    return false;
}

// The first word whose box is fully inside bounds and not covered by reader chrome.
// Edge also hit-tests the spoken word and scrolls a covered one back into view.
export function firstVisibleWord(roots, bounds) {
    const document = roots.find(Boolean)?.ownerDocument;
    if (!document) return null;
    const range = document.createRange();
    const touches = rect => rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom;
    const within = (rect, box) => rect.width > 0 && rect.height > 0 && rect.left >= box.left - 1 &&
        rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
    for (const root of roots) {
        if (!root || !touches(root.getBoundingClientRect())) continue;
        for (const node of textNodes(root)) {
            range.selectNodeContents(node);
            if (!Array.from(range.getClientRects()).some(touches)) continue;
            const objectBounds = node.parentElement.closest('.reader-object-viewport')?.getBoundingClientRect();
            for (const match of node.textContent.matchAll(/\S+/g)) {
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                const rect = range.getBoundingClientRect();
                if (!within(rect, bounds) || (objectBounds && !within(rect, objectBounds))) continue;
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                if (hit && (node.parentElement.contains(hit) || hit.contains(node))) return range.cloneRange();
            }
        }
    }
    return null;
}

// Edge Read Aloud moves to text selected while it plays and then clears the
// selection itself; never leave a stray selection when it does not take it.
export function selectForSpeech(range) {
    const selection = range.startContainer.ownerDocument.getSelection();
    const text = range.toString();
    selection.removeAllRanges();
    selection.addRange(range);
    setTimeout(() => {
        if (selection.rangeCount && !selection.isCollapsed && selection.toString() === text) selection.removeAllRanges();
    }, 2000);
}

function anchorRange(root, anchor) {
    const node = textNodes(root)[anchor.index];
    if (!node?.length) return null;
    const range = root.ownerDocument.createRange();
    const offset = Math.min(anchor.offset, node.length - 1);
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    return range;
}

function anchorPoint(viewport, paged, anchor) {
    return readingBounds(viewport, paged).top + (anchor.paged === paged ? anchor.top : 0);
}

// How far restoreReaderTextAnchor would scroll to show the anchor again.
export function readerTextAnchorShift(root, viewport, paged, anchor) {
    const range = root && anchor ? anchorRange(root, anchor) : null;
    return range ? range.getBoundingClientRect().top - anchorPoint(viewport, paged, anchor) : null;
}

export function restoreReaderTextAnchor(root, viewport, paged, columned, anchor) {
    if (!root || !anchor) return null;
    const range = anchorRange(root, anchor);
    if (!range) return null;
    revealReaderObjectTarget(range.startContainer);
    const rect = range.getBoundingClientRect();
    if (columned) return columnOf(rect, viewport);
    const scroller = paged ? viewport : window;
    scroller.scrollBy({ top: rect.top - anchorPoint(viewport, paged, anchor), behavior: 'instant' });
    return null;
}
