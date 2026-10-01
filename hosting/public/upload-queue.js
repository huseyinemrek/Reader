const STAGES = new Set(['preparing', 'sending', 'finalizing']);
const LABELS = {
    queued: 'Queued', preparing: 'Preparing', sending: 'Sending', finalizing: 'Finalizing',
    complete: 'Finished', failed: 'Failed', retry: 'Retry', dismiss: 'Dismiss', cancel: 'Cancel',
    region: 'Background book uploads'
};
const STYLE = `
.reader-upload-queue{position:fixed;left:max(12px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));z-index:1100;display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;max-width:min(420px,calc(100vw - 24px));max-height:35vh;overflow:auto;padding:4px;pointer-events:none;font:12px/1.4 system-ui,sans-serif;color:#172033}
.reader-upload-queue:empty{display:none}
.reader-upload-item{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:4px;max-width:160px}
.reader-upload-badge{position:relative;box-sizing:border-box;display:grid;place-items:center;width:48px;height:48px;flex:none;border-radius:50%;background:conic-gradient(#2563eb calc(var(--upload-percent,0)*1%),#d7dce5 0);box-shadow:0 2px 8px #0003;font-size:11px;font-weight:700}
.reader-upload-badge:before{content:'';position:absolute;inset:4px;border-radius:50%;background:#fff}
.reader-upload-badge span{position:relative}
.reader-upload-item[data-indeterminate=true] .reader-upload-badge{background:#d7dce5}
.reader-upload-item[data-indeterminate=true][data-status=running] .reader-upload-badge:after{content:'';position:absolute;inset:0;border:3px solid transparent;border-top-color:#2563eb;border-radius:50%;animation:reader-upload-spin 1.2s linear infinite}
.reader-upload-item[data-status=failed] .reader-upload-badge{background:#b91c1c;color:#b91c1c}
.reader-upload-item[data-status=complete] .reader-upload-badge{background:#15803d;color:#15803d}
.reader-upload-actions{display:flex;gap:4px}
.reader-upload-actions button{font:inherit;padding:3px 6px;border:1px solid #d7dce5;border-radius:5px;background:#fff;color:#172033;cursor:pointer;box-shadow:0 1px 4px #0002}
.reader-upload-actions button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.reader-upload-error{margin:0;padding:4px 6px;border-radius:5px;background:#fff;color:#b91c1c;overflow-wrap:anywhere;box-shadow:0 1px 4px #0002}
@keyframes reader-upload-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.reader-upload-item[data-indeterminate=true][data-status=running] .reader-upload-badge:after{animation:none}}
`;

function abortError() {
    return new DOMException('Upload cancelled', 'AbortError');
}

/**
 * Sequential, tab-lifetime upload queue. run(file, context) must resolve only after
 * the book is committed. context = { report, signal, ownerKey, throwIfCancelled }.
 * report({stage, loaded?, total?, detail?, name?}) uses actual aggregate transfer
 * bytes; omit loaded/total for unknown work. Preparation never invents a percent.
 * Capture ownerKey for all writes and call throwIfCancelled before committing.
 * onComplete(book, {ownerKey, signal}) refreshes the library, never the reader.
 * Call cancelOwner(oldOwner) BEFORE logout/account switching. getOwnerKey provides
 * an additional live-owner guard. File references survive failures only for retry.
 */
export function createUploadQueue({ run, onComplete = () => {}, getOwnerKey, labels = {}, completedLifetime = 4000 } = {}) {
    if (typeof run !== 'function') throw new TypeError('An upload runner is required');
    if (typeof onComplete !== 'function') throw new TypeError('onComplete must be a function');
    if (getOwnerKey !== undefined && typeof getOwnerKey !== 'function') throw new TypeError('getOwnerKey must be a function');
    const words = { ...LABELS, ...labels };
    const items = [];
    let owner = null;
    let active = null;
    let sequence = 0;
    let destroyed = false;
    let warningAttached = false;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    const element = document.createElement('section');
    element.className = 'reader-upload-queue';
    element.setAttribute('aria-label', words.region);
    document.body.append(element);

    function snapshot(item) {
        return {
            id: item.id, ownerKey: item.ownerKey, name: item.name, status: item.status,
            stage: item.stage, detail: item.detail, percent: item.percent,
            loaded: item.loaded, total: item.total, error: item.error
        };
    }
    function beforeUnload(event) {
        event.preventDefault();
        event.returnValue = '';
    }
    function updateWarning() {
        const pending = items.some(item => item.status === 'queued' || item.status === 'running');
        if (pending === warningAttached) return;
        warningAttached = pending;
        window[pending ? 'addEventListener' : 'removeEventListener']('beforeunload', beforeUnload);
    }
    function current(item) {
        return !destroyed && !item.controller.signal.aborted && owner === item.ownerKey &&
            (!getOwnerKey || getOwnerKey() === item.ownerKey);
    }
    function throwIfCancelled(item) {
        if (!current(item)) throw abortError();
    }
    function render(item) {
        const stage = words[item.stage] || item.stage;
        const text = [item.name, stage, item.percent === null ? '' : `${item.percent}%`, item.detail, item.error].filter(Boolean).join(' — ');
        item.node.dataset.status = item.status;
        item.node.dataset.stage = item.stage;
        item.node.dataset.percent = item.percent === null ? '' : String(item.percent);
        item.node.dataset.indeterminate = String(item.percent === null);
        item.node.title = text;
        item.badge.title = text;
        item.badge.setAttribute('aria-label', text);
        item.badge.setAttribute('role', item.status === 'failed' ? 'status' : 'progressbar');
        item.badge.setAttribute('aria-valuemin', '0');
        item.badge.setAttribute('aria-valuemax', '100');
        item.badge.setAttribute('aria-valuetext', text);
        if (item.percent === null) item.badge.removeAttribute('aria-valuenow');
        else item.badge.setAttribute('aria-valuenow', String(item.percent));
        item.badge.style.setProperty('--upload-percent', item.percent ?? 0);
        item.value.textContent = item.percent !== null ? `${item.percent}%` : item.status === 'failed' ? '!' : item.status === 'queued' ? '—' : '…';
        const actionState = item.status === 'queued' || item.status === 'running' ? 'pending' : item.status;
        if (item.actionState !== actionState) {
            item.actionState = actionState;
            item.actions.replaceChildren();
            const button = (label, action) => {
                const node = document.createElement('button');
                node.type = 'button';
                node.dataset.action = label;
                node.textContent = words[label];
                node.addEventListener('click', action);
                item.actions.append(node);
            };
            if (item.status === 'failed') button('retry', () => retry(item.id));
            button(actionState === 'pending' ? 'cancel' : 'dismiss', () => dismiss(item.id));
        }
        for (const node of item.actions.children) {
            node.setAttribute('aria-label', `${words[node.dataset.action]}: ${item.name}`);
        }
        item.errorNode.textContent = item.error || '';
        item.errorNode.hidden = !item.error;
    }
    function remove(item) {
        clearTimeout(item.timer);
        item.controller.abort();
        item.file = null;
        item.node.remove();
        const index = items.indexOf(item);
        if (index !== -1) items.splice(index, 1);
        updateWarning();
    }
    function report(item, progress = {}) {
        if (!current(item) || item.status !== 'running') return;
        if (STAGES.has(progress.stage)) item.stage = progress.stage;
        if (typeof progress.name === 'string' && progress.name.trim()) item.name = progress.name;
        item.detail = typeof progress.detail === 'string' ? progress.detail : '';
        const known = item.stage === 'sending' && Number.isFinite(progress.loaded) && progress.loaded >= 0 &&
            Number.isFinite(progress.total) && progress.total > 0;
        item.loaded = known ? Math.min(progress.loaded, progress.total) : null;
        item.total = known ? progress.total : null;
        // Network completion is not a successful commit. Only run's resolution
        // can advance to 100%; a subsequent transfer may report a new aggregate.
        item.percent = known ? Math.min(99, Math.floor(100 * item.loaded / item.total)) : null;
        render(item);
    }
    async function pump() {
        if (active || destroyed) return;
        const item = items.find(candidate => candidate.status === 'queued');
        if (!item) return;
        if (!current(item)) {
            cancelOwner(item.ownerKey);
            return;
        }
        active = item;
        item.status = 'running';
        item.stage = 'preparing';
        render(item);
        try {
            const book = await run(item.file, {
                report: progress => report(item, progress), signal: item.controller.signal,
                ownerKey: item.ownerKey, throwIfCancelled: () => throwIfCancelled(item)
            });
            throwIfCancelled(item);
            item.file = null;
            item.status = 'complete';
            item.stage = 'complete';
            item.detail = '';
            item.percent = 100;
            render(item);
            if (completedLifetime > 0) item.timer = setTimeout(() => remove(item), completedLifetime);
            // A library refresh failure must never offer retry of a committed book.
            Promise.resolve().then(() => {
                if (current(item)) return onComplete(book, { ownerKey: item.ownerKey, signal: item.controller.signal });
            }).catch(error => console.error('Upload completion callback failed:', error));
        } catch (error) {
            if (!current(item)) remove(item);
            else {
                item.status = 'failed';
                item.stage = 'failed';
                item.percent = null;
                item.error = error?.message || String(error);
                render(item);
            }
        } finally {
            active = null;
            updateWarning();
            void pump();
        }
    }
    function add(files, ownerKey) {
        if (destroyed) throw new Error('Upload queue has been destroyed');
        if (typeof ownerKey !== 'string' || !ownerKey) throw new TypeError('A nonempty owner key is required');
        if (getOwnerKey && getOwnerKey() !== ownerKey) throw new Error('Upload owner is not signed in');
        if (owner !== null && owner !== ownerKey) throw new Error('Cancel the previous upload owner before switching accounts');
        const selected = Array.from(files);
        if (selected.some(file => !file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function')) {
            throw new TypeError('Uploads must be File objects');
        }
        owner = ownerKey;
        const ids = [];
        for (const file of selected) {
            const item = {
                id: `upload-${++sequence}`, ownerKey, file, name: file.name, status: 'queued', stage: 'queued',
                detail: '', percent: null, loaded: null, total: null, error: null, controller: new AbortController(), timer: null,
                node: document.createElement('div'), badge: document.createElement('div'), value: document.createElement('span'),
                actions: document.createElement('div'), errorNode: document.createElement('p')
            };
            item.node.className = 'reader-upload-item';
            item.node.dataset.uploadId = item.id;
            item.badge.className = 'reader-upload-badge';
            item.actions.className = 'reader-upload-actions';
            item.errorNode.className = 'reader-upload-error';
            item.badge.append(item.value);
            item.node.append(item.badge, item.actions, item.errorNode);
            items.push(item);
            element.append(item.node);
            render(item);
            ids.push(item.id);
        }
        updateWarning();
        void pump();
        return ids;
    }
    function retry(id) {
        const item = items.find(candidate => candidate.id === id);
        if (!item || item.status !== 'failed' || !current(item)) return false;
        item.status = 'queued';
        item.stage = 'queued';
        item.detail = '';
        item.error = null;
        item.loaded = item.total = item.percent = null;
        render(item);
        updateWarning();
        void pump();
        return true;
    }
    function dismiss(id) {
        const item = items.find(candidate => candidate.id === id);
        if (!item) return false;
        remove(item);
        void pump();
        return true;
    }
    function cancelOwner(ownerKey) {
        if (owner !== ownerKey) return;
        owner = null;
        for (const item of [...items]) if (item.ownerKey === ownerKey) remove(item);
    }
    function destroy() {
        destroyed = true;
        owner = null;
        for (const item of [...items]) remove(item);
        element.remove();
        style.remove();
    }
    return { add, cancelOwner, retry, dismiss, destroy, element, get state() { return items.map(snapshot); } };
}

/** POST FormData with real XHR byte progress; resolves the server's JSON body.
 * Tokens/cookies are never sent to another origin. HTTP errors retain status,
 * parsed body and server error text for the queue's visible failure/retry UI.
 */
export function uploadHttp(url, formData, { token, signal, onProgress = () => {} } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason || abortError()); return; }
        const target = new URL(url, location.href);
        const sameOrigin = target.origin === location.origin;
        if (target.username || target.password) { reject(new Error('Upload URLs must not contain credentials')); return; }
        const xhr = new XMLHttpRequest();
        let settled = false;
        const finish = (error, body) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            xhr.upload.onprogress = xhr.upload.onload = null;
            xhr.onload = xhr.onerror = xhr.onabort = null;
            if (error) reject(error); else resolve(body);
        };
        const abort = () => {
            xhr.abort();
            finish(signal?.reason || abortError());
        };
        try {
            xhr.open('POST', target.href);
            xhr.withCredentials = false;
            if (sameOrigin && token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.upload.onprogress = event => onProgress({
                stage: 'sending', loaded: event.loaded, total: event.lengthComputable ? event.total : undefined
            });
            xhr.upload.onload = () => onProgress({ stage: 'finalizing' });
            xhr.onload = () => {
                let body;
                try { body = JSON.parse(xhr.responseText); }
                catch (_) {
                    const error = new Error(xhr.status >= 200 && xhr.status < 300 ? 'Server returned invalid upload JSON' : `Upload failed (HTTP ${xhr.status})`);
                    error.status = xhr.status;
                    finish(error);
                    return;
                }
                if (xhr.status < 200 || xhr.status >= 300) {
                    const message = typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message;
                    const error = new Error(message || `Upload failed (HTTP ${xhr.status})`);
                    error.status = xhr.status;
                    error.body = body;
                    finish(error);
                } else finish(null, body);
            };
            xhr.onerror = () => finish(new Error('Upload network error'));
            xhr.onabort = () => finish(signal?.reason || abortError());
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            onProgress({ stage: 'sending' });
            xhr.send(formData);
        } catch (error) { finish(error); }
    });
}
