import { wordOnScreen } from './reader-link-history.js';

const blockSelector = 'p,li,dd,dt,blockquote,pre,figcaption,td,th,h1,h2,h3,h4,h5,h6,div';
const excludedSelector = 'script,style,noscript,template,svg,canvas,iframe,object,audio,video,[data-reader-ui],[hidden],[aria-hidden="true"],button,input,select,textarea,[role="button"],[role="dialog"],[contenteditable="true"],.book-main-title,.pdf-page-image-column,.pdf-page-tools,.pdf-text-status,.pdf-empty-text,.pdf-equation,[data-latex],.katex,math';
const clickExcludedSelector = `${excludedSelector},a,[role="link"],label`;

// The book's original text nodes are the position model. Neither the paragraph
// highlight nor the optional CSS word highlight changes those nodes or selection.
export function createReaderTts({ content, getRoots, getStartWord, getContext, reveal,
    nextSection, onPosition, onState, speedSelect, voiceSelect }) {
    const document = content.ownerDocument;
    const view = document.defaultView;
    const synthesis = view.speechSynthesis;
    let active = false;
    let playing = false;
    let generation = 0;
    let bookId = null;
    let current = null;
    let run = null;
    let pending = null;
    let following = true;
    let highlightedBlock = null;
    let voices = [];
    let preferredVoice = preference('ttsVoice') || voiceSelect?.value || '';
    const ownScrolls = new WeakMap();
    let revealing = false;
    let pointer = null;

    function preference(key) {
        try { return view.localStorage.getItem(key); } catch { return null; }
    }

    function savePreference(key, value) {
        try { view.localStorage.setItem(key, value); } catch { /* Storage may be disabled. */ }
    }

    function context() {
        return getContext() || {};
    }

    function notify() {
        onState?.({ active, playing });
    }

    function isCurrent(token, id) {
        return active && generation === token && bookId === id && context().bookId === id;
    }

    function sectionOf(node) {
        for (let element = node?.nodeType === 1 ? node : node?.parentElement;
            element && element !== content; element = element.parentElement) {
            if (element.parentElement === content && element.tagName === 'SECTION') return element;
        }
        return null;
    }

    function readable(element) {
        if (element.matches(excludedSelector) || element.dataset.loaded === 'false') return false;
        const style = view.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    }

    function sourceRoots() {
        const roots = [...(getRoots() || [])].filter(root => root?.isConnected && content.contains(root));
        return roots.filter((root, index) => !roots.some((other, otherIndex) =>
            otherIndex !== index && (other === root ? otherIndex < index : other.contains(root))));
    }

    // Nested blocks own only their own text, so a <li><p> or nested <div> is never
    // spoken twice. Contiguous inline runs stay together, including split words.
    function collect() {
        const entries = [];
        function append(block, root, node, text) {
            if (!text) return;
            let entry = entries.at(-1);
            if (!entry || entry.block !== block || entry.root !== root || entry.canonical) {
                entry = { block, root, section: sectionOf(block), text: '', pieces: [], canonical: false };
                entries.push(entry);
            }
            const start = entry.text.length;
            entry.text += text;
            entry.pieces.push({ node, start, end: entry.text.length });
        }
        function canonical(element, root) {
            const text = element.dataset.ttsText;
            if (!text.trim()) return;
            const pieces = [];
            let cursor = 0;
            function gather(node) {
                if (node.nodeType === 3) {
                    const value = node.textContent;
                    if (!value) return;
                    const start = text.indexOf(value, cursor);
                    if (start >= 0) {
                        pieces.push({ node, start, end: start + value.length });
                        cursor = start + value.length;
                    }
                    return;
                }
                if (node.nodeType !== 1 || !readable(node)) return;
                for (const child of node.childNodes) gather(child);
            }
            for (const child of element.childNodes) gather(child);
            if (pieces.length) entries.push({ block: element, root, section: sectionOf(element),
                text, pieces, canonical: true });
        }
        function walk(node, root, block) {
            if (node.nodeType === 3) {
                append(block, root, node, node.textContent);
                return;
            }
            if (node.nodeType !== 1 || !readable(node)) return;
            if (node.hasAttribute('data-tts-text')) {
                canonical(node, root);
                return;
            }
            const owner = node.matches(blockSelector) ? node : block;
            for (const child of node.childNodes) {
                if (child.nodeType === 1 && child.tagName === 'BR') {
                    // A source line break separates words without inventing a DOM node.
                    const entry = entries.at(-1);
                    if (entry?.block === owner && entry.root === root) entry.text += '\n';
                } else walk(child, root, owner);
            }
        }
        for (const root of sourceRoots()) {
            let allowed = true;
            for (let parent = root.parentElement; parent; parent = parent.parentElement) {
                if (!readable(parent)) { allowed = false; break; }
            }
            if (allowed) walk(root, root, root);
        }
        return entries.filter(entry => {
            entry.words = [...entry.text.matchAll(/\S+/gu)].map(match =>
                ({ start: match.index, end: match.index + match[0].length }));
            return entry.section && entry.words.some(word =>
                entry.pieces.some(piece => piece.start <= word.start && piece.end > word.start) &&
                entry.pieces.some(piece => piece.start < word.end && piece.end >= word.end));
        });
    }

    function wordAt(entry, offset) {
        return entry.words.find(word => word.end > offset) || null;
    }

    function wordRange(entry, word) {
        if (!word) return null;
        const first = entry.pieces.find(piece => piece.start <= word.start && piece.end > word.start);
        const last = entry.pieces.find(piece => piece.start < word.end && piece.end >= word.end);
        if (!first?.node.isConnected || !last?.node.isConnected) return null;
        const range = document.createRange();
        range.setStart(first.node, word.start - first.start);
        range.setEnd(last.node, word.end - last.start);
        return range;
    }

    function fromRange(range, entries) {
        if (!range || !content.contains(range.startContainer)) return null;
        for (const entry of entries) {
            const piece = entry.pieces.find(part => part.node === range.startContainer &&
                range.startOffset >= 0 && range.startOffset < part.end - part.start);
            if (!piece) continue;
            const offset = piece.start + range.startOffset;
            const word = wordAt(entry, offset);
            const sourceRange = wordRange(entry, word);
            if (sourceRange) return { entry, offset: word.start, range: sourceRange };
        }
        return null;
    }

    function validPosition(position = current) {
        return !!position && active && context().bookId === bookId &&
            position.entry.section.isConnected && content.contains(position.range.startContainer) &&
            content.contains(position.range.endContainer);
    }

    function clearHighlight() {
        highlightedBlock?.classList.remove('tts-highlight');
        highlightedBlock = null;
        view.CSS?.highlights?.delete('reader-tts-word');
    }

    function highlight(position) {
        if (highlightedBlock !== position.entry.block) {
            highlightedBlock?.classList.remove('tts-highlight');
            highlightedBlock = position.entry.block;
            highlightedBlock.classList.add('tts-highlight');
        }
        if (view.CSS?.highlights && typeof view.Highlight === 'function') {
            view.CSS.highlights.set('reader-tts-word', new view.Highlight(position.range));
        }
    }

    function bounds() {
        const viewport = content.closest('#book-viewport') || content.parentElement;
        const rect = viewport.getBoundingClientRect();
        return { left: Math.max(0, rect.left), right: Math.min(view.innerWidth, rect.right),
            top: context().paged ? Math.max(0, rect.top) : 0,
            bottom: context().paged ? Math.min(view.innerHeight, rect.bottom) : view.innerHeight };
    }

    function onScreen(position = current) {
        if (!validPosition(position)) return false;
        const box = bounds();
        if (wordOnScreen(position.range, box)) return true;
        // A source word can cross <em>/<span> nodes; its centre then belongs to a
        // different inline parent than the shared single-node helper expects.
        const rect = position.range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.left < box.left - 1 ||
            rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1) return false;
        for (let parent = position.range.startContainer.parentElement; parent && parent !== content;
            parent = parent.parentElement) {
            if (!parent.matches('.reader-object-viewport,.pdf-page-text')) continue;
            const clip = parent.getBoundingClientRect();
            if (rect.left < clip.left - 1 || rect.right > clip.right + 1 ||
                rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1) return false;
        }
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && position.entry.block.contains(hit);
    }

    function scrollPosition(target) {
        return target === view ? { left: view.scrollX, top: view.scrollY }
            : { left: target.scrollLeft, top: target.scrollTop };
    }

    function followPosition() {
        if (!validPosition() || context().busy) return;
        if (!following && onScreen()) following = true;
        if (!following) return;
        const targets = [view];
        for (let parent = current.range.startContainer.parentElement; parent; parent = parent.parentElement) {
            targets.push(parent);
        }
        const before = targets.map(scrollPosition);
        revealing = true;
        try { reveal?.(current.range); } finally {
            targets.forEach((target, index) => {
                const after = scrollPosition(target);
                if (after.left !== before[index].left || after.top !== before[index].top) ownScrolls.set(target, after);
            });
            revealing = false;
        }
    }

    function setPosition(entry, offset) {
        const word = wordAt(entry, offset);
        const range = wordRange(entry, word);
        if (!range) return false;
        const token = generation;
        current = { entry, offset: word.start, range };
        highlight(current);
        onPosition?.(range);
        if (isCurrent(token, bookId)) followPosition();
        return true;
    }

    function cancel() {
        // Invalidate first: some implementations synchronously emit cancellation
        // errors, and others deliver them after the replacement utterance starts.
        generation++;
        run = null;
        pending = null;
        synthesis?.cancel();
    }

    function stop() {
        active = false;
        playing = false;
        cancel();
        current = null;
        bookId = null;
        following = true;
        clearHighlight();
        notify();
    }

    function fail(error, token, id) {
        if (!isCurrent(token, id)) return;
        run = null;
        playing = false;
        pending = null;
        console.warn('Reader TTS stopped at the current word:', error);
        notify();
    }

    function speak(position) {
        const token = generation;
        const id = bookId;
        if (!isCurrent(token, id) || !synthesis || !position) return false;
        if (!setPosition(position.entry, position.offset) || !isCurrent(token, id)) return false;
        const entry = current.entry;
        const offset = current.offset;
        const text = entry.text.slice(offset).trimEnd();
        if (!text) return false;
        const utterance = new view.SpeechSynthesisUtterance(text);
        const rate = Number.parseFloat(speedSelect?.value);
        utterance.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
        const selected = voices.find(voice => voice.name === voiceSelect?.value);
        if (selected) {
            utterance.voice = selected;
            utterance.lang = selected.lang;
        } else utterance.lang = 'tr-TR';
        const identity = { utterance, entry, offset, token, id };
        run = identity;
        playing = true;
        const live = () => run === identity && isCurrent(token, id) && validPosition();
        utterance.onboundary = event => {
            if (!live() || !playing || !Number.isInteger(event.charIndex) ||
                event.charIndex < 0 || event.charIndex >= text.length) return;
            // Without boundary events the utterance's starting word remains the
            // only known position; no timer or estimated speech speed advances it.
            setPosition(entry, offset + event.charIndex);
        };
        utterance.onend = () => {
            if (!live()) return;
            run = null;
            if (playing) void move(entry, 1, token, id);
        };
        utterance.onerror = event => {
            if (!live()) return;
            fail(event.error || event, token, id);
        };
        notify();
        if (!live() || !playing) return false;
        try {
            // cancel() clears the queue but does not reset the browser's paused flag.
            if (synthesis.paused) synthesis.resume();
            synthesis.speak(utterance);
        } catch (error) { fail(error, token, id); }
        return playing;
    }

    function firstPosition(entry) {
        for (const word of entry.words) {
            const range = wordRange(entry, word);
            if (range) return { entry, offset: word.start, range };
        }
        return null;
    }

    function matchingEntry(entries, entry) {
        return entries.findIndex(candidate => candidate.block === entry.block &&
            candidate.pieces.some(piece => entry.pieces.some(previous => previous.node === piece.node)));
    }

    async function move(entry, direction, token, id) {
        const live = () => isCurrent(token, id) && playing;
        if (!live()) return;
        try {
            let entries = collect().filter(candidate => candidate.section === entry.section);
            const index = matchingEntry(entries, entry);
            if (index >= 0 && entries[index + direction]) {
                speak(firstPosition(entries[index + direction]));
                return;
            }
            let section = entry.section;
            const visited = new Set([section]);
            while (live()) {
                const next = await nextSection?.(section, direction, live);
                if (!live()) return;
                if (!next) {
                    if (direction < 0 && index === 0) speak(firstPosition(entries[0]));
                    else stop();
                    return;
                }
                section = sectionOf(next);
                if (!section || visited.has(section)) {
                    fail(new Error('Adjacent reader section did not advance.'), token, id);
                    return;
                }
                visited.add(section);
                entries = collect().filter(candidate => candidate.section === section);
                if (!entries.length) continue; // Source image/empty pages have no prose to speak.
                const target = direction < 0 ? entries.at(-1) : entries[0];
                speak(firstPosition(target));
                return;
            }
        } catch (error) {
            if (live()) fail(error, token, id);
        }
    }

    function viewStart() {
        return fromRange(getStartWord(), collect());
    }

    function start() {
        cancel();
        const state = context();
        if (!synthesis || typeof view.SpeechSynthesisUtterance !== 'function' || !state.bookId) {
            stop();
            return false;
        }
        bookId = state.bookId;
        active = true;
        playing = false;
        following = true;
        current = null;
        clearHighlight();
        loadVoices();
        if (state.busy) {
            pending = 'start';
            notify();
            return false;
        }
        const position = viewStart();
        if (!position) { stop(); return false; }
        return speak(position);
    }

    function navigation() {
        if (!active) return;
        cancel();
        playing = false;
        current = null;
        following = true;
        clearHighlight();
        notify();
    }

    function resume() {
        if (context().busy) {
            pending = 'resume';
            return;
        }
        if (validPosition() && onScreen()) {
            following = true;
            if (run && synthesis.paused) {
                playing = true;
                synthesis.resume();
                notify();
                followPosition();
            } else {
                const position = current;
                cancel();
                speak(position);
            }
            return;
        }
        const position = viewStart();
        cancel();
        following = true;
        if (position) speak(position);
        else stop();
    }

    function togglePlayPause() {
        if (!active) return;
        if (context().bookId !== bookId) { stop(); return; }
        if (!playing) { resume(); return; }
        playing = false;
        pending = null;
        synthesis.pause();
        notify();
    }

    async function step(direction) {
        if (!active || context().busy || context().bookId !== bookId) return;
        const position = validPosition() ? current : viewStart();
        cancel();
        if (!position) { stop(); return; }
        following = true;
        playing = true;
        notify();
        await move(position.entry, direction < 0 ? -1 : 1, generation, bookId);
    }

    function restart() {
        if (!active || context().bookId !== bookId) return;
        if (!playing) {
            // A changed voice/rate applies on Play, without starting a paused player.
            if (run) cancel();
            return;
        }
        if (context().busy) {
            cancel();
            playing = false;
            pending = 'restart';
            notify();
            return;
        }
        const position = validPosition() ? current : viewStart();
        cancel();
        if (position) speak(position);
        else stop();
    }

    function layoutChanged() {
        if (!active) return;
        if (context().bookId !== bookId) { stop(); return; }
        if (context().busy) return;
        const action = pending;
        pending = null;
        if (action === 'start') { start(); return; }
        if (action === 'resume') { resume(); return; }
        if (action === 'restart') {
            const position = validPosition() ? current : viewStart();
            if (position) speak(position);
            else stop();
            return;
        }
        // Geometry may change, but a DOM-preserving reflow must never cancel or
        // recreate the live utterance, including when the player is paused.
        followPosition();
    }

    function loadVoices() {
        if (!synthesis) return;
        voices = synthesis.getVoices();
        if (!voiceSelect || !voices.length) return;
        const previous = voiceSelect.value;
        const turkish = voices.filter(voice => /^tr(?:-|$)/i.test(voice.lang));
        const other = voices.filter(voice => !/^tr(?:-|$)/i.test(voice.lang));
        turkish.sort((a, b) => Number(/natural/i.test(b.name)) - Number(/natural/i.test(a.name)) ||
            a.name.localeCompare(b.name));
        other.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
        const fragment = document.createDocumentFragment();
        function addVoice(parent, voice) {
            const option = document.createElement('option');
            option.value = voice.name;
            option.textContent = voice.name.replace('Microsoft ', '').replace('Online (Natural) - ', '🤖 ');
            parent.appendChild(option);
        }
        for (const voice of turkish) addVoice(fragment, voice);
        if (other.length) {
            const group = document.createElement('optgroup');
            group.label = 'İngilizce ve Diğer Sesler';
            for (const voice of other) addVoice(group, voice);
            fragment.appendChild(group);
        }
        voiceSelect.replaceChildren(fragment);
        const selected = voices.find(voice => voice.name === preferredVoice) ||
            voices.find(voice => voice.name === previous) ||
            turkish.find(voice => /Ahmet/i.test(voice.name) && /natural/i.test(voice.name)) ||
            turkish[0] || voices.find(voice => voice.default) || voices[0];
        voiceSelect.value = selected.name;
    }

    function handleScroll(event) {
        if (!active || !validPosition() || revealing || context().busy) return;
        let target = event.target;
        if (target === document || target === document.documentElement || target === document.body || target === view) target = view;
        if (target !== view && (!target?.contains || (!content.contains(target) && !target.contains(content)))) return;
        const expected = ownScrolls.get(target);
        const actual = scrollPosition(target);
        if (expected && Math.abs(expected.left - actual.left) <= 1 && Math.abs(expected.top - actual.top) <= 1) return;
        ownScrolls.delete(target);
        following = onScreen();
    }
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    view.addEventListener('scroll', handleScroll, { passive: true });

    content.addEventListener('pointerdown', event => {
        pointer = active && event.button === 0 && !event.target.closest(clickExcludedSelector)
            ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
    });
    content.addEventListener('pointermove', event => {
        if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) pointer.moved = true;
    });
    content.addEventListener('pointercancel', () => { pointer = null; });
    content.addEventListener('click', event => {
        const gesture = pointer;
        pointer = null;
        if (!active || context().busy || context().bookId !== bookId || event.button !== 0 ||
            event.detail !== 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            gesture?.moved || event.target.closest(clickExcludedSelector)) return;
        const selection = view.getSelection();
        if (selection && !selection.isCollapsed) return;
        let range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        if (!range && document.caretPositionFromPoint) {
            const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
            if (caret) {
                range = document.createRange();
                range.setStart(caret.offsetNode, caret.offset);
                range.collapse(true);
            }
        }
        const position = fromRange(range, collect());
        if (!position) return;
        event.stopPropagation();
        cancel();
        following = true;
        speak(position);
    });

    const savedSpeed = preference('ttsSpeed');
    if (savedSpeed && speedSelect) speedSelect.value = savedSpeed;
    speedSelect?.addEventListener('change', () => {
        savePreference('ttsSpeed', speedSelect.value);
        restart();
    });
    voiceSelect?.addEventListener('change', () => {
        preferredVoice = voiceSelect.value;
        savePreference('ttsVoice', preferredVoice);
        restart();
    });
    synthesis?.addEventListener('voiceschanged', loadVoices);
    loadVoices();

    return {
        get active() { return active; },
        get playing() { return playing; },
        range: () => validPosition() ? current.range : null,
        section: () => validPosition() ? current.entry.section : null,
        start, stop, togglePlayPause, step, restart, navigation, layoutChanged, loadVoices
    };
}
