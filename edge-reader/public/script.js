import { auth, db, storage } from './firebase-config.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, setDoc, getDoc, collection, getDocs, deleteDoc, updateDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { buildLayoutBundle } from './layout-bundle.js';
import { createBookResources, openRangePdf, RESOURCE_BASE, storageErrorMessage } from './cloud-reader.js';

let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
    // --- Initial Config & Reader State ---
    let currentBookId = null;
    let scrollSaveTimeout = null;
    let globalLibrary = []; // Firestore'dan gelen kitaplar

    // Page counts & navigation state
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
    let resourceBase = 'https://epub.local/';
    let htmlSource = '';
    let pendingProgress = null;
    let progressWrite = Promise.resolve();
    const stylesheetCache = new Map();

    let bookResources = null;
    let htmlResourceUrl = null;
    let visibleAssetFrame = null;
    let uploading = false;

    // Explicit viewport intersection also works for horizontal CSS columns.
    // Offscreen pagination frames only contain dimension-preserving placeholders.
    function loadVisibleAssets() {
        if (visibleAssetFrame) return;
        visibleAssetFrame = requestAnimationFrame(() => {
            visibleAssetFrame = null;
            const resources = bookResources;
            if (!resources) return;
            const token = session;
            const bounds = currentSettings.readingMode === 'paged'
                ? bookViewport.getBoundingClientRect() : {left: 0, right: innerWidth, top: 0, bottom: innerHeight};
            for (const element of bookContent.querySelectorAll('[data-reader-asset]')) {
                if (element.dataset.assetLoading || element.dataset.assetLoaded || element.dataset.assetFailed) continue;
                const rect = element.getBoundingClientRect();
                if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
                element.dataset.assetLoading = 'true';
                resources.assetUrl(element.dataset.readerAsset).then(url => {
                    if (token !== session || !element.isConnected) return;
                    if (element.localName === 'img') element.src = url;
                    else {
                        element.setAttribute('href', url);
                        element.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
                    }
                    element.dataset.assetLoaded = 'true';
                }).catch(error => {
                    if (token !== session || error.name === 'AbortError') return;
                    element.dataset.assetFailed = 'true';
                    element.setAttribute('aria-label', 'Görsel yüklenemedi');
                    pagedIndicator.title = 'Görsel yüklenemedi: ' + storageErrorMessage(error);
                    console.warn(error);
                }).finally(() => { delete element.dataset.assetLoading; });
            }
        });
    }

    // --- DOM Elements ---
    const libraryView = document.getElementById('library-view');
    const readerView = document.getElementById('reader-view');
    const libraryGrid = document.getElementById('library-grid');
    const fileInput = document.getElementById('book-upload');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');

    // Auth Elements
    const authModal = document.getElementById('auth-modal');
    const authForm = document.getElementById('auth-form');
    const authEmail = document.getElementById('auth-email');
    const authPassword = document.getElementById('auth-password');
    const authSubmitBtn = document.getElementById('auth-submit-btn');
    const authError = document.getElementById('auth-error');
    const userEmailDisplay = document.getElementById('user-email-display');
    const logoutBtn = document.getElementById('logout-btn');

    // Reader UI Elements
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

    // --- Firebase Auth Observer ---
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            authModal.style.display = 'none';
            userEmailDisplay.innerText = user.email;
            libraryView.style.display = 'block';
            await loadLibrary();
            handleRouting();
        } else {
            releaseBook();
            currentUser = null;
            authModal.style.display = 'flex';
            libraryView.style.display = 'none';
            readerView.style.display = 'none';
            globalLibrary = [];
        }
    });

    // Auth Form Submit (Login with auto-create fallback)
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = authEmail.value;
        const password = authPassword.value;
        authError.style.display = 'none';
        authSubmitBtn.innerText = 'İşleniyor...';
        authSubmitBtn.disabled = true;

        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (signInErr) {
            if (signInErr.code === 'auth/user-not-found' || signInErr.code === 'auth/invalid-credential') {
                try {
                    await createUserWithEmailAndPassword(auth, email, password);
                } catch (signUpErr) {
                    authError.innerText = 'Giriş / Kayıt başarısız: ' + signUpErr.message;
                    authError.style.display = 'block';
                }
            } else {
                authError.innerText = 'Hata: ' + signInErr.message;
                authError.style.display = 'block';
            }
        } finally {
            authSubmitBtn.innerText = 'Giriş Yap';
            authSubmitBtn.disabled = false;
        }
    });

    logoutBtn.addEventListener('click', async () => {
        if (confirm('Çıkış yapmak istediğinize emin misiniz?')) {
            closeReader();
            await signOut(auth);
        }
    });

    // --- Library Management (Firebase Firestore & Storage) ---

    async function loadLibrary() {
        if (!currentUser) return;
        libraryGrid.innerHTML = '';
        showLoading("Kitaplar yükleniyor...");
        try {
            const q = query(collection(db, "users", currentUser.uid, "library"), orderBy("addedAt", "desc"));
            const querySnapshot = await getDocs(q);
            globalLibrary = [];
            querySnapshot.forEach((docSnap) => {
                globalLibrary.push({ id: docSnap.id, ...docSnap.data() });
            });
            renderLibrary(globalLibrary);
        } catch(e) {
            console.error("Kitaplar çekilemedi:", e);
            libraryGrid.textContent = 'Kütüphane yüklenemedi: ' + e.message;
        } finally {
            hideLoading();
        }
    }

    function renderLibrary(books) {
        libraryGrid.innerHTML = '';
        if (!books || books.length === 0) {
            libraryGrid.innerHTML = '<p style="color: #888; grid-column: 1/-1; text-align: center; margin-top: 50px;">Henüz hiç kitap eklenmemiş. Yukarıdaki butondan ekleyebilirsiniz.</p>';
            return;
        }

        books.forEach(book => {
            const card = document.createElement('div');
            card.className = 'book-card';

            const coverHtml = book.coverUrl 
                ? `<img src="${book.coverUrl}" class="book-cover" alt="${book.title}">` 
                : `<div class="book-cover" style="display:flex; align-items:center; justify-content:center; background:#222; color:#555;"><i class="fa-solid fa-book" style="font-size:3rem;"></i></div>`;

            const percent = book.progress ? Math.round(book.progress) : 0;

            card.innerHTML = `
                ${coverHtml}
                <div class="book-info">
                    <div class="book-title" title="${book.title}">${book.title}</div>
                    <div class="book-progress">%${percent} okundu</div>
                </div>
                <button class="delete-btn" title="Kitabı Sil"><i class="fa-solid fa-trash"></i></button>
            `;

            card.onclick = () => openBook(book.id);

            const deleteBtn = card.querySelector('.delete-btn');
            deleteBtn.onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`"${book.title}" kitabını silmek istediğinize emin misiniz?`)) {
                    try {
                        showLoading("Kitap siliniyor...");
                        await deleteBookFiles(book);
                        await deleteDoc(doc(db, "users", currentUser.uid, "library", book.id));
                        await loadLibrary();
                    } catch(err) {
                        alert("Silinirken hata oluştu: " + err.message);
                    } finally {
                        hideLoading();
                    }
                }
            };

            libraryGrid.appendChild(card);
        });
    }

    deleteBookBtn.addEventListener('click', async () => {
        if (!currentBookId || !currentUser) return;
        const book = globalLibrary.find(b => b.id === currentBookId);
        const title = book ? book.title : 'Bu';
        if (confirm(`"${title}" kitabını kütüphanenizden tamamen silmek istediğinize emin misiniz?`)) {
            try {
                showLoading("Kitap siliniyor...");
                await deleteBookFiles(book);
                await deleteDoc(doc(db, "users", currentUser.uid, "library", currentBookId));
                closeReader();
            } catch(e) {
                alert("Kitap silinemedi: " + e.message);
            } finally {
                hideLoading();
            }
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

        bookResources?.dispose();
        bookResources = null;
        htmlResourceUrl = null;
        cancelAnimationFrame(visibleAssetFrame);
        visibleAssetFrame = null;
    }

    function closeReader() {
        releaseBook();
        readerView.style.display = 'none';
        libraryView.classList.add('active');
        closeSidebar(settingsSidebar);
        closeSidebar(tocSidebar);
        document.title = 'Premium Edge Reader';
        if (location.pathname !== '/') history.pushState(null, '', '/');
        loadLibrary();
    }
    backToLibraryBtn.addEventListener('click', closeReader);

    function getLayoutKey() {
        const s = currentSettings;
        return JSON.stringify([5, innerWidth, innerHeight, devicePixelRatio,
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
        loadVisibleAssets();
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
        return {
            id: currentBookId,
            data: {
                progress: 100 * currentGlobalPage / totalBookPages,
                scrollY: window.scrollY,
                chapterIndex: currentChapterIndex,
                pageIndex: currentGlobalPage,
                readerPosition: {
                    chapterIndex: currentChapterIndex,
                    localPage: localPagedIndex,
                    globalPage: currentGlobalPage,
                    scrollRatio,
                    layoutKey,
                    readingMode: currentSettings.readingMode
                }
            }
        };
    }

    function flushProgress() {
        if (!pendingProgress || !currentUser) return;
        const { id, data } = pendingProgress;
        const uid = currentUser.uid;
        pendingProgress = null;
        const book = globalLibrary.find(b => b.id === id);
        if (book) Object.assign(book, data);

        progressWrite = progressWrite.catch(() => {}).then(async () => {
            const bookRef = doc(db, "users", uid, "library", id);
            await updateDoc(bookRef, data);
        });
        progressWrite.catch(error => console.warn("İlerleme kaydedilemedi:", error));
    }

    function saveCurrentProgress() {
        updateLocation();
        pendingProgress = captureProgress();
        clearTimeout(scrollSaveTimeout);
        scrollSaveTimeout = setTimeout(flushProgress, 1500);
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
            const docRef = frame.contentDocument;
            docRef.documentElement.style.cssText = document.documentElement.style.cssText;
            const stylesLoaded = [];
            document.querySelectorAll('head link[rel="stylesheet"]').forEach(link => {
                const copy = docRef.createElement('link');
                copy.rel = 'stylesheet'; copy.href = link.href;
                stylesLoaded.push(new Promise(resolve => {copy.onload = copy.onerror = resolve;}));
                docRef.head.appendChild(copy);
            });
            await Promise.all(stylesLoaded);
            signal.throwIfAborted();
            const article = docRef.getElementById('book-content');
            const viewport = docRef.getElementById('book-viewport');
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
                        ? await loadEpubChapter(index, docRef, signal) : await makeHtmlSection(docRef);
                } catch (error) {
                    if (currentBookType !== 'epub' || error.status !== 404) throw error;
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
        } else section = await makeHtmlSection(document);
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
        loadVisibleAssets();
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
            for (let i = Math.max(0, index - 1); i <= Math.min(length - 1, index + 1); i++) {
                let existing = bookContent.querySelector(':scope > section[data-index="' + i + '"]');
                if (existing && existing.dataset.loaded === 'true') continue;
                let fresh;
                if (isEpub) fresh = await loadEpubChapter(i);
                else {
                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = await getPdfPageHtml(i + 1);
                    fresh = wrapper.firstElementChild;
                }
                if (token !== session || location !== locationVersion || currentSettings.readingMode !== 'scroll') return;
                const anchor = active.getBoundingClientRect().top;
                if (existing) existing.replaceWith(fresh);
                else {
                    const after = Array.from(bookContent.children).find(el => Number(el.dataset.index) > i);
                    bookContent.insertBefore(fresh, after || null);
                }
                await settleContent(fresh);
                if (token !== session || location !== locationVersion) return;
                if (active.isConnected) window.scrollBy({top: active.getBoundingClientRect().top - anchor, behavior: 'instant'});
            }
            for (const element of bookContent.children) {
                if (Math.abs(Number(element.dataset.index) - index) <= 1 || element.dataset.loaded !== 'true') continue;
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
            loadVisibleAssets();
            saveCurrentProgress();
        } catch (error) {
            if (error.name !== 'AbortError') console.error(error);
        } finally {if (token === session) scrollWindowBusy = false;}
    }

    window.addEventListener('scroll', () => {
        loadVisibleAssets();
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

    // Viewport tap / click navigation in Paged mode
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
            const fileName = (book.fileName || '').toLowerCase();

            if (fileName.endsWith('.epub')) {
                currentBookType = 'epub';
                resourceBase = RESOURCE_BASE;
                bookResources = await createBookResources(book, { uid: currentUser.uid, signal: sessionAbort.signal });
                if (token !== session) { bookResources.dispose(); return; }
                if (!book.layoutUrl) showLoading('Eski yükleme: ilk sayfa hesabı görsellerin ölçülerini de indirir. Sonraki açılışlar önbelleği kullanır.');
                await loadEpubSpine();
            } else if (fileName.endsWith('.pdf')) {
                currentBookType = 'pdf';
                currentPdfDoc = await openRangePdf(book.bookUrl, { signal: sessionAbort.signal,
                    onError: error => { if (token === session) pagedIndicator.title = storageErrorMessage(error); } });
                totalBookPages = totalPdfPages = currentPdfDoc.numPages;
            } else {
                currentBookType = 'html';
                if (/\.(htmlz|zip)$/.test(fileName)) {
                    bookResources = await createBookResources(book, { uid: currentUser.uid, signal: sessionAbort.signal });
                    const main = (await bookResources.names()).find(name => /\.html?$/i.test(name));
                    if (!main) throw new Error('Arşivde HTML bulunamadı.');
                    htmlResourceUrl = new URL(main.split('/').map(encodeURIComponent).join('/'), RESOURCE_BASE).href;
                    htmlSource = await bookResources.text(htmlResourceUrl);
                } else {
                    const response = await fetch(book.bookUrl, { signal: sessionAbort.signal, cache: 'force-cache' });
                    if (!response.ok) throw new Error('Kitap dosyası alınamadı.');
                    htmlSource = await response.text();
                }
            }

            if (token !== session) return;
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
                alert('Kitap açılırken hata oluştu: ' + storageErrorMessage(error));
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

    // --- File Processing (Adding to Firebase) ---

    async function deleteBookFiles(book) {
        if (!book) return;
        for (const path of [book.storagePath, book.layoutStoragePath, book.coverStoragePath].filter(Boolean)) {
            try { await deleteObject(ref(storage, path)); }
            catch (error) { if (error.code !== 'storage/object-not-found') throw error; }
        }
    }

    async function uploadFile(path, blob, label) {
        const task = uploadBytesResumable(ref(storage, path), blob, {
            contentType: blob.type || 'application/octet-stream',
            cacheControl: 'private,max-age=31536000,immutable'
        });
        // These ZIP/PDF bytes must not have Content-Encoding:gzip; it breaks Range.
        await new Promise((resolve, reject) => task.on('state_changed', snapshot => {
            showLoading(label + ' %' + Math.round(100 * snapshot.bytesTransferred / Math.max(1, snapshot.totalBytes)));
        }, reject, resolve));
        return getDownloadURL(task.snapshot.ref);
    }

    async function thumbnail(blob) {
        const bitmap = await createImageBitmap(blob);
        try {
            const canvas = document.createElement('canvas');
            const ratio = Math.min(1, 240 / bitmap.width, 360 / bitmap.height);
            canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
            canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.75));
        } finally { bitmap.close(); }
    }

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !currentUser || uploading) return;
        const uid = currentUser.uid;
        const attemptedPaths = [];
        let committed = false;
        uploading = fileInput.disabled = true;
        showLoading('Kitap cihazınızda hazırlanıyor…');
        try {
            const fileName = file.name.toLowerCase();
            let title = file.name.replace(/\.[^/.]+$/, '');
            let coverBlob = null;
            let toc = [];
            let layout = null;
            if (/\.(epub|htmlz|zip)$/.test(fileName)) {
                const zip = await JSZip.loadAsync(await file.arrayBuffer());
                if (fileName.endsWith('.epub')) {
                    const meta = await extractEpubMeta(zip);
                    if (meta.title) title = meta.title;
                    coverBlob = meta.coverBlob;
                    toc = meta.toc;
                } else if (!Object.keys(zip.files).some(name => /\.html?$/i.test(name))) {
                    throw new Error('Arşivde HTML bulunamadı.');
                }
                layout = await buildLayoutBundle(zip, { onProgress: ({processed, total}) => {
                    showLoading('Sayfa düzeni ve görsel ölçüleri hazırlanıyor (' + processed + '/' + total + ')…');
                }});
            } else if (fileName.endsWith('.pdf')) {
                const pdf = await pdfjsLib.getDocument({data: await file.arrayBuffer()}).promise;
                try {
                    const meta = await pdf.getMetadata();
                    if (meta.info?.Title) title = meta.info.Title;
                } finally { await pdf.destroy(); }
            } else if (!/\.html?$/.test(fileName)) throw new Error('Desteklenmeyen kitap biçimi.');

            const bookId = 'book_' + crypto.randomUUID();
            const safeFileName = bookId + '_' + fileName.replace(/[^a-zA-Z0-9.\-]/g, '_');
            const storagePath = `users/${uid}/books/${safeFileName}`;
            attemptedPaths.push(storagePath);
            const bookUrl = await uploadFile(storagePath, file, 'Kitap yükleniyor');
            let layoutUrl = null, layoutStoragePath = null;
            if (layout) {
                layoutStoragePath = `users/${uid}/layouts/${bookId}.zip`;
                attemptedPaths.push(layoutStoragePath);
                layoutUrl = await uploadFile(layoutStoragePath, layout.blob, 'Küçük düzen dosyası yükleniyor');
            }
            let coverUrl = null, coverStoragePath = null;
            if (coverBlob) {
                try { coverBlob = await thumbnail(coverBlob); }
                catch (error) { console.warn('Kapak küçültülemedi:', error); coverBlob = null; }
                if (coverBlob) {
                    coverStoragePath = `users/${uid}/covers/${bookId}_cover.webp`;
                    attemptedPaths.push(coverStoragePath);
                    coverUrl = await uploadFile(coverStoragePath, coverBlob, 'Kapak yükleniyor');
                }
            }
            const bookData = {
                id: bookId, title, fileName: safeFileName, fileSize: file.size,
                bookUrl, storagePath, layoutUrl, layoutStoragePath, layoutVersion: layout ? 1 : 0,
                coverUrl, coverStoragePath, toc, progress: 0, scrollY: 0,
                chapterIndex: 0, pageIndex: 1, addedAt: Date.now()
            };
            await setDoc(doc(db, 'users', uid, 'library', bookId), bookData);
            committed = true;
            if (currentUser?.uid === uid) await loadLibrary();
        } catch (error) {
            console.error(error);
            // A failed second upload or Firestore write must not silently leave
            // a whole book consuming storage without a library entry.
            if (!committed) {
                const cleanup = await Promise.allSettled(attemptedPaths.map(path => deleteObject(ref(storage, path))));
                const leftovers = cleanup.some(item => item.status === 'rejected' && item.reason.code !== 'storage/object-not-found');
                if (leftovers) console.warn('Yarım kalan yükleme temizlenemedi. Storage erişimi açıldıktan sonra bu yolları kontrol edin:', attemptedPaths);
            }
            alert('Dosya yüklenirken hata oluştu: ' + storageErrorMessage(error));
        } finally {
            uploading = fileInput.disabled = false;
            fileInput.value = '';
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
        const docRef = parser.parseFromString(htmlString, 'text/html');
        return docRef.body ? docRef.body.innerHTML : "";
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
        if (!bookResources) throw new Error('Kitap kaynakları henüz hazır değil.');
        return bookResources.text(url, signal);
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

    async function loadEpubChapter(index, targetDocument = document, signal = sessionAbort.signal) {
        const chapter = epubSpine[index];
        if (!chapter) throw new Error('Bölüm bulunamadı.');
        const html = await fetchText(chapter.url, signal);
        signal.throwIfAborted();
        const section = await bookResources.section(html, chapter.url, targetDocument, index, chapter.id);
        signal.throwIfAborted();
        return section;
    }

    async function makeHtmlSection(docRef) {
        if (bookResources) return bookResources.section(htmlSource, htmlResourceUrl, docRef);
        // Standalone HTML has no archive assets. Keep the imported document inert.
        const parsed = new DOMParser().parseFromString(htmlSource, 'text/html');
        parsed.querySelectorAll('script,iframe,object,embed,base,link,form,style,audio,video,source').forEach(el => el.remove());
        for (const el of parsed.body.querySelectorAll('*')) {
            for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            el.removeAttribute('srcset');
            el.removeAttribute('ping');
            el.removeAttribute('style');
            for (const name of ['src', 'href', 'xlink:href']) {
                const raw = el.getAttribute(name);
                if (raw && !raw.startsWith('#') && !raw.startsWith('data:image/')) el.removeAttribute(name);
            }
        }
        const section = docRef.createElement('section');
        section.className = 'epub-chapter';
        section.dataset.index = '0';
        while (parsed.body.firstChild) section.appendChild(docRef.adoptNode(parsed.body.firstChild));
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
        if (!currentUser) return;
        const path = window.location.pathname;
        const bookMatch = path.match(/^\/book\/(book_[a-zA-Z0-9_]+)$/);
        
        if (bookMatch) {
            const bookId = bookMatch[1];
            if (globalLibrary.length === 0) {
                await loadLibrary();
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

        const savedVoice = localStorage.getItem('ttsVoice');
        if (savedVoice) {
            const option = Array.from(ttsVoiceSelect.options).find(opt => opt.value === savedVoice);
            if (option) {
                Array.from(ttsVoiceSelect.options).forEach(opt => opt.selected = false);
                option.selected = true;
                ttsVoiceSelect.value = savedVoice;
            }
        }
        
        const savedSpeed = localStorage.getItem('ttsSpeed');
        if (savedSpeed) {
            ttsSpeedSelect.value = savedSpeed;
        }
    }

    if (typeof window.speechSynthesis !== 'undefined') {
        window.speechSynthesis.getVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }
        setTimeout(loadVoices, 500);
        setTimeout(loadVoices, 2000);
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
            if ((e.error === 'voice-unavailable' || e.error === 'network') && ttsVoiceSelect.selectedIndex > 0) {
                ttsVoiceSelect.selectedIndex = 0;
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
        if (currentSentenceIndex > 0) playSentence(currentSentenceIndex - 1);
    });
    ttsNextBtn.addEventListener('click', () => {
        if (currentSentenceIndex + 1 < ttsSentences.length) playSentence(currentSentenceIndex + 1);
    });
    ttsSpeedSelect.addEventListener('change', () => {
        localStorage.setItem('ttsSpeed', ttsSpeedSelect.value);
        if (ttsPlaying) playSentence(currentSentenceIndex);
    });
    ttsVoiceSelect.addEventListener('change', () => {
        localStorage.setItem('ttsVoice', ttsVoiceSelect.value);
        if (ttsPlaying) playSentence(currentSentenceIndex);
    });
    ttsCloseBtn.addEventListener('click', stopTTS);

    // --- Init ---
    loadSettings();

    window.addEventListener('popstate', () => {
        handleRouting();
    });
});
