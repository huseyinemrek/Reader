// Oversized objects stay a single source DOM subtree, including in the dialog.
// Controls use accessible labels rather than adding text to source-position walkers.
export const objectViewCss = `
#book-content .reader-object-toolbar { display:none!important; }
#reader-view.paged-mode #book-content .reader-object-shell,
#book-content .reader-object-dialog .reader-object-shell {
  display:grid!important; grid-template-rows:36px minmax(0,1fr)!important;
  box-sizing:border-box!important; height:var(--reader-object-height)!important;
  width:100%!important; min-width:0!important; max-width:100%!important;
  margin:0!important; padding:0!important; border:0!important;
  overflow:hidden!important; break-inside:avoid-column!important;
}
#reader-view.paged-mode #book-content .reader-object-toolbar,
#book-content .reader-object-dialog .reader-object-toolbar {
  display:flex!important; align-items:center!important; justify-content:flex-end!important;
  box-sizing:border-box!important; height:36px!important; margin:0!important; padding:2px!important;
}
#book-content .reader-object-toolbar button {
  font:14px/1.3 system-ui,sans-serif!important; color:var(--text-color)!important;
  background:var(--container-bg)!important; border:1px solid currentColor!important;
  border-radius:5px!important; padding:4px 10px!important; margin:0!important;
  cursor:pointer!important; text-indent:0!important; white-space:nowrap!important;
}
#book-content .reader-object-toolbar button::after { content:attr(aria-label); }
#reader-view.paged-mode #book-content .reader-object-viewport,
#book-content .reader-object-dialog .reader-object-viewport {
  display:block!important; min-width:0!important; min-height:0!important;
  height:100%!important; max-height:100%!important; width:100%!important;
  margin:0!important; padding:0!important; overflow:auto!important;
  overscroll-behavior:contain; touch-action:pan-x pan-y; scrollbar-gutter:stable;
}
#book-content .reader-object-viewport:focus-visible,
#book-content .reader-object-toolbar button:focus-visible { outline:2px solid currentColor; outline-offset:-2px; }
#reader-view.paged-mode #book-content .reader-object-viewport img,
#reader-view.paged-mode #book-content .reader-object-viewport svg,
#book-content .reader-object-dialog .reader-object-viewport img,
#book-content .reader-object-dialog .reader-object-viewport svg {
  max-height:none!important; height:auto!important; object-fit:contain!important;
}
#book-content .reader-object-placeholder {
  display:block!important; box-sizing:border-box!important; width:100%!important;
  height:var(--reader-object-height)!important; margin:0!important; padding:0!important;
  break-inside:avoid-column!important;
}
#book-content dialog.reader-object-dialog {
  position:fixed!important; inset:12px!important; box-sizing:border-box!important;
  width:calc(100vw - 24px)!important; height:calc(100dvh - 24px)!important;
  max-width:none!important; max-height:none!important; margin:0!important;
  padding:8px!important; border:1px solid currentColor!important; border-radius:8px!important;
  color:var(--text-color)!important; background:var(--container-bg)!important;
  font:inherit!important; overflow:hidden!important; text-align:initial;
}
#book-content dialog.reader-object-dialog:not([open]) { display:none!important; }
#book-content dialog.reader-object-dialog[open] { display:block!important; }
#book-content .reader-object-dialog .reader-object-shell { height:100%!important; }
#book-content .reader-object-dialog::backdrop { background:rgb(0 0 0 / .65); }
`;

const installations = new WeakMap();
const expandedObjects = new WeakMap();

export function wrapObject(elements, { height, kind = 'figure' }) {
    const nodes = Array.from(elements);
    const first = nodes[0];
    if (!first?.parentElement || !Number.isFinite(height) || height <= 36) return null;
    const parent = first.parentElement;
    if (nodes.some(node => node.parentElement !== parent)) return null;
    // Include intervening whitespace in the move so unwrapping restores exact source order.
    const moving = [];
    for (let node = first; node; node = node.nextSibling) {
        moving.push(node);
        if (node === nodes.at(-1)) break;
    }
    if (moving.at(-1) !== nodes.at(-1) || moving.some(node => node.nodeType === 1 && !nodes.includes(node))) return null;
    const doc = first.ownerDocument;
    const shell = doc.createElement('div');
    shell.className = 'reader-object-shell';
    shell.dataset.readerObjectKind = kind;
    shell.style.setProperty('--reader-object-height', `${height}px`);
    const toolbar = doc.createElement('div');
    toolbar.className = 'reader-object-toolbar';
    toolbar.dataset.readerUi = '';
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.readerObjectExpand = '';
    button.setAttribute('aria-label', kind === 'table' ? 'Tabloyu genişlet' : 'Görseli genişlet');
    button.setAttribute('aria-haspopup', 'dialog');
    toolbar.append(button);
    const viewport = doc.createElement('div');
    viewport.className = 'reader-object-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', kind === 'table' ? 'Kaydırılabilir tablo' : 'Kaydırılabilir görsel ve açıklaması');
    parent.insertBefore(shell, first);
    viewport.append(...moving);
    shell.append(toolbar, viewport);
    return shell;
}

export function unwrapObjects(section) {
    for (const shell of section.querySelectorAll('.reader-object-shell')) {
        expandedObjects.get(shell)?.close(false);
        const viewport = shell.querySelector(':scope > .reader-object-viewport');
        if (viewport && shell.parentNode) shell.replaceWith(...viewport.childNodes);
    }
}

// A book link may land in a row hidden by the object's own scrollport.
// Scroll only that port: Element.scrollIntoView would also turn the reader page.
export function revealReaderObjectTarget(target) {
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    const viewport = element?.closest('.reader-object-viewport');
    if (!viewport) return false;
    const bounds = viewport.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom) viewport.scrollTop += rect.top - bounds.top;
    if (rect.left < bounds.left || rect.right > bounds.right) viewport.scrollLeft += rect.left - bounds.left;
    return true;
}

export function installObjectView(root) {
    if (installations.has(root)) return installations.get(root);
    let active = null;
    const open = shell => {
        active?.close(false);
        const doc = shell.ownerDocument;
        const viewport = shell.querySelector(':scope > .reader-object-viewport');
        const button = shell.querySelector('[data-reader-object-expand]');
        const originalLabel = button.getAttribute('aria-label');
        const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
        const placeholder = doc.createElement('div');
        placeholder.className = 'reader-object-placeholder';
        placeholder.style.setProperty('--reader-object-height', shell.style.getPropertyValue('--reader-object-height'));
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.dataset.readerUi = '';
        const dialog = doc.createElement('dialog');
        dialog.className = 'reader-object-dialog';
        dialog.setAttribute('aria-label', shell.dataset.readerObjectKind === 'table' ? 'Tablo' : 'Görsel ve açıklaması');
        shell.before(placeholder, dialog);
        dialog.append(shell);
        button.setAttribute('aria-label', 'Kapat');
        button.removeAttribute('aria-haspopup');
        let closing = false;
        const close = (restoreFocus = true) => {
            if (closing) return;
            closing = true;
            if (dialog.open) dialog.close();
            placeholder.replaceWith(shell);
            dialog.remove();
            button.setAttribute('aria-label', originalLabel);
            button.setAttribute('aria-haspopup', 'dialog');
            viewport.scrollLeft = scroll.left;
            viewport.scrollTop = scroll.top;
            expandedObjects.delete(shell);
            active = null;
            if (restoreFocus && button.isConnected) button.focus({ preventScroll: true });
        };
        active = { shell, close };
        expandedObjects.set(shell, active);
        dialog.addEventListener('close', () => close());
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
        });
        dialog.showModal();
        viewport.scrollLeft = scroll.left;
        viewport.scrollTop = scroll.top;
        button.focus({ preventScroll: true });
    };
    const click = event => {
        const shell = event.target.closest?.('.reader-object-shell');
        if (!shell || !root.contains(shell)) return;
        event.stopPropagation();
        if (event.target.closest('[data-reader-object-expand]')) {
            event.preventDefault();
            if (expandedObjects.has(shell)) expandedObjects.get(shell).close();
            else open(shell);
        } else if (event.target.closest('a') && active) {
            // The caller's delegated link handler still receives this same event on root.
            active.close(false);
        }
    };
    const contain = event => {
        if (event.target.closest?.('.reader-object-shell, .reader-object-dialog')) event.stopPropagation();
    };
    root.addEventListener('click', click);
    for (const type of ['keydown', 'wheel', 'touchstart', 'touchend', 'pointerdown', 'pointerup']) root.addEventListener(type, contain, { passive: true });
    const observer = new root.ownerDocument.defaultView.MutationObserver(() => {
        if (active && !root.contains(active.shell)) active.close(false);
    });
    observer.observe(root, { childList: true, subtree: true });
    const dispose = () => {
        active?.close(false);
        observer.disconnect();
        root.removeEventListener('click', click);
        for (const type of ['keydown', 'wheel', 'touchstart', 'touchend', 'pointerdown', 'pointerup']) root.removeEventListener(type, contain);
        installations.delete(root);
    };
    installations.set(root, dispose);
    return dispose;
}
