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
        if (node.textContent.trim() && !node.parentElement.closest('style, script')) nodes.push(node);
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
        range.selectNodeContents(node);
        if (!Array.from(range.getClientRects()).some(visible)) continue;
        for (let offset = 0; offset < node.length; offset++) {
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            if (visible(rect)) return { index, offset, top: rect.top - bounds.top, paged };
        }
    }
    return null;
}

export function restoreReaderTextAnchor(root, viewport, paged, columned, anchor) {
    if (!root || !anchor) return null;
    const node = textNodes(root)[anchor.index];
    if (!node?.length) return null;
    const range = root.ownerDocument.createRange();
    const offset = Math.min(anchor.offset, node.length - 1);
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    if (columned) {
        return Math.max(0, Math.floor((rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft) / viewport.clientWidth));
    }
    const bounds = readingBounds(viewport, paged);
    const point = bounds.top + (anchor.paged === paged ? anchor.top : 0);
    const scroller = paged ? viewport : window;
    scroller.scrollBy({ top: rect.top - point, behavior: 'instant' });
    return null;
}
