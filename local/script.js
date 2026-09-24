document.addEventListener('DOMContentLoaded', () => {
    // --- Initial Config ---
    let currentBookId = null;
    let scrollSaveTimeout = null;
    let globalLibrary = []; // API'den gelen kitapları tutar
    
    // Page counts are measured per chapter; no archive or chapter HTML cache.
    let currentBookType = null;
    let epubSpine = [];
    let currentChapterIndex = 0;
    let localPagedIndex = 0;
    let currentGlobalPage = 1;
    let totalBookPages = 0;
    let currentPdfDoc = null;
    let currentPdfPage = 1;
    let totalPdfPages = 0;
    let isNavigatingPage = false;
    let scrollWindowBusy = false;
    let session = 0;
    let locationVersion = 0;
    let sessionAbort = new AbortController();
    let paginationAbort = new AbortController();
    let paginationPromise = Promise.resolve();
    let layoutKey = '';
    let layoutTimer = null;
    let layoutPosition = null;
    let resourceBase = '';
    let htmlSource = '';
    let pendingProgress = null;
    let progressWrite = Promise.resolve();
    const stylesheetCache = new Map();
    const libraryView = document.getElementById('library-view');
    const readerView = document.getElementById('reader-view');
    const libraryGrid = document.getElementById('library-grid');
    const fileInput = document.getElementById('book-upload');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    
    const bookContent = document.getElementById('book-content');
    const currentBookTitle = document.getElementById('current-book-title');
    const backToLibraryBtn = document.getElementById('back-to-library');
    
    const bookViewport = document.getElementById('book-viewport');
    const pagedPrevBtn = document.getElementById('paged-prev-btn');
    const pagedNextBtn = document.getElementById('paged-next-btn');
    const pagedIndicator = document.getElementById('paged-indicator');
    const pagedPageText = document.getElementById('paged-page-text');
    const modeScrollBtn = document.getElementById('mode-scroll-btn');
    const modePagedBtn = document.getElementById('mode-paged-btn');
    const originalPdfSetting = document.getElementById('original-pdf-setting');
    const openOriginalPdf = document.getElementById('open-original-pdf');
    const openPageJumpBtn = document.getElementById('open-page-jump');
    const pageJumpModal = document.getElementById('page-jump-modal');
    const pageJumpClose = document.getElementById('page-jump-close');
    const pageJumpInput = document.getElementById('page-jump-input');
    const pageJumpSlider = document.getElementById('page-jump-slider');
    const pageJumpSubmit = document.getElementById('page-jump-submit');
    const jumpTotalPages = document.getElementById('jump-total-pages');
    const progressBar = document.getElementById('progress-bar');
    // Sidebars
    const tocToggle = document.getElementById('toc-toggle');
    const tocSidebar = document.getElementById('toc-sidebar');
    const tocClose = document.getElementById('toc-close');
    const tocList = document.getElementById('toc-list');
    
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const settingsClose = document.getElementById('settings-close');
    const deleteBookBtn = document.getElementById('delete-book-btn');
    const saveDefaultSettingsBtn = document.getElementById('save-default-settings-btn');
    const resetSettingsBtn = document.getElementById('reset-settings-btn');

    // Setting Inputs
    const bgColorPicker = document.getElementById('bg-color-picker');
    const containerBgPicker = document.getElementById('container-bg-picker');
    const textColorPicker = document.getElementById('text-color-picker');
    const fontFamilySelect = document.getElementById('font-family-select');
    const fontSizeSlider = document.getElementById('font-size-slider');
    const fontSizeVal = document.getElementById('font-size-val');
    const lineHeightSlider = document.getElementById('line-height-slider');
    const lineHeightVal = document.getElementById('line-height-val');
    const maxWidthSlider = document.getElementById('max-width-slider');
    const maxWidthVal = document.getElementById('max-width-val');
    const sidePaddingSlider = document.getElementById('side-padding-slider');
    const sidePaddingVal = document.getElementById('side-padding-val');
    const paragraphSpacingSlider = document.getElementById('paragraph-spacing-slider');
    const paragraphSpacingVal = document.getElementById('paragraph-spacing-val');
    const themeBtns = document.querySelectorAll('.theme-btn');

    // --- Settings & Storage ---
    let defaultSettings = {
        bgColor: '#181818',
        containerBg: '#333333',
        textColor: '#cca922',
        fontSize: '24',
        lineHeight: '2.0',
        fontFamily: "'Inter', sans-serif",
        maxWidth: '900',
        sidePadding: '80',
        paragraphSpacing: '1.5',
        readingMode: 'scroll'
    };

    let currentSettings = { ...defaultSettings };

    function loadSettings() {
        const userDefault = localStorage.getItem('edgeReaderUserDefaultSettings');
        if (userDefault) {
            try { defaultSettings = { ...defaultSettings, ...JSON.parse(userDefault) }; } catch (e) {}
        }

        const saved = localStorage.getItem('edgeReaderSettings');
        if (saved) {
            try { currentSettings = { ...defaultSettings, ...JSON.parse(saved) }; } catch (e) {}
        } else {
            currentSettings = { ...defaultSettings };
        }
        applySettings();
        updateUI();
    }

    function saveSettings() {
        localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings));
        applySettings();
        scheduleRepagination();
    }

    function applySettings() {
        if (currentSettings.isOriginalTheme) {
            bookContent.setAttribute('data-theme-override', 'false');
            document.documentElement.style.setProperty('--bg-color', currentSettings.bgColor || '#181818');
        } else {
            bookContent.setAttribute('data-theme-override', 'true');
            document.documentElement.style.setProperty('--bg-color', currentSettings.bgColor);
            document.documentElement.style.setProperty('--container-bg', currentSettings.containerBg);
            document.documentElement.style.setProperty('--text-color', currentSettings.textColor);
        }

        document.documentElement.style.setProperty('--font-size', currentSettings.fontSize + 'px');
        document.documentElement.style.setProperty('--line-height', currentSettings.lineHeight);
        
        if (currentSettings.fontFamily === 'original') {
            bookContent.setAttribute('data-font', 'original');
        } else {
            bookContent.setAttribute('data-font', 'custom');
            document.documentElement.style.setProperty('--font-family', currentSettings.fontFamily);
        }
        
        bookContent.setAttribute('data-line-height', 'custom');
        
        document.documentElement.style.setProperty('--max-width', currentSettings.maxWidth + 'px');
        document.documentElement.style.setProperty('--side-padding', currentSettings.sidePadding + 'px');
        document.documentElement.style.setProperty('--paragraph-spacing', currentSettings.paragraphSpacing + 'em');

        if (currentSettings.readingMode === 'paged') {
            readerView.classList.add('paged-mode');
            if (currentBookType === 'pdf') {
                if (bookViewport) bookViewport.classList.add('pdf-paged-viewport');
            } else {
                if (bookViewport) bookViewport.classList.remove('pdf-paged-viewport');
            }
        } else {
            readerView.classList.remove('paged-mode');
            if (bookViewport) {
                bookViewport.classList.remove('pdf-paged-viewport');
                bookViewport.scrollLeft = 0;
            }
        }
    }

    function updateUI() {
        bgColorPicker.value = currentSettings.bgColor;
        containerBgPicker.value = currentSettings.containerBg;
        textColorPicker.value = currentSettings.textColor;
        fontFamilySelect.value = currentSettings.fontFamily;
        fontSizeSlider.value = currentSettings.fontSize;
        fontSizeVal.textContent = currentSettings.fontSize + 'px';
        lineHeightSlider.value = currentSettings.lineHeight;
        lineHeightVal.textContent = currentSettings.lineHeight;
        maxWidthSlider.value = currentSettings.maxWidth;
        maxWidthVal.textContent = currentSettings.maxWidth + 'px';
        sidePaddingSlider.value = currentSettings.sidePadding;
        sidePaddingVal.textContent = currentSettings.sidePadding + 'px';
        paragraphSpacingSlider.value = currentSettings.paragraphSpacing;
        paragraphSpacingVal.textContent = currentSettings.paragraphSpacing + 'em';

        if (modeScrollBtn && modePagedBtn) {
            if (currentSettings.readingMode === 'paged') {
                modeScrollBtn.classList.remove('active');
                modePagedBtn.classList.add('active');
            } else {
                modeScrollBtn.classList.add('active');
                modePagedBtn.classList.remove('active');
            }
        }
    }

    // Event Listeners for Settings
    bgColorPicker.addEventListener('input', (e) => { currentSettings.bgColor = e.target.value; saveSettings(); });
    containerBgPicker.addEventListener('input', (e) => { currentSettings.containerBg = e.target.value; saveSettings(); });
    textColorPicker.addEventListener('input', (e) => { currentSettings.textColor = e.target.value; saveSettings(); });
    fontFamilySelect.addEventListener('change', (e) => { currentSettings.fontFamily = e.target.value; saveSettings(); });
    fontSizeSlider.addEventListener('input', (e) => { currentSettings.fontSize = e.target.value; fontSizeVal.textContent = e.target.value + 'px'; saveSettings(); });
    lineHeightSlider.addEventListener('input', (e) => { currentSettings.lineHeight = e.target.value; lineHeightVal.textContent = e.target.value; saveSettings(); });
    maxWidthSlider.addEventListener('input', (e) => { currentSettings.maxWidth = e.target.value; maxWidthVal.textContent = e.target.value + 'px'; saveSettings(); });
    sidePaddingSlider.addEventListener('input', (e) => { currentSettings.sidePadding = e.target.value; sidePaddingVal.textContent = e.target.value + 'px'; saveSettings(); });
    paragraphSpacingSlider.addEventListener('input', (e) => { currentSettings.paragraphSpacing = e.target.value; paragraphSpacingVal.textContent = e.target.value + 'em'; saveSettings(); });

    if (modeScrollBtn) {
        modeScrollBtn.addEventListener('click', () => {
            if (currentSettings.readingMode === 'scroll') return;
            setReadingMode('scroll');
        });
    }
    if (modePagedBtn) {
        modePagedBtn.addEventListener('click', () => {
            if (currentSettings.readingMode === 'paged') return;
            setReadingMode('paged');
        });
    }

    async function setReadingMode(mode) {
        const position = captureProgress()?.data.readerPosition;
        currentSettings.readingMode = mode;
        localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings));
        applySettings();
        updateUI();
        if (!currentBookId) return;
        await navigate(() => showLocation(currentChapterIndex, localPagedIndex, position?.scrollRatio ?? null));
        if (mode === 'scroll') updateScrollWindow();
    }

    const themes = {
        original: { isOriginalTheme: true },
        dark: { bgColor: '#181818', containerBg: '#333333', textColor: '#cca922', isOriginalTheme: false },
        light: { bgColor: '#e0e0e0', containerBg: '#f9f9f9', textColor: '#222222', isOriginalTheme: false },
        sepia: { bgColor: '#e4dcc8', containerBg: '#f4ecd8', textColor: '#5b4636', isOriginalTheme: false },
        oled: { bgColor: '#000000', containerBg: '#0a0a0a', textColor: '#d1d1d1', isOriginalTheme: false }
    };

    themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const themeName = btn.dataset.theme;
            if (themes[themeName]) {
                Object.assign(currentSettings, themes[themeName]);
                updateUI();
                saveSettings();
            }
        });
    });

    saveDefaultSettingsBtn.addEventListener('click', () => {
        if(confirm("Şu anki ayarları uygulamanın varsayılan ayarları olarak kaydetmek istediğinize emin misiniz?")) {
            defaultSettings = { ...currentSettings };
            localStorage.setItem('edgeReaderUserDefaultSettings', JSON.stringify(defaultSettings));
            alert("Varsayılan ayarlar kaydedildi!");
        }
    });

    resetSettingsBtn.addEventListener('click', () => {
        if(confirm("Tüm ayarları (tema, font, boyut vs.) varsayılana döndürmek istediğinize emin misiniz?")) {
            currentSettings = { ...defaultSettings };
            saveSettings();
            updateUI();
        }
    });

    // --- Sidebar Toggles ---
    function openSidebar(sidebar) {
        sidebar.classList.add('open');
        sidebar.setAttribute('aria-hidden', 'false');
    }
    function closeSidebar(sidebar) {
        sidebar.classList.remove('open');
        sidebar.setAttribute('aria-hidden', 'true');
    }

    settingsToggle.addEventListener('click', () => {
        openSidebar(settingsSidebar);
        closeSidebar(tocSidebar);
    });
    settingsClose.addEventListener('click', () => closeSidebar(settingsSidebar));

    tocToggle.addEventListener('click', () => {
        openSidebar(tocSidebar);
        closeSidebar(settingsSidebar);
    });
    tocClose.addEventListener('click', () => closeSidebar(tocSidebar));

    document.addEventListener('click', (e) => {
        if (!settingsSidebar.contains(e.target) && !settingsToggle.contains(e.target)) closeSidebar(settingsSidebar);
        if (!tocSidebar.contains(e.target) && !tocToggle.contains(e.target)) closeSidebar(tocSidebar);
    });

    // --- Library Management (Node.js API) ---

    async function loadLibrary() {
        libraryGrid.innerHTML = '';
        try {
            const res = await fetch('/api/books');
            globalLibrary = await res.json();
            
            if (globalLibrary.length === 0) {
                libraryGrid.innerHTML = '<p style="color:#888; grid-column: 1/-1; text-align:center;">Kütüphaneniz boş. Yukarıdan kitap ekleyerek başlayabilirsiniz.</p>';
                return;
            }

            // Sıralamayı tersine çevirelim ki yeni eklenenler üstte çıksın
            for (let i = globalLibrary.length - 1; i >= 0; i--) {
                const bookData = globalLibrary[i];

                const card = document.createElement('div');
                card.className = 'book-card';
                card.onclick = () => openBook(bookData.id);

                let coverHtml = `<div class="book-cover"><i class="fa-solid fa-book"></i></div>`;
                if (bookData.coverUrl) {
                    coverHtml = `<div class="book-cover" style="background-image: url('${bookData.coverUrl}')"></div>`;
                }

                const progressPct = bookData.progress || 0;

                card.innerHTML = `
                    ${coverHtml}
                    <div class="book-info">
                        <div class="book-title">${bookData.title}</div>
                        <div>
                            <div class="book-progress-text">%${Math.round(progressPct)} okundu</div>
                            <div class="book-progress-track">
                                <div class="book-progress-fill" style="width: ${progressPct}%"></div>
                            </div>
                        </div>
                    </div>
                    <button class="delete-book-icon" title="Sil" onclick="deleteBook(event, '${bookData.id}')">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                `;
                libraryGrid.appendChild(card);
            }
        } catch (error) {
            console.error("Kütüphane yüklenemedi:", error);
            libraryGrid.innerHTML = '<p style="color:#e53935; grid-column: 1/-1; text-align:center;">Sunucuya bağlanılamadı. Node.js sunucusunun açık olduğundan emin olun.</p>';
        }
    }

    window.deleteBook = async (e, id) => {
        e.stopPropagation(); // prevent opening book
        if(confirm("Bu kitabı kütüphaneden silmek istediğinize emin misiniz?")) {
            await fetch(`/api/books/${id}`, { method: 'DELETE' });
            loadLibrary();
        }
    };

    deleteBookBtn.addEventListener('click', async () => {
        if(currentBookId && confirm("Şu an okuduğunuz kitabı silmek istediğinize emin misiniz?")) {
            await fetch(`/api/books/${currentBookId}`, { method: 'DELETE' });
            closeReader();
        }
    });

    // --- Reader Core ---

    function releaseBook() {
        flushProgress();
        clearTimeout(scrollSaveTimeout);
        clearTimeout(layoutTimer);
        session++;
        sessionAbort.abort();
        paginationAbort.abort();
        sessionAbort = new AbortController();
        stopTTS();
        closePageJumpModal();
        if (currentPdfDoc) currentPdfDoc.destroy();
        currentPdfDoc = null;
        currentBookId = null;
        currentBookType = null;
        epubSpine = [];
        stylesheetCache.clear();
        htmlSource = '';
        bookContent.replaceChildren();
        currentChapterIndex = localPagedIndex = 0;
        currentGlobalPage = currentPdfPage = 1;
        totalBookPages = totalPdfPages = 0;
        isNavigatingPage = scrollWindowBusy = false;
        layoutKey = '';
        layoutPosition = null;
    }

    function closeReader() {
        releaseBook();
        readerView.style.display = 'none';
        libraryView.classList.add('active');
        closeSidebar(settingsSidebar);
        closeSidebar(tocSidebar);
        document.title = 'Premium Edge Reader';
        if (location.pathname !== '/') history.pushState(null, '', '/');
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        loadLibrary();
    }
    backToLibraryBtn.addEventListener('click', closeReader);

    function getLayoutKey() {
        const s = currentSettings;
        return JSON.stringify([4, innerWidth, innerHeight, devicePixelRatio,
            s.fontSize, s.fontFamily, s.lineHeight, s.maxWidth, s.sidePadding, s.paragraphSpacing]);
    }

    function commitPageMap(counts) {
        let offset = 1;
        epubSpine.forEach((chapter, index) => {
            chapter.pageCount = counts[index];
            chapter.missing = counts[index] === 0;
            chapter.startPage = offset;
            offset += counts[index];
        });
        totalBookPages = offset - 1;
    }

    function updatePagedView() {
        if (!currentBookId) return;
        if (currentBookType === 'pdf') {
            currentGlobalPage = currentPdfPage;
            bookContent.querySelectorAll('.pdf-page').forEach(p => {
                p.classList.toggle('active-pdf-page', Number(p.dataset.pageIndex) === currentPdfPage);
            });
        } else if (currentSettings.readingMode === 'paged') {
            bookViewport.style.setProperty('--rendered-pages', '1');
            const count = Math.max(1, Math.round(bookViewport.scrollWidth / bookViewport.clientWidth));
            bookViewport.style.setProperty('--rendered-pages', String(count));
            localPagedIndex = Math.max(0, Math.min(localPagedIndex, count - 1));
            bookViewport.scrollTo({left: localPagedIndex * bookViewport.clientWidth, behavior: 'instant'});
        }
        updatePagedIndicator();
    }

    function updatePagedIndicator() {
        const ready = totalBookPages > 0;
        if (ready && currentBookType === 'epub') {
            currentGlobalPage = epubSpine[currentChapterIndex].startPage + localPagedIndex;
        } else if (currentBookType === 'html') {
            currentGlobalPage = localPagedIndex + 1;
        }
        const missing = epubSpine.filter(chapter => chapter.missing).length;
        const warning = missing ? missing + ' bölüm EPUB dosyasında eksik. Toplam yalnızca mevcut içeriği kapsar.' : '';
        pagedIndicator.title = warning || 'Sayfaya Git (G)';
        pagedPageText.textContent = ready
            ? 'Sayfa ' + currentGlobalPage + ' / ' + totalBookPages + (missing ? ' · eksik EPUB' : '') : 'Sayfalar hesaplanıyor…';
        progressBar.style.width = ready ? (100 * currentGlobalPage / totalBookPages) + '%' : '0%';
        pageJumpInput.disabled = pageJumpSlider.disabled = pageJumpSubmit.disabled = !ready || isNavigatingPage;
        jumpTotalPages.textContent = ready ? totalBookPages : '…';
        pageJumpInput.max = pageJumpSlider.max = Math.max(1, totalBookPages);
        pagedPrevBtn.disabled = isNavigatingPage || (currentChapterIndex === 0 && localPagedIndex === 0 && currentPdfPage === 1);
        pagedNextBtn.disabled = isNavigatingPage || (ready && currentGlobalPage >= totalBookPages);
        if (pageJumpModal.open) document.getElementById('page-jump-status').textContent = warning;
    }

    function updateLocation() {
        if (!currentBookId || !totalBookPages) return;
        const params = new URLSearchParams();
        params.set('page', currentGlobalPage);
        if (currentBookType === 'epub') {
            params.set('ch', currentChapterIndex);
            params.set('local', localPagedIndex);
        }
        history.replaceState(null, '', '/book/' + currentBookId + '?' + params);
    }

    function captureProgress() {
        if (!currentBookId || !totalBookPages) return null;
        const count = currentBookType === 'epub' ? epubSpine[currentChapterIndex].pageCount : totalBookPages;
        const section = bookContent.querySelector(':scope > section[data-index="' + currentChapterIndex + '"]');
        const scrollRatio = currentSettings.readingMode === 'scroll' && section
            ? Math.max(0, Math.min(1, (80 - section.getBoundingClientRect().top) / Math.max(1, section.offsetHeight)))
            : localPagedIndex / Math.max(1, count);
        return {id: currentBookId, data: {
            progress: 100 * currentGlobalPage / totalBookPages,
            scrollY: window.scrollY, chapterIndex: currentChapterIndex, pageIndex: currentGlobalPage,
            readerPosition: {chapterIndex: currentChapterIndex, localPage: localPagedIndex,
                globalPage: currentGlobalPage, scrollRatio, layoutKey, readingMode: currentSettings.readingMode}
        }};
    }

    function flushProgress() {
        if (!pendingProgress) return;
        const {id, data} = pendingProgress;
        pendingProgress = null;
        const book = globalLibrary.find(b => b.id === id);
        if (book) Object.assign(book, data);
        progressWrite = progressWrite.catch(() => {}).then(async () => {
            const response = await fetch('/api/books/' + id + '/progress', {
                method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data), keepalive: true
            });
            if (!response.ok) throw new Error('Okuma konumu kaydedilemedi.');
        });
        progressWrite.catch(error => console.error(error));
    }

    function saveCurrentProgress() {
        updateLocation();
        pendingProgress = captureProgress();
        clearTimeout(scrollSaveTimeout);
        scrollSaveTimeout = setTimeout(flushProgress, 400);
    }
    window.addEventListener('pagehide', flushProgress);

    async function settleContent(article) {
        const loaded = image => image.complete ? Promise.resolve() : new Promise(resolve => {
            image.addEventListener('load', resolve, {once: true});
            image.addEventListener('error', resolve, {once: true});
        });
        const images = Array.from(article.querySelectorAll('img'), image => {
            image.loading = 'eager';
            return loaded(image);
        });
        for (const image of article.querySelectorAll('svg image')) {
            const probe = new Image();
            probe.src = image.getAttribute('href') || image.getAttribute('xlink:href');
            images.push(loaded(probe));
        }
        await Promise.all(images);
        // Request fonts used by this chapter before waiting for their metrics.
        article.getBoundingClientRect();
        await article.ownerDocument.fonts.ready;
        return article.scrollWidth;
    }

    async function countBookPages() {
        paginationAbort.abort();
        paginationAbort = new AbortController();
        const signal = paginationAbort.signal;
        const token = session;
        layoutKey = getLayoutKey();
        const key = layoutKey;
        totalBookPages = currentBookType === 'pdf' ? totalPdfPages : 0;
        updatePagedIndicator();
        if (!currentBookId || currentBookType === 'pdf') return;
        const book = globalLibrary.find(b => b.id === currentBookId);
        const cacheKey = 'edgeReaderPages:' + currentBookId;
        if (currentBookType === 'epub') {
            try {
                const cache = JSON.parse(localStorage.getItem(cacheKey));
                if (cache && cache.key === key && cache.file === book.fileName && cache.counts.length === epubSpine.length &&
                    cache.counts.every(n => Number.isSafeInteger(n) && n >= 0)) {
                    commitPageMap(cache.counts);
                    updatePagedIndicator();
                    return;
                }
            } catch (_) {}
        }
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = 'position:fixed;left:-100000px;top:0;border:0;pointer-events:none;visibility:hidden;';
        frame.style.width = innerWidth + 'px';
        frame.style.height = innerHeight + 'px';
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
        frame.srcdoc = '<!doctype html><html lang="tr"><head></head><body><div id="reader-view" class="paged-mode"><main id="reader-container"><div id="book-viewport"><article id="book-content" lang="tr"></article></div></main></div></body></html>';
        document.body.appendChild(frame);
        signal.addEventListener('abort', () => frame.remove(), {once: true});
        try {
            await loaded;
            signal.throwIfAborted();
            const doc = frame.contentDocument;
            doc.documentElement.style.cssText = document.documentElement.style.cssText;
            const stylesLoaded = [];
            document.querySelectorAll('head link[rel="stylesheet"]').forEach(link => {
                const copy = doc.createElement('link');
                copy.rel = 'stylesheet'; copy.href = link.href;
                stylesLoaded.push(new Promise(resolve => {copy.onload = copy.onerror = resolve;}));
                doc.head.appendChild(copy);
            });
            await Promise.all(stylesLoaded);
            signal.throwIfAborted();
            const article = doc.getElementById('book-content');
            const viewport = doc.getElementById('book-viewport');
            for (const name of ['data-font', 'data-line-height', 'data-theme-override']) {
                article.setAttribute(name, bookContent.getAttribute(name));
            }
            const counts = [];
            const length = currentBookType === 'epub' ? epubSpine.length : 1;
            for (let index = 0; index < length; index++) {
                signal.throwIfAborted();
                let section;
                try {
                    section = currentBookType === 'epub'
                        ? await loadEpubChapter(index, doc, signal) : makeHtmlSection(doc);
                } catch (error) {
                    if (currentBookType !== 'epub' || error.status !== 404 || error.url !== epubSpine[index].url) throw error;
                    // Missing archive content is not a page. Keep the spine position
                    // for TOC/restoration and disclose that the book is incomplete.
                    counts.push(0);
                    continue;
                }
                signal.throwIfAborted();
                article.replaceChildren(section);
                viewport.scrollLeft = 0;
                await settleContent(article);
                signal.throwIfAborted();
                counts.push(Math.max(1, Math.round(viewport.scrollWidth / viewport.clientWidth)));
                article.replaceChildren();
                pagedPageText.textContent = 'Sayfalar hesaplanıyor (' + (index + 1) + '/' + length + ')…';
                // Let navigation and painting run between chapters.
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (token !== session || key !== getLayoutKey()) return;
            if (currentBookType === 'epub') {
                commitPageMap(counts);
                try {localStorage.setItem(cacheKey, JSON.stringify({key, file: book.fileName, counts}));} catch (_) {}
            } else totalBookPages = counts[0];
            updatePagedIndicator();
        } finally {
            frame.remove();
        }
    }

    function startPagination() {
        paginationPromise = countBookPages();
        paginationPromise.catch(error => {
            if (error.name === 'AbortError') return;
            console.error(error);
            pagedPageText.textContent = 'Sayfa sayısı hesaplanamadı';
            document.getElementById('page-jump-status').textContent = 'Sayfa sayısı hesaplanamadı. Kitabı yeniden açın.';
        });
        return paginationPromise;
    }

    async function showLocation(chapterIndex, localPage = 0, scrollRatio = null) {
        const token = session;
        const location = ++locationVersion;
        const type = currentBookType;
        let section;
        if (type === 'epub') {
            section = await loadEpubChapter(chapterIndex);
        } else if (type === 'pdf') {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = await getPdfPageHtml(localPage + 1);
            section = wrapper.firstElementChild;
        } else section = makeHtmlSection(document);
        if (token !== session || location !== locationVersion) return;
        stopTTS();
        bookContent.replaceChildren(section);
        currentChapterIndex = chapterIndex;
        currentPdfPage = type === 'pdf' ? localPage + 1 : 1;
        bookViewport.scrollTo({left: 0, top: 0, behavior: 'instant'});
        await settleContent(bookContent);
        if (token !== session || location !== locationVersion) return;
        localPagedIndex = localPage;
        if (currentSettings.readingMode === 'paged') {
            window.scrollTo({top: 0, behavior: 'instant'});
            updatePagedView();
        } else {
            const count = type === 'epub' ? epubSpine[chapterIndex].pageCount : totalBookPages;
            const ratio = type === 'pdf' ? 0 : scrollRatio === null ? localPage / Math.max(1, count) : scrollRatio;
            window.scrollTo({top: Math.max(0, section.getBoundingClientRect().top + window.scrollY + ratio * section.offsetHeight - 80), behavior: 'instant'});
            updatePagedIndicator();
        }
    }

    async function navigate(action) {
        if (!currentBookId || isNavigatingPage) return;
        const token = session;
        isNavigatingPage = true;
        updatePagedIndicator();
        try {
            await action();
            if (token === session) saveCurrentProgress();
        } catch (error) {
            if (token === session && error.name !== 'AbortError') {
                console.error(error);
                document.getElementById('page-jump-status').textContent = 'Sayfa yüklenemedi: ' + error.message;
                if (!pageJumpModal.open) pageJumpModal.showModal();
            }
        } finally {
            if (token === session) {
                isNavigatingPage = false;
                updatePagedIndicator();
            }
        }
    }

    async function goToPage(page) {
        if (!Number.isSafeInteger(page) || page < 1 || page > totalBookPages) return;
        await navigate(async () => {
            if (currentBookType === 'epub') {
                const index = epubSpine.findIndex(ch => page < ch.startPage + ch.pageCount);
                const local = page - epubSpine[index].startPage;
                if (currentChapterIndex === index && currentSettings.readingMode === 'paged') {
                    localPagedIndex = local;
                    updatePagedView();
                } else await showLocation(index, local);
            } else if (currentBookType === 'html' && currentSettings.readingMode === 'paged') {
                localPagedIndex = page - 1;
                updatePagedView();
            } else await showLocation(0, page - 1);
        });
    }

    async function turnPage(direction) {
        if (currentSettings.readingMode !== 'paged') return;
        if (totalBookPages) return goToPage(currentGlobalPage + direction);
        // Reading remains available while the full index is built.
        await navigate(async () => {
            const count = Math.max(1, Math.round(bookViewport.scrollWidth / bookViewport.clientWidth));
            if (localPagedIndex + direction >= 0 && localPagedIndex + direction < count) {
                localPagedIndex += direction;
                updatePagedView();
            } else if (currentBookType === 'epub') {
                const index = currentChapterIndex + direction;
                if (index >= 0 && index < epubSpine.length) await showLocation(index, direction < 0 ? Number.MAX_SAFE_INTEGER : 0);
            }
        });
    }
    function goToNextPage() {return turnPage(1);}
    function goToPrevPage() {return turnPage(-1);}

    // Keep only the visible scroll chapter and its neighbours hydrated. Empty
    // placeholders preserve scroll offsets and are rehydrated when revisited.
    async function updateScrollWindow() {
        if (scrollWindowBusy || isNavigatingPage || currentSettings.readingMode !== 'scroll' || !['epub', 'pdf'].includes(currentBookType)) return;
        scrollWindowBusy = true;
        const token = session;
        const location = locationVersion;
        const isEpub = currentBookType === 'epub';
        try {
            const sections = Array.from(bookContent.children);
            const active = sections.find(el => el.getBoundingClientRect().bottom > 100) || sections.at(-1);
            if (!active) return;
            const index = Number(active.dataset.index);
            if (isEpub) currentChapterIndex = index;
            else currentPdfPage = currentGlobalPage = index + 1;
            const length = isEpub ? epubSpine.length : totalPdfPages;
            const start = Math.max(0, index - 1);
            let end = Math.min(length - 1, index + 1);
            for (let i = start; i <= end; i++) {
                let section = bookContent.querySelector(':scope > section[data-index="' + i + '"]');
                if (!section || section.dataset.loaded !== 'true') {
                    let fresh;
                    if (isEpub) fresh = await loadEpubChapter(i);
                    else {
                        const wrapper = document.createElement('div');
                        wrapper.innerHTML = await getPdfPageHtml(i + 1);
                        fresh = wrapper.firstElementChild;
                    }
                    if (token !== session || location !== locationVersion || currentSettings.readingMode !== 'scroll') return;
                    const anchor = active.getBoundingClientRect().top;
                    if (section) section.replaceWith(fresh);
                    else {
                        const after = Array.from(bookContent.children).find(el => Number(el.dataset.index) > i);
                        bookContent.insertBefore(fresh, after || null);
                    }
                    section = fresh;
                    if (active.isConnected) window.scrollBy({top: active.getBoundingClientRect().top - anchor, behavior: 'instant'});
                    await settleContent(section);
                    if (token !== session || location !== locationVersion) return;
                }
                // Short sections at the viewport end need a following chapter to leave room to scroll.
                if (i === end && end < length - 1 && section.getBoundingClientRect().bottom < innerHeight + 200) end++;
            }
            for (const element of bookContent.children) {
                const elementIndex = Number(element.dataset.index);
                if ((elementIndex >= start && elementIndex <= end) || element.dataset.loaded !== 'true') continue;
                const height = element.getBoundingClientRect().height;
                if (ttsActive) stopTTS();
                element.replaceChildren();
                element.style.height = height + 'px';
                element.dataset.loaded = 'false';
            }
            const current = bookContent.querySelector(':scope > section[data-index="' + index + '"]');
            const ratio = Math.max(0, Math.min(0.999999, (80 - current.getBoundingClientRect().top) / Math.max(1, current.offsetHeight)));
            localPagedIndex = isEpub ? Math.floor(ratio * (epubSpine[index].pageCount || 1)) : index;
            updatePagedIndicator();
            saveCurrentProgress();
        } catch (error) {
            if (error.name !== 'AbortError') console.error(error);
        } finally {if (token === session) scrollWindowBusy = false;}
    }

    window.addEventListener('scroll', () => {
        if (!currentBookId || currentSettings.readingMode !== 'scroll' || isNavigatingPage) return;
        if (currentBookType === 'epub' || currentBookType === 'pdf') updateScrollWindow();
        else if (currentBookType === 'html') {
            const max = document.documentElement.scrollHeight - innerHeight;
            localPagedIndex = Math.max(0, Math.min(totalBookPages - 1, Math.floor((window.scrollY / Math.max(1, max)) * totalBookPages)));
            updatePagedIndicator();
            saveCurrentProgress();
        }
    }, {passive: true});

    function openPageJumpModal() {
        if (!currentBookId) return;
        updatePagedIndicator();
        pageJumpInput.value = pageJumpSlider.value = currentGlobalPage;
        document.getElementById('page-jump-status').textContent = totalBookPages
            ? (epubSpine.some(ch => ch.missing) ? pagedIndicator.title : '') : 'Sayfa numaraları hesaplanıyor…';
        if (!pageJumpModal.open) pageJumpModal.showModal();
        pageJumpInput.focus();
        pageJumpInput.select();
    }
    function closePageJumpModal() {if (pageJumpModal.open) pageJumpModal.close();}
    pagedIndicator.addEventListener('click', openPageJumpModal);
    openPageJumpBtn.addEventListener('click', openPageJumpModal);
    pageJumpClose.addEventListener('click', closePageJumpModal);
    pageJumpModal.addEventListener('click', event => {
        if (event.target === pageJumpModal) {
            const rect = pageJumpModal.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePageJumpModal();
        }
    });
    document.getElementById('page-jump-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (!pageJumpInput.reportValidity() || !totalBookPages) return;
        const page = pageJumpInput.valueAsNumber;
        closePageJumpModal();
        await goToPage(page);
    });
    pageJumpSlider.addEventListener('input', () => {pageJumpInput.value = pageJumpSlider.value;});
    pageJumpInput.addEventListener('input', () => {
        if (pageJumpInput.validity.valid) pageJumpSlider.value = pageJumpInput.value;
    });
    pagedPrevBtn.addEventListener('click', goToPrevPage);
    pagedNextBtn.addEventListener('click', goToNextPage);
    bookViewport.addEventListener('click', event => {
        if (currentSettings.readingMode !== 'paged' || event.target.closest('a,button,input,select') || window.getSelection().toString()) return;
        const rect = bookViewport.getBoundingClientRect();
        const x = event.clientX - rect.left;
        if (x < rect.width * 0.25) goToPrevPage();
        else if (x > rect.width * 0.75) goToNextPage();
        else {
            const nav = document.getElementById('reader-nav');
            const visible = nav.style.opacity === '1';
            nav.style.opacity = visible ? '0' : '1';
            nav.style.visibility = visible ? 'hidden' : 'visible';
            nav.style.pointerEvents = visible ? 'none' : 'auto';
        }
    });
    window.addEventListener('keydown', event => {
        if (!currentBookId || pageJumpModal.open || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key === 'Escape') {closeSidebar(settingsSidebar); closeSidebar(tocSidebar); return;}
        if (settingsSidebar.classList.contains('open') || tocSidebar.classList.contains('open')) return;
        if (event.key.toLowerCase() === 'g') {event.preventDefault(); openPageJumpModal(); return;}
        if (currentSettings.readingMode !== 'paged') return;
        if (event.key === ' ' && event.target.closest('button,a')) return;
        if (['ArrowRight', 'PageDown'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) {
            event.preventDefault(); goToNextPage();
        } else if (['ArrowLeft', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey)) {
            event.preventDefault(); goToPrevPage();
        }
    });

    function scheduleRepagination() {
        if (!currentBookId || getLayoutKey() === layoutKey) return;
        layoutPosition = captureProgress()?.data.readerPosition || layoutPosition;
        const token = session;
        paginationAbort.abort();
        totalBookPages = 0;
        updatePagedIndicator();
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(async () => {
            try {
                await startPagination();
                if (token !== session) return;
                const position = layoutPosition;
                layoutPosition = null;
                if (position && currentBookId) {
                    const count = currentBookType === 'epub' ? epubSpine[currentChapterIndex].pageCount : totalBookPages;
                    await navigate(() => showLocation(currentChapterIndex, Math.min(count - 1, Math.floor(position.scrollRatio * count)), position.scrollRatio));
                }
            } catch (error) {if (error.name !== 'AbortError') console.error(error);}
        }, 180);
    }
    window.addEventListener('resize', scheduleRepagination);

    async function openBook(id) {
        releaseBook();
        const token = session;
        showLoading('Kitap hazırlanıyor…');
        try {
            const book = globalLibrary.find(item => item.id === id);
            if (!book) throw new Error('Kitap bulunamadı.');
            currentBookId = id;
            const params = new URLSearchParams(location.pathname === '/book/' + id ? location.search : '');
            if (location.pathname !== '/book/' + id) history.pushState(null, '', '/book/' + id);
            currentBookTitle.textContent = document.title = book.title;
            const fileName = book.fileName.toLowerCase();
            if (fileName.endsWith('.epub')) {
                currentBookType = 'epub';
                resourceBase = location.origin + '/api/books/' + encodeURIComponent(id) + '/epub/';
                await loadEpubSpine();
            } else if (fileName.endsWith('.pdf')) {
                currentBookType = 'pdf';
                currentPdfDoc = await pdfjsLib.getDocument({url: book.bookUrl, disableAutoFetch: true, disableStream: true}).promise;
                totalBookPages = totalPdfPages = currentPdfDoc.numPages;
            } else {
                currentBookType = 'html';
                const response = await fetch(book.bookUrl, {signal: sessionAbort.signal});
                if (!response.ok) throw new Error('Kitap dosyası alınamadı.');
                if (/\.(htmlz|zip)$/.test(fileName)) {
                    const zip = await JSZip.loadAsync(await response.arrayBuffer());
                    const main = Object.keys(zip.files).find(name => /\.html?$/.test(name));
                    if (!main) throw new Error('Arşivde HTML bulunamadı.');
                    htmlSource = extractBodyContent(await zip.file(main).async('string'));
                } else htmlSource = extractBodyContent(await response.text());
            }
            if (token !== session) return;
            if (originalPdfSetting) originalPdfSetting.hidden = currentBookType !== 'pdf';
            if (currentBookType === 'pdf' && openOriginalPdf) openOriginalPdf.href = book.bookUrl;
            libraryView.classList.remove('active');
            readerView.style.display = 'block';
            applySettings();
            const saved = book.readerPosition;
            let chapter = currentBookType === 'epub' ? Number(params.get('ch') ?? saved?.chapterIndex ?? book.chapterIndex ?? 0) : 0;
            chapter = Number.isSafeInteger(chapter) ? Math.max(0, Math.min(chapter, epubSpine.length - 1)) : 0;
            if (currentBookType !== 'epub') chapter = 0;
            let local = Math.max(0, Number(params.get('local') ?? saved?.localPage ?? 0) || 0);
            if (currentBookType === 'pdf') local = Math.max(0, Math.min(totalPdfPages - 1, (Number(params.get('page') ?? book.pageIndex) || 1) - 1));
            isNavigatingPage = true;
            await showLocation(chapter, local, saved?.readingMode === 'scroll' ? saved.scrollRatio : null);
            if (token !== session) return;
            isNavigatingPage = false;
            renderToc(book);
            hideLoading();
            await startPagination();
            if (token !== session) return;
            if (params.has('page') && !params.has('ch')) {
                await goToPage(Math.max(1, Math.min(totalBookPages, Number(params.get('page')) || 1)));
            } else {
                if (saved && saved.layoutKey !== layoutKey && !params.has('local')) {
                    const count = currentBookType === 'epub' ? epubSpine[chapter].pageCount : totalBookPages;
                    await navigate(() => showLocation(chapter, Math.min(count - 1, Math.floor(saved.scrollRatio * count)), saved.scrollRatio));
                }
                updatePagedView();
            }
            if (currentSettings.readingMode === 'scroll') updateScrollWindow();
            bookContent.focus({preventScroll: true});
        } catch (error) {
            if (token === session && error.name !== 'AbortError') {
                console.error(error);
                alert('Kitap açılırken hata oluştu: ' + error.message);
                closeReader();
            }
        } finally {if (token === session) hideLoading();}
    }

    function renderToc(book) {
        tocList.replaceChildren();
        for (const item of book.toc || []) {
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.href = item.link; link.textContent = item.title;
            link.addEventListener('click', async event => {
                event.preventDefault();
                const target = item.link.replace(/^#/, '');
                const index = epubSpine.findIndex(ch => ch.id === target);
                if (index >= 0) {
                    closeSidebar(tocSidebar);
                    await navigate(() => showLocation(index));
                }
            });
            li.appendChild(link); tocList.appendChild(li);
        }
        if (!tocList.children.length) tocList.textContent = 'İçindekiler bulunamadı';
    }

    // --- File Processing (Adding to API) ---

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        showLoading("Kitap sunucuya yükleniyor...");
        try {
            const fileName = file.name.toLowerCase();
            let title = file.name.replace(/\.[^/.]+$/, ""); // Default to filename
            let coverBlob = null;
            let toc = [];

            // İstemci tarafında metadataları çıkartıyoruz (Sunucuyu yormamak ve bağımlılık eklememek için)
            if (fileName.endsWith('.epub')) {
                const arrayBuffer = await file.arrayBuffer();
                const zip = await JSZip.loadAsync(arrayBuffer);
                const meta = await extractEpubMeta(zip);
                if (meta.title) title = meta.title;
                if (meta.coverBlob) coverBlob = meta.coverBlob;
                if (meta.toc) toc = meta.toc;
            } else if (fileName.endsWith('.pdf')) {
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
                try {
                    let meta = await pdf.getMetadata();
                    if (meta.info && meta.info.Title) title = meta.info.Title;
                } catch(e){}
            }

            // FormData ile dosyayı ve bilgileri sunucuya gönder
            const formData = new FormData();
            formData.append('bookFile', file);
            formData.append('fileName', fileName);
            formData.append('title', title);
            formData.append('toc', JSON.stringify(toc));
            if (coverBlob) {
                formData.append('coverBlob', coverBlob, 'cover.jpg');
            }

            const res = await fetch('/api/books', {
                method: 'POST',
                body: formData
            });

            if (!res.ok) throw new Error("Sunucu yüklemeyi reddetti.");

            fileInput.value = ""; // reset
            await loadLibrary();

        } catch (error) {
            console.error(error);
            alert("Dosya yüklenirken hata oluştu: " + error.message);
        } finally {
            hideLoading();
        }
    });

    // --- Parser Helpers ---

    function showLoading(text) {
        loadingText.innerText = text;
        loadingOverlay.style.display = 'flex';
    }
    function hideLoading() {
        loadingOverlay.style.display = 'none';
    }

    function extractBodyContent(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        return doc.body ? doc.body.innerHTML : "";
    }

    async function extractEpubMeta(zip) {
        let meta = { title: null, coverBlob: null, toc: [] };
        try {
            let containerXml = await zip.file("META-INF/container.xml").async("string");
            let parser = new DOMParser();
            let containerDoc = parser.parseFromString(containerXml, "text/xml");
            let rootfile = containerDoc.querySelector("rootfile").getAttribute("full-path");
            let basePath = rootfile.includes('/') ? rootfile.substring(0, rootfile.lastIndexOf("/") + 1) : '';
            
            let opfXml = await zip.file(rootfile).async("string");
            let opfDoc = parser.parseFromString(opfXml, "text/xml");
            
            let titleNode = opfDoc.querySelector('title');
            if (titleNode) meta.title = titleNode.textContent;

            let manifest = {};
            opfDoc.querySelectorAll("manifest > item").forEach(item => {
                manifest[item.getAttribute("id")] = item.getAttribute("href");
            });

            // Cover
            let coverId = null;
            let metaCover = opfDoc.querySelector('meta[name="cover"]');
            if (metaCover) coverId = metaCover.getAttribute('content');
            if (!coverId) {
                let coverItem = opfDoc.querySelector('item[properties~="cover-image"]');
                if (coverItem) coverId = coverItem.getAttribute('id');
            }
            if (coverId && manifest[coverId]) {
                let coverFile = zip.file(decodeURIComponent(basePath + manifest[coverId]));
                if (coverFile) meta.coverBlob = await coverFile.async("blob");
            }

            // TOC
            let ncxItem = opfDoc.querySelector('item[media-type="application/x-dtbncx+xml"]');
            if (ncxItem && manifest[ncxItem.getAttribute('id')]) {
                let ncxFile = zip.file(decodeURIComponent(basePath + manifest[ncxItem.getAttribute('id')]));
                if (ncxFile) {
                    let ncxXml = await ncxFile.async("string");
                    let ncxDoc = parser.parseFromString(ncxXml, "text/xml");
                    ncxDoc.querySelectorAll('navPoint').forEach(np => {
                        let text = np.querySelector('navLabel > text')?.textContent;
                        let src = np.querySelector('content')?.getAttribute('src');
                        if (text && src) {
                             meta.toc.push({ title: text, link: '#chapter-' + basePath + src.split('#')[0] });
                        }
                    });
                }
            }
        } catch (e) {
            console.warn("Meta çıkarma hatası", e);
        }
        return meta;
    }

    async function fetchText(url, signal = sessionAbort.signal) {
        const response = await fetch(url, {signal});
        if (!response.ok) {
            const error = new Error('Kitap kaynağı alınamadı (' + response.status + '): ' + decodeURIComponent(url.split('/').at(-1)));
            error.status = response.status;
            error.url = url;
            throw error;
        }
        return response.text();
    }

    async function loadEpubSpine() {
        const parser = new DOMParser();
        const container = parser.parseFromString(await fetchText(resourceBase + 'META-INF/container.xml'), 'application/xml');
        const root = container.querySelector('rootfile')?.getAttribute('full-path');
        if (!root) throw new Error('EPUB paket bilgisi eksik.');
        const opfUrl = new URL(root.split('/').map(encodeURIComponent).join('/'), resourceBase).href;
        const opf = parser.parseFromString(await fetchText(opfUrl), 'application/xml');
        const manifest = new Map(Array.from(opf.querySelectorAll('manifest > item'), item => [item.getAttribute('id'), item.getAttribute('href')]));
        epubSpine = Array.from(opf.querySelectorAll('spine > itemref'), item => {
            const href = manifest.get(item.getAttribute('idref'));
            if (!href) throw new Error('EPUB bölüm kaydı eksik.');
            const url = new URL(href, opfUrl).href;
            const path = url.slice(resourceBase.length).split('#')[0];
            return {url, id: 'chapter-' + decodeURIComponent(path), pageCount: 0, startPage: 0};
        });
        if (!epubSpine.length) throw new Error('EPUB bölümleri bulunamadı.');
    }

    function resolveResource(value, base) {
        const url = new URL(value, base);
        if (!['http:', 'https:', 'data:'].includes(url.protocol)) return '';
        return url.href;
    }

    async function loadEpubChapter(index, targetDocument = document, signal = sessionAbort.signal) {
        const chapter = epubSpine[index];
        if (!chapter) throw new Error('Bölüm bulunamadı.');
        const html = await fetchText(chapter.url, signal);
        signal.throwIfAborted();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let css = '';
        for (const style of doc.querySelectorAll('style')) {
            css += fixChapterCss(style.textContent, chapter.url);
            style.remove();
        }
        for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
            const url = resolveResource(link.getAttribute('href'), chapter.url);
            let text = stylesheetCache.get(url);
            if (text === undefined) {
                text = await fetchText(url, signal);
                signal.throwIfAborted();
                stylesheetCache.set(url, text);
            }
            css += fixChapterCss(text, url);
        }
        doc.querySelectorAll('script,iframe,object,embed,base,link,form').forEach(el => el.remove());
        for (const el of doc.body.querySelectorAll('*')) {
            for (const attr of Array.from(el.attributes)) {
                if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            }
            if (el.hasAttribute('style')) {
                el.style.color = el.style.backgroundColor = el.style.background = '';
                el.setAttribute('style', fixCssUrls(el.getAttribute('style'), chapter.url));
            }
            for (const name of ['src', 'href', 'xlink:href', 'poster']) {
                if (el.hasAttribute(name)) el.setAttribute(name, resolveResource(el.getAttribute(name), chapter.url));
            }
            // EPUB images use src; an unresolved srcset must not escape the archive route.
            el.removeAttribute('srcset');
        }
        const section = targetDocument.createElement('section');
        section.className = 'epub-chapter';
        section.id = chapter.id;
        section.dataset.index = index;
        section.dataset.loaded = 'true';
        if (css) {
            const style = targetDocument.createElement('style');
            style.textContent = css;
            section.appendChild(style);
        }
        while (doc.body.firstChild) section.appendChild(targetDocument.adoptNode(doc.body.firstChild));
        return section;
    }

    function fixCssUrls(css, base) {
        return css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_, quote, url) => 'url("' + resolveResource(url, base).replace(/"/g, '%22') + '")');
    }

    function fixChapterCss(css, base) {
        return fixCssUrls(css, base).replace(/@namespace[^;]+;/gi, '')
            .replace(/@page\s*\{[^}]*\}/gi, '')
            .replace(/(?:^|[;{])\s*(?:color|background-color|background)\s*:[^;}]+;?/gi, match => match[0] === '{' ? '{' : ';')
            .replace(/font-size\s*:\s*([^;]+(px|pt)|small|medium|large|x-large)[^;}]*;?/gi, '')
            .replace(/(^|[^\w-])(body|html)(?=[^\w-]|$)/gi, '$1.epub-chapter');
    }

    function makeHtmlSection(doc) {
        const section = doc.createElement('section');
        section.className = 'epub-chapter';
        section.dataset.index = '0';
        section.innerHTML = htmlSource;
        return section;
    }

    bookContent.addEventListener('click', async event => {
        const link = event.target.closest('a');
        if (!link || currentBookType !== 'epub') return;
        const url = new URL(link.href);
        const index = epubSpine.findIndex(ch => ch.url.split('#')[0] === url.href.split('#')[0]);
        if (index < 0) return;
        event.preventDefault();
        await navigate(async () => {
            await showLocation(index);
            if (url.hash) {
                const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
                if (target && currentSettings.readingMode === 'paged') {
                    localPagedIndex = Math.max(0, Math.floor((target.getBoundingClientRect().left - bookViewport.getBoundingClientRect().left + bookViewport.scrollLeft) / bookViewport.clientWidth));
                    updatePagedView();
                } else target?.scrollIntoView();
            }
        });
    });

    async function getPdfPageHtml(pageNumber) {
        if (!currentPdfDoc) return '';
        try {
            const page = await currentPdfDoc.getPage(pageNumber);
            const textContent = await page.getTextContent();
            let pageText = '';
            let lastY = -1;
            
            textContent.items.forEach(item => {
                if (lastY !== -1 && Math.abs(lastY - item.transform[5]) > 5) {
                    pageText += '<br>';
                }
                pageText += item.str.replace(/[&<>]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[c]));
                lastY = item.transform[5];
            });
            
            page.cleanup();
            if (pageText.trim().length > 0) {
                return `<section id="pdf-page-${pageNumber}" class="pdf-page" data-page-index="${pageNumber}" data-index="${pageNumber - 1}" data-loaded="true" role="region" aria-label="Sayfa ${pageNumber}"><p>${pageText}</p></section>`;
            }
            return `<section id="pdf-page-${pageNumber}" class="pdf-page" data-page-index="${pageNumber}" data-index="${pageNumber - 1}" data-loaded="true" role="region" aria-label="Sayfa ${pageNumber}"><p style="color:#888; text-align:center;">[Bu sayfa boş veya metin içeriyor ama çıkarılamadı]</p></section>`;
        } catch (e) {
            console.error(e);
            throw e;
        }
    }
    async function handleRouting() {
        const path = window.location.pathname;
        const bookMatch = path.match(/^\/book\/(book_[a-zA-Z0-9_]+)$/);
        
        if (bookMatch) {
            const bookId = bookMatch[1];
            if (globalLibrary.length === 0) {
                try {
                    const res = await fetch('/api/books');
                    globalLibrary = await res.json();
                } catch (e) {
                    console.error("Kitaplar yüklenemedi:", e);
                }
            }
            const bookData = globalLibrary.find(b => b.id === bookId);
            if (bookData) {
                await openBook(bookId);
            } else {
                closeReader();
            }
        } else {
            closeReader();
        }
    }

    // --- Text to Speech (TTS) Player ---
    let ttsActive = false;
    let ttsPlaying = false;
    let ttsSentences = [];
    let currentSentenceIndex = 0;
    let ttsUtterance = null;
    let ttsVoices = [];

    const ttsToggleBtn = document.getElementById('tts-toggle');
    const ttsPlayerCard = document.getElementById('tts-player');
    const ttsPlayPauseBtn = document.getElementById('tts-play-pause');
    const ttsPrevBtn = document.getElementById('tts-prev-sentence');
    const ttsNextBtn = document.getElementById('tts-next-sentence');
    const ttsSpeedSelect = document.getElementById('tts-speed');
    const ttsVoiceSelect = document.getElementById('tts-voice');
    const ttsCloseBtn = document.getElementById('tts-close');

    function loadVoices() {
        if (typeof window.speechSynthesis === 'undefined') return;
        ttsVoices = window.speechSynthesis.getVoices();
        ttsVoiceSelect.innerHTML = '';
        
        const trVoices = ttsVoices.filter(v => v.lang.startsWith('tr') || v.lang.startsWith('tr-TR'));
        const otherVoices = ttsVoices.filter(v => !v.lang.startsWith('tr'));
        
        trVoices.sort((a, b) => {
            const aNatural = a.name.toLowerCase().includes('natural');
            const bNatural = b.name.toLowerCase().includes('natural');
            if (aNatural && !bNatural) return -1;
            if (!aNatural && bNatural) return 1;
            return a.name.localeCompare(b.name);
        });

        trVoices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.name;
            option.innerText = voice.name.replace('Microsoft ', '').replace('Online (Natural) - ', '🤖 ');
            if (voice.name.includes('Ahmet') && voice.name.includes('Natural')) {
                option.selected = true;
            }
            ttsVoiceSelect.appendChild(option);
        });
        
        if (trVoices.length === 0) {
            const option = document.createElement('option');
            option.disabled = true;
            option.innerText = 'Türkçe ses bulunamadı';
            ttsVoiceSelect.appendChild(option);
        }
        
        const enVoices = otherVoices.filter(v => v.lang.startsWith('en'));
        if (enVoices.length > 0) {
            const optGroup = document.createElement('optgroup');
            optGroup.label = 'İngilizce ve Diğer Sesler';
            enVoices.forEach(voice => {
                const option = document.createElement('option');
                option.value = voice.name;
                option.innerText = voice.name.replace('Microsoft ', '').replace('Online (Natural) - ', '🤖 ');
                optGroup.appendChild(option);
            });
            ttsVoiceSelect.appendChild(optGroup);
        }
        // Restore saved voice preference if exists
        const savedVoice = localStorage.getItem('ttsVoice');
        if (savedVoice) {
            const option = Array.from(ttsVoiceSelect.options).find(opt => opt.value === savedVoice);
            if (option) {
                Array.from(ttsVoiceSelect.options).forEach(opt => opt.selected = false);
                option.selected = true;
                ttsVoiceSelect.value = savedVoice;
            }
        }
        
        // Restore saved speed preference if exists
        const savedSpeed = localStorage.getItem('ttsSpeed');
        if (savedSpeed) {
            ttsSpeedSelect.value = savedSpeed;
        }
    }

    if (typeof window.speechSynthesis !== 'undefined') {
        // Android Edge / Chrome'da online seslerin yüklenmesini tetiklemek için önceden çağırıyoruz
        window.speechSynthesis.getVoices();
        
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }
        
        // Sayfa yüklendiğinde bir kez çalıştır
        setTimeout(loadVoices, 500);
        setTimeout(loadVoices, 2000); // Gecikmeli yedek tetikleme
    }

    function clearTTSHighlight() {
        const highlighted = bookContent.querySelectorAll('.tts-highlight');
        highlighted.forEach(el => el.classList.remove('tts-highlight'));
    }

    function prepareTextForTTS() {
        clearTTSHighlight();
        
        const paragraphs = bookContent.querySelectorAll('p, h1, h2, h3, li');
        let sentenceIndex = 0;
        ttsSentences = [];
        
        paragraphs.forEach(p => {
            if (p.classList.contains('book-main-title')) return;
            
            const text = p.innerText.trim();
            if (!text) return;
            
            p.classList.add('tts-sentence');
            p.dataset.index = sentenceIndex;
            
            p.onclick = (e) => {
                e.stopPropagation();
                if (ttsActive) {
                    playSentence(parseInt(p.dataset.index));
                }
            };
            
            ttsSentences.push({
                text: text,
                span: p,
                element: p
            });
            sentenceIndex++;
        });
    }

    function playSentence(index) {
        if (typeof window.speechSynthesis === 'undefined') return;
        if (index < 0 || index >= ttsSentences.length) {
            stopTTS();
            return;
        }
        
        window.speechSynthesis.cancel();
        clearTTSHighlight();
        
        currentSentenceIndex = index;
        const current = ttsSentences[index];
        
        current.span.classList.add('tts-highlight');
        
        const rect = current.span.getBoundingClientRect();
        if (currentSettings.readingMode === 'paged') {
            if (currentBookType === 'epub' && bookViewport) {
                const vpRect = bookViewport.getBoundingClientRect();
                if (rect.left < vpRect.left || rect.right > vpRect.right) {
                    const step = bookViewport.clientWidth || 900;
                    const targetPage = Math.floor((rect.left - vpRect.left + bookViewport.scrollLeft) / step);
                    localPagedIndex = targetPage;
                    bookViewport.scrollTo({ left: targetPage * step, behavior: 'smooth' });
                    updatePagedIndicator();
                }
            } else if (currentBookType === 'pdf') {
                const pdfSec = current.span.closest('.pdf-page');
                if (pdfSec) {
                    const pNum = parseInt(pdfSec.dataset.pageIndex);
                    if (pNum && pNum !== currentPdfPage) {
                        currentPdfPage = pNum;
                        updatePagedView(true);
                    }
                }
            }
        } else {
            if (rect.top < 100 || rect.bottom > window.innerHeight - 150) {
                current.span.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
        
        ttsUtterance = new SpeechSynthesisUtterance(current.text);
        ttsUtterance.rate = parseFloat(ttsSpeedSelect.value) || 1.0;
        
        const selectedVoice = ttsVoices.find(v => v.name === ttsVoiceSelect.value);
        if (selectedVoice) {
            ttsUtterance.voice = selectedVoice;
            ttsUtterance.lang = selectedVoice.lang;
        } else {
            ttsUtterance.lang = 'tr-TR';
        }
        
        ttsUtterance.onend = () => {
            if (ttsPlaying) {
                playSentence(currentSentenceIndex + 1);
            }
        };
        
        ttsUtterance.onerror = (e) => {
            console.warn("TTS Event Error:", e);
            // If the selected online voice fails, fall back to the first available local voice
            if ((e.error === 'voice-unavailable' || e.error === 'network') && ttsVoiceSelect.selectedIndex > 0) {
                console.warn("Online voice unavailable on insecure localhost context, falling back to local voice.");
                ttsVoiceSelect.selectedIndex = 0; // Fallback to first TR local voice
                setTimeout(() => playSentence(index), 100);
                return;
            }
            if (e.error !== 'interrupted' && ttsPlaying) {
                playSentence(currentSentenceIndex + 1);
            }
        };
        
        window.speechSynthesis.speak(ttsUtterance);
        ttsPlaying = true;
        updatePlayPauseBtnIcon();
    }

    function updatePlayPauseBtnIcon() {
        if (ttsPlaying) {
            ttsPlayPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        } else {
            ttsPlayPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        }
    }

    function togglePlayPause() {
        if (!ttsActive) return;
        if (ttsPlaying) {
            window.speechSynthesis.pause();
            ttsPlaying = false;
            updatePlayPauseBtnIcon();
        } else {
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
                ttsPlaying = true;
                updatePlayPauseBtnIcon();
            } else {
                playSentence(currentSentenceIndex);
            }
        }
    }

    function stopTTS() {
        if (typeof window.speechSynthesis !== 'undefined') {
            window.speechSynthesis.cancel();
        }
        clearTTSHighlight();
        ttsPlaying = false;
        ttsActive = false;
        ttsSentences = [];
        ttsPlayerCard.classList.remove('active');
        updatePlayPauseBtnIcon();
        
        const sentences = bookContent.querySelectorAll('.tts-sentence');
        sentences.forEach(el => {
            el.classList.remove('tts-sentence');
            delete el.dataset.index;
            el.onclick = null;
        });
    }

    function startTTS() {
        ttsActive = true;
        prepareTextForTTS();
        loadVoices();
        ttsPlayerCard.classList.add('active');
        
        let startFrom = 0;
        const scrollMiddle = window.scrollY + window.innerHeight / 3;
        for (let i = 0; i < ttsSentences.length; i++) {
            const rect = ttsSentences[i].span.getBoundingClientRect();
            const absTop = rect.top + window.scrollY;
            if (absTop >= scrollMiddle) {
                startFrom = i;
                break;
            }
        }
        
        playSentence(startFrom);
    }

    ttsToggleBtn.addEventListener('click', () => {
        if (ttsActive) {
            stopTTS();
        } else {
            startTTS();
        }
    });

    ttsPlayPauseBtn.addEventListener('click', togglePlayPause);
    
    ttsPrevBtn.addEventListener('click', () => {
        if (currentSentenceIndex > 0) {
            playSentence(currentSentenceIndex - 1);
        }
    });
    
    ttsNextBtn.addEventListener('click', () => {
        if (currentSentenceIndex + 1 < ttsSentences.length) {
            playSentence(currentSentenceIndex + 1);
        }
    });
    
    ttsSpeedSelect.addEventListener('change', () => {
        localStorage.setItem('ttsSpeed', ttsSpeedSelect.value);
        if (ttsPlaying) {
            playSentence(currentSentenceIndex);
        }
    });
    
    ttsVoiceSelect.addEventListener('change', () => {
        localStorage.setItem('ttsVoice', ttsVoiceSelect.value);
        if (ttsPlaying) {
            playSentence(currentSentenceIndex);
        }
    });

    ttsCloseBtn.addEventListener('click', stopTTS);

    // --- Init ---
    loadSettings();
    handleRouting();

    window.addEventListener('popstate', () => {
        handleRouting();
    });
});
