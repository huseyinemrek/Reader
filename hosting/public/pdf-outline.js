/** Resolve real PDF bookmarks to one-based reader pages; preserve unresolved groups. */
export async function loadPdfOutline(pdf, signal) {
    signal?.throwIfAborted();
    const outline = await pdf.getOutline();
    signal?.throwIfAborted();
    async function resolve(entries) {
        return Promise.all(entries.map(async entry => {
            signal?.throwIfAborted();
            let page = null;
            if (entry.dest) {
                try {
                    const destination = typeof entry.dest === 'string'
                        ? await pdf.getDestination(entry.dest) : entry.dest;
                    signal?.throwIfAborted();
                    if (Array.isArray(destination) && destination.length) {
                        const reference = destination[0];
                        const index = Number.isInteger(reference) ? reference
                            : reference && typeof reference === 'object' ? await pdf.getPageIndex(reference) : -1;
                        signal?.throwIfAborted();
                        if (Number.isInteger(index) && index >= 0 && index < pdf.numPages) page = index + 1;
                    }
                } catch (error) {
                    signal?.throwIfAborted();
                    console.warn('PDF bookmark destination could not be resolved:', entry.title, error);
                }
            }
            const items = await resolve(entry.items || []);
            signal?.throwIfAborted();
            return { title: entry.title, page, bold: entry.bold, italic: entry.italic, items };
        }));
    }
    return resolve(outline || []);
}

/** Append nested bookmark labels. onNavigate(page, entry, event) owns reader state. */
export function renderPdfToc(entries, list, { bookId, onNavigate }) {
    const targetDocument = list.ownerDocument;
    for (const entry of entries) {
        const item = targetDocument.createElement('li');
        const label = targetDocument.createElement(entry.page ? 'a' : 'span');
        label.textContent = entry.title;
        if (entry.bold) label.style.fontWeight = 'bold';
        if (entry.italic) label.style.fontStyle = 'italic';
        if (entry.page) {
            label.href = '/book/' + encodeURIComponent(bookId) + '?page=' + entry.page;
            label.dataset.pdfPage = entry.page;
            label.title = 'PDF sayfası ' + entry.page;
            if (onNavigate) label.addEventListener('click', event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                return onNavigate(entry.page, entry, event);
            });
        } else label.className = 'toc-group-title';
        item.appendChild(label);
        if (entry.items.length) {
            const children = targetDocument.createElement('ul');
            renderPdfToc(entry.items, children, { bookId, onNavigate });
            item.appendChild(children);
        }
        list.appendChild(item);
    }
}
