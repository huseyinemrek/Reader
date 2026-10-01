import { createBookResources } from './cloud-reader.js';
import { readLayoutBundle } from './layout-bundle.js';

export function createServerBookResources(book, { signal, request, assetUrl }) {
    const base = location.origin + '/api/books/' + encodeURIComponent(book.id) + '/epub/';
    const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
    const layout = (async () => {
        for (;;) {
            signal.throwIfAborted();
            const response = await request('/api/books/' + encodeURIComponent(book.id) + '/layout', { signal });
            if (response.status === 202) {
                await response.body?.cancel();
                await new Promise((resolve, reject) => {
                    const abort = () => { clearTimeout(timer); reject(signal.reason); };
                    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
                    signal.addEventListener('abort', abort, { once: true });
                });
                continue;
            }
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Kitap düzen paketi hazırlanamadı.');
            }
            const index = await readLayoutBundle(await response.arrayBuffer());
            index.sourceVersion = response.headers.get('X-Reader-Source-Version');
            signal.throwIfAborted();
            return index;
        }
    })();
    // Reading a chapter can proceed while the background index is being produced.
    layout.catch(() => {});
    return createBookResources(book, { signal, source: {
        layout,
        async text(path, requestSignal) {
            const response = await request(base + encodePath(path), { signal: requestSignal });
            if (!response.ok) {
                const error = new Error('Kitap kaynağı alınamadı (' + response.status + ').');
                error.status = response.status;
                error.url = base + encodePath(path);
                throw error;
            }
            return response.text();
        },
        assetUrl: path => assetUrl(base + encodePath(path))
    } });
}
