import { installObjectView, revealReaderObjectTarget } from './epub-object-view.js';
import { createEpubPagination } from './epub-pagination.js';
import { auth, db, storage } from './firebase-config.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, setDoc, getDoc, collection, getDocs, deleteDoc, updateDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { buildLayoutBundle } from './layout-bundle.js';
import { createBookResources, openRangePdf, RESOURCE_BASE, storageErrorMessage, hydrateVisibleAssets } from './cloud-reader.js';
import { createUploadQueue } from './upload-queue.js';
import { loadPdfOutline, renderPdfToc } from './pdf-outline.js';
import { getNativePdfBlocks, renderNativePdfBlocks } from './pdf-reader.js';
import { installPageTurns } from './page-turn.js';
import { createReaderTts } from './reader-tts.js';
import { updateReaderToc } from './reader-toc.js';
import { createReaderLinkHistory, captureReaderTextAnchor, restoreReaderTextAnchor, readerTextAnchorShift, readerTextAnchorAt,
    readerTextAnchorWord, speechHighlight, speechHighlightColumn, watchSpeechHighlight, speechStartsContainer, speechPosition,
    speechPositionWord, speechRestarted, rangeWithin, wordOnScreen, firstVisibleWord, selectForSpeech } from './reader-link-history.js';
import { createPdfLayoutView, createPdfPage } from './pdf-layout-view.js';

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
    let currentPdfOutline = [];
    let pdfReadingAnchor = null;
    const pdfPageStates = new Map();
    let currentPdfPage = 1;
    let totalPdfPages = 0;
    let isNavigatingPage = false;
    let scrollWindowBusy = false;
    let session = 0;
    let locationVersion = 0;
    let sessionAbort = new AbortController();
    let paginationAbort = new AbortController();
    let paginationPromise = Promise.resolve();
    let paginationFailed = false;
    const paginationFailureMessage = 'Sayfa sayısı hesaplanamadı. Bağlantıyı kontrol edip kitabı yeniden açın.';
    let layoutKey = '';
    let epubPagination = createEpubPagination();
    let layoutTimer = null;
    let layoutPosition = null;
    let layoutGeneration = 0;
    let settledPosition = null;
    let settleTimer = null;
    let speechSection = null;
    // The last word Edge read outside a default start: where Play should resume.
    let speechResume = null;
    let speechRedirected = false;
    // Whether the paged page shows the word Edge reads, or read before closing its bar.
    let speechInView = false;
    // The text a paged restore brought back. Its reflowed page may begin earlier, so
    // positions keep this text until the page turns instead of drifting back a page.
    let keptAnchor = null;
    // window.scrollY as of the last scroll event: Edge's own jump has not reached it yet.
    let lastScrollY = 0;
    let scrollWindowAgain = false;
    let pagedAlignTimer = null;
    let readerTts = null;
    let ttsPosition = null;
    let ttsInView = false;
    let resourceBase = 'https://epub.local/';
    let htmlSource = '';
    let pendingProgress = null;
    let progressWrite = Promise.resolve();

    let bookResources = null;
    let htmlResourceUrl = null;
    let visibleAssetFrame = null;

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
            hydrateVisibleAssets(resources, bookContent, bounds, error => {
                pagedIndicator.title = 'Görsel yüklenemedi: ' + storageErrorMessage(error);
                console.warn(error);
            });
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
    let disposeObjectView = null;
    const currentBookTitle = document.getElementById('current-book-title');
    const backToLibraryBtn = document.getElementById('back-to-library');
    document.getElementById('reader-upload-btn').addEventListener('click', () => fileInput.click());
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
    const pdfLayoutSelect = document.getElementById('pdf-layout');

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
        readingMode: 'scroll',
        pdfLayout: 'text-right',
        pdfTextRatio: 0.535
    };

    let currentSettings = { ...defaultSettings };
    const pdfLayoutView = createPdfLayoutView({
        root: bookContent, getSettings: () => currentSettings,
        getDocument: () => currentPdfDoc, getCurrentPage: () => currentPdfPage,
        getStates: () => pdfPageStates,
        captureAnchor: capturePdfReadingAnchor, restoreAnchor: restorePdfReadingAnchor,
        onNavigate: page => linkHistory.follow(() => goToPage(page)),
        onSettingsChange: () => localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings)),
        onInteraction: ({ type }) => {
            if (['drag-end', 'keyboard', 'zoom'].includes(type)) {
                pdfReadingAnchor = capturePdfReadingAnchor();
                if (currentBookId) saveCurrentProgress();
            }
        }
    });
    pdfLayoutSelect.addEventListener('change', () => {
        const anchor = capturePdfReadingAnchor();
        currentSettings.pdfLayout = pdfLayoutSelect.value;
        saveSettings();
        restorePdfReadingAnchor(anchor);
    });

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
        const textPosition = currentBookType !== 'pdf' ? ttsLinkPosition(captureLinkPosition()) || captureLinkPosition() : null;
        localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings));
        applySettings();
        if (textPosition && getLayoutKey() !== layoutKey) layoutPosition ||= textPosition;
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
        bookContent.classList.toggle('pdf-content', currentBookType === 'pdf');

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
        pdfLayoutView.apply();
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
        pdfLayoutSelect.value = currentSettings.pdfLayout;

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
        const position = currentBookType === 'pdf' ? null : ttsLinkPosition(captureLinkPosition()) || captureLinkPosition();
        const anchor = capturePdfReadingAnchor();
        currentSettings.readingMode = mode;
        localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings));
        applySettings();
        updateUI();
        if (!currentBookId) return;
        if (currentBookType === 'pdf') {
            const spoken = readerTts?.section();
            if (spoken) currentPdfPage = currentGlobalPage = Number(spoken.dataset.pageIndex);
            else if (anchor?.section) currentPdfPage = currentGlobalPage = Number(anchor.section.dataset.pageIndex);
            localPagedIndex = currentPdfPage - 1;
            updatePagedView();
            pdfLayoutView.apply();
            if (mode === 'paged') window.scrollTo({ top: 0, behavior: 'instant' });
            restorePdfReadingAnchor(anchor);
            restoreTtsTextAnchor();
            readerTts?.layoutChanged();
            saveCurrentProgress();
            if (mode === 'scroll') void updateScrollWindow();
            return;
        }
        if (position) await restoreLinkPosition(position, {followSpeech: true});
        else await navigate(() => showLocation(currentChapterIndex, localPagedIndex));
        readerTts?.layoutChanged();
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
        updateCurrentToc()?.scrollIntoView({ block: 'nearest' });
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
        if (currentUser && currentUser.uid !== user?.uid) uploadQueue.cancelOwner(currentUser.uid);
        if (user) {
            currentUser = user;
            authModal.style.display = 'none';
            userEmailDisplay.innerText = user.email;
            await loadLibrary();
            handleRouting();
        } else {
            releaseBook();
            currentUser = null;
            authModal.style.display = 'flex';
            libraryView.classList.remove('active');
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
            uploadQueue.cancelOwner(currentUser?.uid);
            await signOut(auth);
        }
    });

    // --- Library Management (Firebase Firestore & Storage) ---

    async function loadLibrary(showOverlay = true) {
        if (!currentUser) return;
        const uid = currentUser.uid;
        if (showOverlay) {
            libraryGrid.innerHTML = '';
            showLoading('Kitaplar yükleniyor…');
        }
        try {
            await progressWrite;
            if (currentUser?.uid !== uid) return;
            const q = query(collection(db, 'users', uid, 'library'), orderBy('addedAt', 'desc'));
            const querySnapshot = await getDocs(q);
            if (currentUser?.uid !== uid) return;
            globalLibrary = [];
            querySnapshot.forEach((docSnap) => {
                globalLibrary.push({ id: docSnap.id, ...docSnap.data() });
            });
            renderLibrary(globalLibrary);
        } catch(e) {
            console.error("Kitaplar çekilemedi:", e);
            libraryGrid.textContent = 'Kütüphane yüklenemedi: ' + e.message;
        } finally {
            if (showOverlay && currentUser?.uid === uid) hideLoading();
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
            if (book.coverUrl) {
                const cover = document.createElement('img');
                cover.className = 'book-cover';
                cover.src = book.coverUrl;
                cover.alt = '';
                cover.loading = 'lazy';
                card.appendChild(cover);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'book-cover';
                placeholder.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
                card.appendChild(placeholder);
            }

            const info = document.createElement('div');
            info.className = 'book-info';
            const title = document.createElement('div');
            title.className = 'book-title';
            title.textContent = book.title;
            title.title = book.title;
            const progress = document.createElement('div');
            progress.className = 'book-progress-text';
            const percent = Math.max(0, Math.min(100, Math.round(Number(book.progress) || 0)));
            progress.textContent = `%${percent} okundu`;
            const track = document.createElement('div');
            track.className = 'book-progress-track';
            const fill = document.createElement('div');
            fill.className = 'book-progress-fill';
            fill.style.width = percent + '%';
            track.appendChild(fill);
            info.append(title, progress, track);
            card.appendChild(info);

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'delete-book-icon';
            deleteBtn.title = 'Kitabı Sil';
            deleteBtn.setAttribute('aria-label', `${book.title} kitabını sil`);
            deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
            card.appendChild(deleteBtn);
            card.onclick = () => openBook(book.id);

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
        disposeObjectView?.();
        disposeObjectView = null;
        linkHistory.clear();
        flushProgress();
        clearTimeout(scrollSaveTimeout);
        clearTimeout(layoutTimer);
        clearTimeout(settleTimer);
        clearTimeout(pagedAlignTimer);
        session++;
        sessionAbort.abort();
        paginationAbort.abort();
        sessionAbort = new AbortController();
        stopTTS();
        closePageJumpModal();
        disposePdfPages();
        pdfLayoutView.reset();
        pdfReadingAnchor = null;
        currentPdfDoc = null;
        currentPdfOutline = [];
        currentBookId = null;
        currentBookType = null;
        if (originalPdfSetting) originalPdfSetting.hidden = true;
        openOriginalPdf?.removeAttribute('href');

        epubSpine = [];
        bookContent.classList.remove('pdf-content');
        htmlSource = '';
        bookContent.replaceChildren();
        currentChapterIndex = localPagedIndex = 0;
        currentGlobalPage = currentPdfPage = 1;
        totalBookPages = totalPdfPages = 0;
        paginationFailed = false;
        pagedIndicator.style.display = '';
        isNavigatingPage = scrollWindowBusy = false;
        layoutKey = '';
        epubPagination = createEpubPagination();
        layoutPosition = settledPosition = speechSection = speechResume = keptAnchor = null;
        scrollWindowAgain = speechRedirected = speechInView = false;

        bookResources?.dispose();
        bookResources = null;
        htmlResourceUrl = null;
        cancelAnimationFrame(visibleAssetFrame);
        visibleAssetFrame = null;
    }

    function closeReader() {
        releaseBook();
        readerView.style.display = 'none';
        libraryView.style.display = 'block';
        libraryView.classList.add('active');
        closeSidebar(settingsSidebar);
        closeSidebar(tocSidebar);
        document.title = 'Premium Edge Reader';
        if (location.pathname !== '/') history.pushState(null, '', '/');
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        loadLibrary();
    }
    backToLibraryBtn.addEventListener('click', closeReader);

    const fontMetricCache = new Map();
    const fontMetricContext = document.createElement('canvas').getContext('2d');
    function fontMetricIdentity() {
        const style = getComputedStyle(bookContent);
        const font = [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle,
            style.fontStretch, style.fontVariationSettings, style.fontFeatureSettings, style.letterSpacing].join('|');
        if (!fontMetricCache.has(font)) {
            const widths = ['normal 400', 'normal 700', 'italic 400'].map(face => {
                fontMetricContext.font = face + ' ' + style.fontSize + ' ' + style.fontFamily;
                return Math.round(fontMetricContext.measureText('MmWwiIlıİşğ Çöü 0123456789').width * 1000) / 1000;
            });
            fontMetricCache.set(font, [font, ...widths]);
        }
        return fontMetricCache.get(font);
    }

    function getLayoutKey() {
        const s = currentSettings;
        return JSON.stringify([8, innerWidth, innerHeight, devicePixelRatio,
            s.fontSize, s.fontFamily, s.lineHeight, s.maxWidth, s.sidePadding, s.paragraphSpacing,
            fontMetricIdentity(), navigator.userAgent]);
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
            pdfLayoutView.apply();
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
        updateCurrentToc();
        const ready = totalBookPages > 0;
        if (ready && currentBookType === 'epub') {
            currentGlobalPage = epubSpine[currentChapterIndex].startPage + localPagedIndex;
        } else if (currentBookType === 'html') {
            currentGlobalPage = localPagedIndex + 1;
        }
        const missing = epubSpine.filter(chapter => chapter.missing).length;
        const warning = missing ? missing + ' bölüm EPUB dosyasında eksik. Toplam yalnızca mevcut içeriği kapsar.' : '';
        pagedIndicator.title = paginationFailed ? paginationFailureMessage : warning || 'Sayfaya Git (G)';
        pagedIndicator.style.display = paginationFailed ? 'block' : '';
        pagedPageText.textContent = ready
            ? 'Sayfa ' + currentGlobalPage + ' / ' + totalBookPages + (missing ? ' · eksik EPUB' : '')
            : paginationFailed ? 'Sayfa sayısı hesaplanamadı' : 'Sayfalar hesaplanıyor…';
        progressBar.style.width = ready ? (100 * currentGlobalPage / totalBookPages) + '%' : '0%';
        pageJumpInput.disabled = pageJumpSlider.disabled = pageJumpSubmit.disabled = !ready || isNavigatingPage;
        jumpTotalPages.textContent = ready ? totalBookPages : '…';
        pageJumpInput.max = pageJumpSlider.max = Math.max(1, totalBookPages);
        pagedPrevBtn.disabled = isNavigatingPage || paginationFailed || (currentChapterIndex === 0 && localPagedIndex === 0 && currentPdfPage === 1);
        pagedNextBtn.disabled = isNavigatingPage || paginationFailed || (ready && currentGlobalPage >= totalBookPages);
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
                    readingMode: currentSettings.readingMode,
                    ...(currentBookType !== 'pdf' ? {anchor: null} : {})
                }
            }
        };
    }

    const linkHistory = createReaderLinkHistory({
        toast: document.getElementById('link-return-toast'),
        settingsButton: document.getElementById('link-return-settings'),
        settingsGroup: document.getElementById('link-return-setting'),
        capture: captureLinkPosition, restore: restoreLinkPosition,
        onReturn: () => closeSidebar(settingsSidebar)
    });

    function captureLinkPosition() {
        if (!currentBookId || isNavigatingPage) return null;
        const paged = currentSettings.readingMode === 'paged';
        const index = currentBookType === 'pdf' ? currentPdfPage - 1 : currentChapterIndex;
        const section = paged ? bookContent.querySelector(':scope > section[data-index="' + index + '"]')
            : [...bookContent.children].find(element => element.getBoundingClientRect().bottom > 100);
        if (!section) return null;
        const sectionIndex = Number(section.dataset.index);
        const count = currentBookType === 'epub' ? epubSpine[sectionIndex].pageCount || 1 : totalBookPages || 1;
        const ratio = paged ? localPagedIndex / count
            : Math.max(0, Math.min(0.999999, (80 - section.getBoundingClientRect().top) / Math.max(1, section.offsetHeight)));
        const localPage = currentBookType === 'pdf' ? sectionIndex : paged ? localPagedIndex : Math.floor(ratio * count);
        const kept = paged && currentBookType !== 'pdf' && keptAnchor?.sectionIndex === sectionIndex ? keptAnchor.anchor : null;
        return { bookId: currentBookId, chapterIndex: currentBookType === 'epub' ? sectionIndex : 0,
            localPage, scrollRatio: ratio, layoutKey, readingMode: currentSettings.readingMode,
            globalPage: currentBookType === 'epub' ? (epubSpine[sectionIndex].startPage || 1) + localPage : localPage + 1,
            anchor: kept || captureReaderTextAnchor(section.querySelector('.pdf-page-text') || section, bookViewport, paged) };
    }

    async function restoreLinkPosition(position, {followSpeech = false} = {}) {
        if (position.bookId !== currentBookId) return false;
        return navigate(async () => {
            const paged = currentSettings.readingMode === 'paged';
            // Edge's default start is not the reading position while it is being redirected.
            const following = followSpeech && !speechRedirected;
            // Keep the section either speech player reads; changing modes must not
            // detach its text or restart its utterance.
            const spokenSection = followSpeech && paged && currentBookType !== 'pdf'
                ? readerTts?.section() || (following ? speechHighlight(bookContent)?.closest('#book-content > section') : null) : null;
            const chapterIndex = spokenSection ? Number(spokenSection.dataset.index) : position.chapterIndex;
            const count = currentBookType === 'epub' ? epubSpine[chapterIndex].pageCount : totalBookPages;
            const index = currentBookType === 'pdf' ? position.localPage : chapterIndex;
            let section = bookContent.querySelector(':scope > section[data-index="' + index + '"]');
            // Reflow mounted text in place: speech tools such as Edge Read Aloud hold
            // its nodes and stop, losing their place, when it is rendered again.
            const mounted = currentBookType !== 'pdf' && section && section.dataset.loaded !== 'false';
            if (mounted) {
                if (paged) {
                    // Paged mode shows one chapter: drop the scroll window's other sections.
                    const others = Array.from(bookContent.children).filter(element => element !== section);
                    others.forEach(element => element.remove());
                    currentChapterIndex = chapterIndex;
                    window.scrollTo({top: 0, behavior: 'instant'});
                }
            } else {
                const local = currentBookType === 'pdf' || (position.layoutKey === layoutKey && position.readingMode === currentSettings.readingMode)
                    ? position.localPage : Math.min(count - 1, Math.floor(position.scrollRatio * count));
                await showLocation(position.chapterIndex, local, position.scrollRatio);
                section = bookContent.querySelector(':scope > section[data-index="' + index + '"]');
            }
            if (!section?.isConnected || position.bookId !== currentBookId) return;
            await settleContent(section);
            const columned = paged && currentBookType !== 'pdf';
            const spoken = columned && followSpeech && readerTts?.section() === section
                ? ttsColumn(readerTts.range()) : following && columned ? speechHighlightColumn(section, bookViewport) : null;
            const page = spoken ?? restoreReaderTextAnchor(section.querySelector('.pdf-page-text') || section,
                bookViewport, paged, columned, position.anchor);
            // Edge's word only picks the page; later captures measure the page itself.
            if (columned && spoken === null && page !== null && !position.spoken) keptAnchor = {sectionIndex: index, anchor: position.anchor};
            if (page !== null) { localPagedIndex = page; updatePagedView(); }
            else if (mounted && paged) updatePagedView();
            else if (!paged && currentBookType !== 'pdf') {
                const ratio = Math.max(0, Math.min(0.999999, (80 - section.getBoundingClientRect().top) / Math.max(1, section.offsetHeight)));
                localPagedIndex = Math.floor(ratio * count);
                updatePagedIndicator();
            }
            pdfReadingAnchor = capturePdfReadingAnchor();
            bookContent.focus({preventScroll: true});
        }, {followSpeech});
    }

    function capturePendingTextAnchor() {
        if (pendingProgress?.id !== currentBookId || currentBookType === 'pdf') return;
        const position = captureLinkPosition();
        const pending = pendingProgress.data.readerPosition;
        if (position && pending.chapterIndex === position.chapterIndex && pending.localPage === position.localPage) {
            pending.anchor = position.anchor;
        }
    }

    function flushProgress() {
        capturePendingTextAnchor();
        if (!pendingProgress || !currentUser) return;
        const { id, data } = pendingProgress;
        const uid = currentUser.uid;
        pendingProgress = null;
        const book = globalLibrary.find(b => b.id === id);
        if (book) Object.assign(book, data);

        progressWrite = progressWrite.then(async () => {
            const bookRef = doc(db, "users", uid, "library", id);
            await updateDoc(bookRef, data);
        }).catch(error => console.warn("İlerleme kaydedilemedi:", error));
    }

    function saveCurrentProgress() {
        updateLocation();
        pendingProgress = captureProgress();
        clearTimeout(scrollSaveTimeout);
        scrollSaveTimeout = setTimeout(flushProgress, 1500);
        // Until the new position settles, a resize measures the current text instead.
        settledPosition = null;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(rememberSettledPosition, 150);
        speechInView = speechOnPage();
    }

    function speechOnPage() {
        if (currentBookType === 'pdf' || currentSettings.readingMode !== 'paged' || speechRedirected) return false;
        const column = speechHighlightColumn(bookContent, bookViewport);
        return column !== null && column === Math.round(bookViewport.scrollLeft / Math.max(1, bookViewport.clientWidth));
    }

    // Closing Edge's bar removes its highlight and then resizes the page. While the
    // page shows Edge's word, that word (not the page start) is the text to keep.
    function spokenLinkPosition(base) {
        if (!speechInView || !base) return null;
        const highlight = speechHighlight(bookContent);
        const word = highlight ? null : speechPositionWord(speechResume);
        const node = highlight ? document.createTreeWalker(highlight, NodeFilter.SHOW_TEXT).nextNode() : word?.startContainer;
        const section = node?.parentElement.closest('#book-content > section');
        if (!section || Number(section.dataset.index) !== base.chapterIndex) return null;
        const anchor = readerTextAnchorAt(section, node, word ? word.startOffset : 0, true);
        return anchor && {...base, anchor, spoken: true};
    }

    // A resize event already reports the new geometry, so the text read before it
    // must be measured while the previous layout was still on screen.
    function rememberSettledPosition() {
        if (currentBookType === 'pdf' || layoutPosition || getLayoutKey() !== layoutKey) return;
        settledPosition = captureLinkPosition();
    }
    window.addEventListener('pagehide', flushProgress);
    bookContent.addEventListener('scroll', event => {
        if (event.target.closest?.('.reader-object-shell') && !isNavigatingPage) saveCurrentProgress();
    }, true);

    async function settleContent(article, key = null) {
        const pagination = epubPagination;
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
        pagination.fit(article, key || getLayoutKey());
        return article.scrollWidth;
    }

    async function countBookPages() {
        paginationAbort.abort();
        paginationAbort = new AbortController();
        const signal = paginationAbort.signal;
        const token = session;
        layoutKey = getLayoutKey();
        const key = layoutKey;
        paginationFailed = false;
        totalBookPages = currentBookType === 'pdf' ? totalPdfPages : 0;
        updatePagedIndicator();
        if (!currentBookId || currentBookType === 'pdf') return;
        const book = globalLibrary.find(b => b.id === currentBookId);
        const cacheKey = 'edgeReaderPages:' + currentBookId;
        if (currentBookType === 'epub') {
            try {
                const cache = JSON.parse(localStorage.getItem(cacheKey));
                if (cache && cache.key === key && cache.file === book.fileName && cache.counts.length === epubSpine.length &&
                    cache.counts.every(n => Number.isSafeInteger(n) && n >= 0) &&
                    cache.layoutPlans?.length === epubSpine.length &&
                    epubPagination.restore(key, cache.layoutPlans)) {
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
            let nextStartPage = 1;
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
                section.dataset.readerStartPage = String(nextStartPage);
                article.replaceChildren(section);
                viewport.scrollLeft = 0;
                await settleContent(article, key);
                signal.throwIfAborted();
                const pageCount = Math.max(1, Math.round(viewport.scrollWidth / viewport.clientWidth));
                counts.push(pageCount);
                nextStartPage += pageCount;
                article.replaceChildren();
                pagedPageText.textContent = 'Sayfalar hesaplanıyor (' + (index + 1) + '/' + length + ')…';
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (token !== session || key !== getLayoutKey()) return;
            if (currentBookType === 'epub') {
                commitPageMap(counts);
                try {localStorage.setItem(cacheKey, JSON.stringify({key, file: book.fileName, counts,
                    layoutPlans: epubPagination.serialize(key, length)}));} catch (_) {}
            } else totalBookPages = counts[0];
            updatePagedIndicator();
        } finally {
            frame.remove();
        }
    }

    function startPagination() {
        const token = session;
        const key = getLayoutKey();
        const work = countBookPages();
        const currentSignal = paginationAbort.signal;
        paginationPromise = work.catch(error => {
            if (currentSignal.aborted || token !== session || key !== getLayoutKey() || error.name === 'AbortError') return;
            console.error(error);
            paginationFailed = true;
            updatePagedIndicator();
        });
        return paginationPromise;
    }

    async function showLocation(chapterIndex, localPage = 0, scrollRatio = null, isCurrent = null) {
        const token = session;
        const location = ++locationVersion;
        const type = currentBookType;
        let section;
        if (type === 'epub') {
            section = await loadEpubChapter(chapterIndex);
        } else if (type === 'pdf') {
            section = await createPdfPageSection(localPage + 1);
        } else section = await makeHtmlSection(document);
        if (token !== session || location !== locationVersion || (isCurrent && !isCurrent())) return;
        disposePdfPages();
        bookContent.replaceChildren(section);
        currentChapterIndex = chapterIndex;
        currentPdfPage = type === 'pdf' ? localPage + 1 : 1;
        if (type === 'pdf') mountPdfPage(section);
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

    async function navigate(action, {followSpeech = false} = {}) {
        if (!currentBookId || isNavigatingPage) return false;
        const token = session;
        if (!followSpeech) {
            readerTts?.navigation();
            ttsPosition = null;
            ttsInView = false;
        }
        isNavigatingPage = true;
        keptAnchor = null;
        updatePagedIndicator();
        try {
            await action();
            if (token === session) { saveCurrentProgress(); return true; }
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
                readerTts?.layoutChanged();
            }
        }
        return false;
    }

    async function goToPage(page) {
        if (pdfLayoutView.isDragging || !Number.isSafeInteger(page) || page < 1 || page > totalBookPages) return;
        return navigate(async () => {
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

    async function hydrateScrollSection(index, active, token = session, location = locationVersion, isCurrent = null) {
        let section = bookContent.querySelector(':scope > section[data-index="' + index + '"]');
        if (section?.dataset.loaded === 'true') return section;
        const isEpub = currentBookType === 'epub';
        const fresh = isEpub ? await loadEpubChapter(index) : await createPdfPageSection(index + 1);
        if (token !== session || location !== locationVersion || currentSettings.readingMode !== 'scroll' || (isCurrent && !isCurrent())) return null;
        const top = active.getBoundingClientRect().top;
        if (section) section.replaceWith(fresh);
        else {
            const after = [...bookContent.children].find(element => Number(element.dataset.index) > index);
            bookContent.insertBefore(fresh, after || null);
        }
        section = fresh;
        if (!isEpub) mountPdfPage(section);
        if (active.isConnected) window.scrollBy({top: active.getBoundingClientRect().top - top, behavior: 'instant'});
        await settleContent(section);
        return token === session && location === locationVersion ? section : null;
    }

    async function updateScrollWindow() {
        // A request made while busy (a scroll or Edge entering another section) runs afterwards.
        if (scrollWindowBusy) {
            scrollWindowAgain = true;
            return;
        }
        if (isNavigatingPage || pdfLayoutView.isDragging || currentSettings.readingMode !== 'scroll' || !['epub', 'pdf'].includes(currentBookType)) return;
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
            // Both players keep the spoken section and the following section
            // mounted even when the reader scrolls away.
            const spoken = [speechHighlight(bookContent)?.closest('#book-content > section'), readerTts?.section()].filter(Boolean);
            const speaking = spoken.flatMap(section => [Number(section.dataset.index), Number(section.dataset.index) + 1]).filter(i => i < length);
            const hydrate = i => hydrateScrollSection(i, active, token, location);
            for (let i = start; i <= end; i++) {
                const section = await hydrate(i);
                if (!section) return;
                // Short sections at the viewport end need a following chapter to leave room to scroll.
                if (i === end && end < length - 1 && section.getBoundingClientRect().bottom < innerHeight + 200) end++;
            }
            for (const i of speaking) {
                if ((i < start || i > end) && !await hydrate(i)) return;
            }
            for (const element of bookContent.children) {
                const elementIndex = Number(element.dataset.index);
                if ((elementIndex >= start && elementIndex <= end) || speaking.includes(elementIndex) || element.dataset.loaded !== 'true') continue;
                const height = element.getBoundingClientRect().height;
                if (!isEpub) disposePdfPage(element);
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
        } finally {
            if (token === session) {
                scrollWindowBusy = false;
                if (scrollWindowAgain) {
                    scrollWindowAgain = false;
                    void updateScrollWindow();
                }
            }
        }
    }

    function syncScrollPage() {
        if (currentBookType === 'epub' || currentBookType === 'pdf') updateScrollWindow();
        else if (currentBookType === 'html') {
            const max = document.documentElement.scrollHeight - innerHeight;
            localPagedIndex = Math.max(0, Math.min(totalBookPages - 1, Math.floor((window.scrollY / Math.max(1, max)) * totalBookPages)));
            updatePagedIndicator();
            saveCurrentProgress();
        }
    }

    window.addEventListener('scroll', () => {
        lastScrollY = window.scrollY;
        loadVisibleAssets();
        if (!currentBookId || currentSettings.readingMode !== 'scroll' || isNavigatingPage) return;
        syncScrollPage();
    }, {passive: true});

    function openPageJumpModal() {
        if (!currentBookId) return;
        updatePagedIndicator();
        pageJumpInput.value = pageJumpSlider.value = currentGlobalPage;
        document.getElementById('page-jump-status').textContent = paginationFailed
            ? paginationFailureMessage : totalBookPages
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
    installPageTurns({
        view: document.getElementById('reader-view'), viewport: bookViewport, content: bookContent,
        isPaged: () => !!currentBookId && currentSettings.readingMode === 'paged' && !pdfLayoutView.isDragging,
        turn: direction => direction > 0 ? goToNextPage() : goToPrevPage()
    });

    bookViewport.addEventListener('click', event => {
        if (pdfLayoutView.isDragging || currentSettings.readingMode !== 'paged' || event.target.closest('a,button,input,select,[role="separator"],.pdf-page-image-column,.reader-object-shell,.reader-object-dialog') || window.getSelection().toString()) return;
        const rect = bookViewport.getBoundingClientRect();
        const x = event.clientX - rect.left;
        // Clicks and taps never turn pages; the middle of the page shows the top bar.
        if (x < rect.width * 0.25 || x > rect.width * 0.75) return;
        const nav = document.getElementById('reader-nav');
        const visible = nav.style.opacity === '1';
        nav.style.opacity = visible ? '0' : '1';
        nav.style.visibility = visible ? 'hidden' : 'visible';
        nav.style.pointerEvents = visible ? 'none' : 'auto';
    });

    window.addEventListener('keydown', event => {
        if (!currentBookId || pdfLayoutView.isDragging || pageJumpModal.open || event.target.closest('input,textarea,select,[contenteditable="true"],[role="separator"],.reader-object-shell,.reader-object-dialog')) return;
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
        if (currentBookType === 'pdf') {
            const anchor = pdfReadingAnchor;
            pdfLayoutView.apply();
            restorePdfReadingAnchor(anchor);
            restoreTtsTextAnchor();
            readerTts?.layoutChanged();
            return;
        }
        // A pending reflow must also follow a resize back to the counted layout.
        if (!currentBookId || (getLayoutKey() === layoutKey && !layoutPosition)) return;
        clearTimeout(settleTimer);
        const settled = settledPosition?.bookId === currentBookId &&
            settledPosition.readingMode === currentSettings.readingMode ? settledPosition : null;
        const base = settled || captureLinkPosition();
        layoutPosition ||= ttsLinkPosition(base) || spokenLinkPosition(base) || base;
        paginationAbort.abort();
        totalBookPages = 0;
        paginationFailed = false;
        updatePagedIndicator();
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(reflowBook, 180, session, ++layoutGeneration);
    }

    // Reflow the mounted text first; the page map is then counted off-screen and
    // only renumbers the position, so the visible text is never rendered again.
    async function reflowBook(token, generation) {
        try {
            if (token !== session) return;
            if (isNavigatingPage) {
                layoutTimer = setTimeout(reflowBook, 180, token, generation);
                return;
            }
            const position = layoutPosition;
            if (position && currentBookId) await restoreLinkPosition(position, {followSpeech: true});
            // A later geometry change keeps the remembered text and reflows again.
            if (token !== session || generation !== layoutGeneration) return;
            layoutPosition = null;
            readerTts?.layoutChanged();
            await startPagination();
            if (token !== session || generation !== layoutGeneration || !totalBookPages) return;
            if (currentSettings.readingMode === 'scroll') syncScrollPage();
            else {
                updatePagedIndicator();
                saveCurrentProgress();
            }
        } catch (error) {if (error.name !== 'AbortError') console.error(error);}
    }
    window.addEventListener('resize', scheduleRepagination);
    document.fonts.addEventListener('loadingdone', () => {
        fontMetricCache.clear();
        if (currentBookType !== 'pdf') scheduleRepagination();
    });

    async function openBook(id) {
        releaseBook();
        disposeObjectView = installObjectView(bookContent);
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
                currentPdfOutline = await loadPdfOutline(currentPdfDoc, sessionAbort.signal);
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
            if (originalPdfSetting) originalPdfSetting.hidden = currentBookType !== 'pdf';
            if (currentBookType === 'pdf' && openOriginalPdf) openOriginalPdf.href = book.bookUrl;

            libraryView.classList.remove('active');
            libraryView.style.display = 'none';
            readerView.style.display = 'block';
            window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            applySettings();
            const saved = book.readerPosition;
            let chapter = currentBookType === 'epub' ? Number(params.get('ch') ?? saved?.chapterIndex ?? book.chapterIndex ?? 0) : 0;
            chapter = Number.isSafeInteger(chapter) ? Math.max(0, Math.min(chapter, epubSpine.length - 1)) : 0;
            if (currentBookType !== 'epub') chapter = 0;
            let local = Math.max(0, Number(params.get('local') ?? saved?.localPage ?? 0) || 0);
            if (currentBookType === 'pdf') local = Math.max(0, Math.min(totalPdfPages - 1, (Number(params.get('page') ?? book.pageIndex) || 1) - 1));
            isNavigatingPage = true;
            if (currentBookType === 'epub') {
                try {
                    const cache = JSON.parse(localStorage.getItem('edgeReaderPages:' + currentBookId));
                    if (cache?.key === getLayoutKey() && cache.file === book.fileName && cache.layoutPlans?.length === epubSpine.length) {
                        epubPagination.restore(cache.key, cache.layoutPlans);
                    }
                } catch (_) {}
            }
            await showLocation(chapter, local, saved?.readingMode === 'scroll' ? saved.scrollRatio : null);
            if (token !== session) return;
            isNavigatingPage = false;
            renderToc(book);
            hideLoading();
            await startPagination();
            if (token !== session) return;
            const savedTarget = saved?.anchor && currentBookType !== 'pdf' && totalBookPages > 0 &&
                (!params.has('ch') || Number(params.get('ch')) === saved.chapterIndex) &&
                (!params.has('local') || Number(params.get('local')) === saved.localPage) &&
                (!params.has('page') || Number(params.get('page')) === saved.globalPage);
            if (savedTarget) {
                await restoreLinkPosition({...saved, bookId: id, chapterIndex: chapter});
            } else if (totalBookPages > 0 && params.has('page') && !params.has('ch')) {
                await goToPage(Math.max(1, Math.min(totalBookPages, Number(params.get('page')) || 1)));
            } else {
                if (totalBookPages > 0 && saved && saved.layoutKey !== layoutKey && !params.has('local')) {
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

    function updateCurrentToc() {
        return updateReaderToc(tocList, currentBookType === 'pdf'
            ? { pdfPage: currentPdfPage } : { sectionIndex: currentChapterIndex });
    }

    function renderToc(book) {
        tocList.replaceChildren();
        if (currentBookType === 'pdf') {
            renderPdfToc(currentPdfOutline, tocList, {
                bookId: currentBookId,
                onNavigate: async page => { closeSidebar(tocSidebar); await linkHistory.follow(() => goToPage(page)); }
            });
            if (!tocList.children.length) tocList.textContent = 'PDF’de yer işareti/içindekiler kaydı bulunamadı.';
            updateCurrentToc();
            return;
        }
        for (const item of book.toc || []) {
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.href = item.link; link.textContent = item.title;
            const index = epubSpine.findIndex(ch => ch.id === item.link.replace(/^#/, ''));
            if (index >= 0) link.dataset.sectionIndex = index;
            link.addEventListener('click', async event => {
                event.preventDefault();
                const target = item.link.replace(/^#/, '');
                const index = epubSpine.findIndex(ch => ch.id === target);
                if (index >= 0) {
                    closeSidebar(tocSidebar);
                    await linkHistory.follow(() => navigate(() => showLocation(index)));
                }
            });
            li.appendChild(link); tocList.appendChild(li);
        }
        if (!tocList.children.length) tocList.textContent = 'İçindekiler bulunamadı';
        updateCurrentToc();
    }

    // --- File Processing (Adding to Firebase) ---

    async function deleteBookFiles(book) {
        if (!book) return;
        for (const path of [book.storagePath, book.layoutStoragePath, book.coverStoragePath].filter(Boolean)) {
            try { await deleteObject(ref(storage, path)); }
            catch (error) { if (error.code !== 'storage/object-not-found') throw error; }
        }
    }

    async function uploadFile(path, blob, { report, signal, throwIfCancelled }, transferred, total) {
        throwIfCancelled();
        const task = uploadBytesResumable(ref(storage, path), blob, {
            contentType: blob.type || 'application/octet-stream',
            cacheControl: 'private,max-age=31536000,immutable'
        });
        const abort = () => task.cancel();
        signal.addEventListener('abort', abort, { once: true });
        try {
            throwIfCancelled();
            await new Promise((resolve, reject) => task.on('state_changed', snapshot => {
                report({ stage: 'sending', loaded: transferred + snapshot.bytesTransferred, total });
            }, reject, resolve));
            throwIfCancelled();
            return await getDownloadURL(task.snapshot.ref);
        } finally { signal.removeEventListener('abort', abort); }
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

    const uploadQueue = createUploadQueue({
        getOwnerKey: () => currentUser?.uid ?? null,
        run: uploadBook,
        onComplete: async (_, { ownerKey }) => {
            if (currentUser?.uid === ownerKey) await loadLibrary(false);
        }
    });
    fileInput.addEventListener('change', event => {
        const files = [...event.target.files];
        fileInput.value = '';
        if (files.length && currentUser) uploadQueue.add(files, currentUser.uid);
    });

    async function uploadBook(file, context) {
        const { report, signal, ownerKey: uid, throwIfCancelled } = context;
        const attemptedPaths = [];
        let committed = false;
        report({ stage: 'preparing', detail: 'Kitap cihazınızda hazırlanıyor' });
        try {
            const fileName = file.name.toLowerCase();
            let title = file.name.replace(/\.[^/.]+$/, '');
            let coverBlob = null;
            let toc = [];
            let layout = null;
            if (/\.(epub|htmlz|zip)$/.test(fileName)) {
                const zip = await JSZip.loadAsync(await file.arrayBuffer());
                throwIfCancelled();
                if (fileName.endsWith('.epub')) {
                    const metadata = await extractEpubMeta(zip);
                    if (metadata.title) title = metadata.title;
                    coverBlob = metadata.coverBlob;
                    toc = metadata.toc;
                } else if (!Object.keys(zip.files).some(name => /\.html?$/i.test(name))) {
                    throw new Error('Arşivde HTML bulunamadı.');
                }
                layout = await buildLayoutBundle(zip, { onProgress: ({ processed, total }) => {
                    throwIfCancelled();
                    report({ stage: 'preparing', name: title, detail: 'Sayfa düzeni hazırlanıyor (' + processed + '/' + total + ')' });
                } });
            } else if (fileName.endsWith('.pdf')) {
                const task = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
                const abort = () => { void task.destroy(); };
                signal.addEventListener('abort', abort, { once: true });
                try {
                    throwIfCancelled();
                    const pdf = await task.promise;
                    const metadata = await pdf.getMetadata();
                    if (metadata.info?.Title) title = metadata.info.Title;
                } finally {
                    signal.removeEventListener('abort', abort);
                    await task.destroy();
                }
            } else if (!/\.html?$/.test(fileName)) throw new Error('Desteklenmeyen kitap biçimi.');
            throwIfCancelled();
            if (coverBlob) {
                try { coverBlob = await thumbnail(coverBlob); }
                catch (error) { console.warn('Kapak küçültülemedi:', error); coverBlob = null; }
            }
            throwIfCancelled();
            report({ stage: 'sending', name: title, loaded: 0,
                total: file.size + (layout?.blob.size || 0) + (coverBlob?.size || 0) });
            const total = file.size + (layout?.blob.size || 0) + (coverBlob?.size || 0);
            let transferred = 0;
            const bookId = 'book_' + crypto.randomUUID();
            const safeFileName = bookId + '_' + fileName.replace(/[^a-zA-Z0-9.\-]/g, '_');
            const storagePath = `users/${uid}/books/${safeFileName}`;
            attemptedPaths.push(storagePath);
            const bookUrl = await uploadFile(storagePath, file, context, transferred, total);
            transferred += file.size;
            let layoutUrl = null, layoutStoragePath = null;
            if (layout) {
                layoutStoragePath = `users/${uid}/layouts/${bookId}.zip`;
                attemptedPaths.push(layoutStoragePath);
                layoutUrl = await uploadFile(layoutStoragePath, layout.blob, context, transferred, total);
                transferred += layout.blob.size;
            }
            let coverUrl = null, coverStoragePath = null;
            if (coverBlob) {
                coverStoragePath = `users/${uid}/covers/${bookId}_cover.webp`;
                attemptedPaths.push(coverStoragePath);
                coverUrl = await uploadFile(coverStoragePath, coverBlob, context, transferred, total);
            }
            report({ stage: 'finalizing', detail: 'Kütüphane kaydı tamamlanıyor' });
            throwIfCancelled();
            const bookData = {
                id: bookId, title, fileName: safeFileName, fileSize: file.size,
                bookUrl, storagePath, layoutUrl, layoutStoragePath, layoutVersion: layout ? 1 : 0,
                coverUrl, coverStoragePath, toc, progress: 0, scrollY: 0,
                chapterIndex: 0, pageIndex: 1, addedAt: Date.now()
            };
            await setDoc(doc(db, 'users', uid, 'library', bookId), bookData);
            committed = true;
            return bookData;
        } catch (error) {
            if (!committed) {
                const cleanup = await Promise.allSettled(attemptedPaths.map(path => deleteObject(ref(storage, path))));
                if (cleanup.some(item => item.status === 'rejected' && item.reason.code !== 'storage/object-not-found')) {
                    console.warn('Yarım kalan yükleme temizlenemedi:', attemptedPaths);
                }
            }
            if (signal.aborted) throw signal.reason;
            throw new Error(storageErrorMessage(error), { cause: error });
        }
    }
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
        const packageLayout = opf.querySelector('metadata > meta[property="rendition:layout"]:not([refines])')?.textContent.trim() || 'reflowable';
        const progression = opf.querySelector('spine')?.getAttribute('page-progression-direction') || 'default';
        epubSpine = Array.from(opf.querySelectorAll('spine > itemref'), item => {
            const href = manifest.get(item.getAttribute('idref'));
            if (!href) throw new Error('EPUB bölüm kaydı eksik.');
            const url = new URL(href, opfUrl).href;
            const path = url.slice(resourceBase.length).split('#')[0];
            const properties = (item.getAttribute('properties') || '').split(/\s+/);
            const layout = properties.includes('rendition:layout-pre-paginated') ? 'pre-paginated'
                : properties.includes('rendition:layout-reflowable') ? 'reflowable' : packageLayout;
            return {url, id: 'chapter-' + decodeURIComponent(path), layout, progression, pageCount: 0, startPage: 0};
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
        section.dataset.readerStartPage = String(chapter.startPage || 1);
        section.dataset.readerLayoutType = chapter.layout;
        section.dataset.readerProgression = chapter.progression;
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
        if (!link || !['epub', 'html'].includes(currentBookType) || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const url = new URL(link.href);
        const index = currentBookType === 'epub'
            ? epubSpine.findIndex(ch => ch.url.split('#')[0] === url.href.split('#')[0])
            : url.hash && (link.getAttribute('href').startsWith('#') || url.href.split('#')[0] === htmlResourceUrl) ? 0 : -1;
        if (index < 0) return;
        event.preventDefault();
        await linkHistory.follow(() => navigate(async () => {
            await showLocation(index);
            if (url.hash) {
                const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
                if (target && currentSettings.readingMode === 'paged') {
                    const pageTarget = target.closest('.reader-object-shell') || target;
                    localPagedIndex = Math.max(0, Math.floor((pageTarget.getBoundingClientRect().left - bookViewport.getBoundingClientRect().left + bookViewport.scrollLeft) / bookViewport.clientWidth));
                    updatePagedView();
                } else target?.scrollIntoView();
                if (target) revealReaderObjectTarget(target);
            }
        }));
    });

    async function createPdfPageSection(pageNumber) {
        const page = await currentPdfDoc.getPage(pageNumber);
        const blocks = await getNativePdfBlocks(page, currentPdfDoc, pdfjsLib);
        const section = createPdfPage(pageNumber);
        section.dataset.textSource = 'native';
        const text = section.querySelector('.pdf-page-text');
        const native = renderNativePdfBlocks(blocks, document, {onNavigate: page => linkHistory.follow(() => goToPage(page))});
        while (native.firstChild) text.appendChild(native.firstChild);
        if (!text.children.length) {
            const notice = document.createElement('p');
            notice.textContent = 'Bu sayfanın yerleşik PDF metni boş. Kaynak PDF görünümünü kullanabilirsiniz; hosting sürümünde OCR çalıştırılmaz.';
            text.appendChild(notice);
        }
        return section;
    }

    function mountPdfPage(section) {
        pdfPageStates.set(section, { viewer: null });
        pdfLayoutView.apply();
    }
    function disposePdfPage(section) {
        const state = pdfPageStates.get(section);
        if (!state) return;
        pdfLayoutView.dispose(section, state);
        pdfPageStates.delete(section);
    }
    function disposePdfPages() {
        for (const section of pdfPageStates.keys()) disposePdfPage(section);
    }

    function capturePdfReadingAnchor() {
        if (currentBookType !== 'pdf') return null;
        const paged = currentSettings.readingMode === 'paged';
        const line = paged ? bookViewport.getBoundingClientRect().top + 20 : 100;
        const section = paged
            ? bookContent.querySelector('.pdf-page[data-page-index="' + currentPdfPage + '"]')
            : [...bookContent.children].find(element => element.getBoundingClientRect().bottom > line);
        if (!section || section.dataset.loaded !== 'true') return null;
        const blocks = [...(section.querySelector('.pdf-page-text')?.children || [])];
        const node = blocks.find(element => element.getBoundingClientRect().bottom > line) || section;
        const rect = node.getBoundingClientRect();
        const point = Math.max(line, rect.top);
        return { section, node, index: blocks.indexOf(node), point,
            fraction: Math.max(0, Math.min(1, (point - rect.top) / Math.max(1, rect.height))) };
    }
    function pdfAnchorShift(anchor) {
        if (!anchor?.section.isConnected) return null;
        const node = anchor.node.isConnected ? anchor.node
            : anchor.section.querySelector('.pdf-page-text')?.children[anchor.index] || anchor.section;
        const rect = node.getBoundingClientRect();
        return rect.top + anchor.fraction * rect.height - anchor.point;
    }
    function restorePdfReadingAnchor(anchor) {
        const delta = pdfAnchorShift(anchor);
        if (delta === null) return;
        if (currentSettings.readingMode === 'paged') bookViewport.scrollBy({ top: delta, behavior: 'instant' });
        else window.scrollBy({ top: delta, behavior: 'instant' });
        pdfReadingAnchor = capturePdfReadingAnchor();
    }
    const rememberPdfReadingAnchor = () => {
        if (currentBookType === 'pdf' && !pdfLayoutView.isDragging) pdfReadingAnchor = capturePdfReadingAnchor();
    };
    window.addEventListener('scroll', rememberPdfReadingAnchor, { passive: true });
    bookViewport.addEventListener('scroll', rememberPdfReadingAnchor, { passive: true });

    // Edge Read Aloud turns pages itself by aligning the spoken word with the
    // viewport edge (e.g. 980 instead of 900). When a horizontal scroll ends, snap
    // back to the page grid and adopt that page; the reader's own turns are aligned.
    function alignPagedScroll() {
        clearTimeout(pagedAlignTimer);
        if (!currentBookId || currentBookType === 'pdf' || currentSettings.readingMode !== 'paged' ||
            isNavigatingPage || layoutPosition) return;
        const width = bookViewport.clientWidth;
        if (!width) return;
        const page = Math.round(bookViewport.scrollLeft / width);
        if (Math.abs(bookViewport.scrollLeft - page * width) > 1) bookViewport.scrollTo({ left: page * width, behavior: 'instant' });
        if (page === localPagedIndex) return;
        localPagedIndex = page;
        keptAnchor = null;
        updatePagedIndicator();
        saveCurrentProgress();
        loadVisibleAssets();
    }
    bookViewport.addEventListener('scroll', event => {
        if (event.target !== bookViewport || currentBookType === 'pdf') return;
        clearTimeout(pagedAlignTimer);
        pagedAlignTimer = setTimeout(alignPagedScroll, 250);
    }, { passive: true });
    bookViewport.addEventListener('scrollend', event => {
        if (event.target === bookViewport) alignPagedScroll();
    });

    // Ctrl+Shift+U, or Play after Edge paused itself (another tab became active),
    // starts Edge Read Aloud at its default point: the first loaded text, the page's
    // first <h1>, or reader chrome before the book.
    function isDefaultSpeechStart(highlight) {
        if (!bookContent.contains(highlight)) {
            return !!(highlight.compareDocumentPosition(bookContent) & Node.DOCUMENT_POSITION_FOLLOWING);
        }
        const heading = highlight.closest('h1');
        if (heading && heading === document.querySelector('h1')) return true;
        const first = Array.from(bookContent.children).find(section => section.dataset.loaded !== 'false');
        return !!first?.contains(highlight) && speechStartsContainer(first, highlight,
            node => currentBookType !== 'pdf' || !!node.parentElement.closest('.pdf-page-text'));
    }

    function readerViewBounds(paged) {
        const rect = bookViewport.getBoundingClientRect();
        return paged ? {left: rect.left, right: rect.right, top: Math.max(0, rect.top), bottom: Math.min(innerHeight, rect.bottom)}
            : {left: Math.max(0, rect.left), right: Math.min(innerWidth, rect.right), top: 0, bottom: innerHeight};
    }

    // Bring a start back to the reader: restore the reader's own view (Edge has
    // already scrolled to its start), then select the word Edge read last when it is
    // on screen (Play), else the page's first word, unless Edge's start is itself on
    // screen. Edge moves to a selection made while it plays and clears it.
    // `view` is the reader's view just before Edge's scroll; during a navigation, or
    // the paged reflow for Edge's bar, the settled page decides it instead.
    function redirectSpeechStart(resume, view = null, attempt = 0, fresh = false) {
        const highlight = speechHighlight(document);
        const paged = currentSettings.readingMode === 'paged';
        const busy = isNavigatingPage || (paged && layoutPosition);
        if (currentBookId && highlight && busy && attempt < 15) {
            setTimeout(redirectSpeechStart, 200, resume, null, attempt + 1, fresh);
            return;
        }
        // Edge's own start remains the reading position unless a word is selected below.
        speechRedirected = false;
        if (!currentBookId || !highlight || busy) return;
        view ||= {scrollY: window.scrollY, page: localPagedIndex, anchor: pdfReadingAnchor};
        let roots;
        let start = null;
        if (currentBookType === 'pdf') {
            if (pdfAnchorShift(view.anchor) === null) return;
            restorePdfReadingAnchor(view.anchor);
            roots = Array.from(bookContent.querySelectorAll(paged
                ? '.pdf-page[data-page-index="' + currentPdfPage + '"] .pdf-page-text' : ':scope > section .pdf-page-text'));
        } else if (paged) {
            const section = bookContent.querySelector(':scope > section[data-index="' + currentChapterIndex + '"]');
            if (!section) return;
            // Leave the page indicator text alone: Edge may be reading it right now.
            const left = view.page * bookViewport.clientWidth;
            if (Math.abs(bookViewport.scrollLeft - left) > 1) bookViewport.scrollTo({left, behavior: 'instant'});
            roots = [section];
            // Opening Edge's bar reflows the page, which may now begin before the text
            // the reader's page began with: start from that text.
            if (keptAnchor?.sectionIndex === currentChapterIndex) start = readerTextAnchorWord(section, keptAnchor.anchor);
        } else {
            // A pending reflow remembers the reader's text; otherwise the scroll offset does.
            const pending = layoutPosition?.bookId === currentBookId && layoutPosition.readingMode === 'scroll' ? layoutPosition : null;
            const section = pending && bookContent.querySelector(':scope > section[data-index="' + pending.chapterIndex + '"]');
            if (section && section.dataset.loaded !== 'false' && readerTextAnchorShift(section, bookViewport, false, pending.anchor) !== null) {
                restoreReaderTextAnchor(section, bookViewport, false, false, pending.anchor);
            } else window.scrollTo({top: view.scrollY, behavior: 'instant'});
            roots = Array.from(bookContent.children).filter(element => element.dataset.loaded !== 'false');
        }
        const screen = readerViewBounds(paged);
        // Scroll mode reads from the reader's reading line, as its saved positions do; a
        // jump places its target there, so reading starts at the target, not above it.
        const reading = paged ? screen : {...screen, top: Math.min(80, screen.bottom)};
        const spoken = document.createRange();
        spoken.selectNodeContents(highlight);
        const inBook = bookContent.contains(highlight);
        // A new start on the reader's page is the reader's own choice, e.g. "Read aloud" from a point.
        if (fresh && inBook && rangeWithin(spoken, reading)) return;
        const last = fresh ? null : speechPositionWord(resume);
        let word = last && wordOnScreen(last, screen) ? last : null;
        if (!word) {
            if (inBook && wordOnScreen(spoken, reading)) return;
            word = start && wordOnScreen(start, reading) ? start : firstVisibleWord(roots, reading);
        }
        if (!word) return;
        selectForSpeech(word);
        speechRedirected = true;
    }

    watchSpeechHighlight(document, (highlight, fresh) => {
        if (!currentBookId) return;
        // Ctrl+Shift+U or Play starts anywhere Edge chooses; Play after Edge paused itself
        // jumps back to its default point over the spoken text.
        if (fresh || isDefaultSpeechStart(highlight) && (!bookContent.contains(highlight) || speechRestarted(speechResume, highlight))) {
            // Runs before the scroll event of Edge's own jump: the reader's view is still known.
            if (fresh || !speechRedirected) {
                speechRedirected = true;
                redirectSpeechStart(speechResume, {scrollY: lastScrollY, page: localPagedIndex, anchor: pdfReadingAnchor}, 0, fresh);
            }
        } else {
            speechRedirected = false;
            speechResume = speechPosition(highlight);
        }
        speechInView = speechOnPage();
        const section = highlight.closest('#book-content > section');
        if (section === speechSection) return;
        speechSection = section;
        // Mount the section after the one Edge now reads, even off screen.
        if (section && currentSettings.readingMode === 'scroll') void updateScrollWindow();
    });

    async function handleRouting() {
        if (!currentUser) return;
        const path = window.location.pathname;
        const bookMatch = path.match(/^\/book\/(book_[a-zA-Z0-9_-]+)$/);
        
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

    // --- App speech: the shared controller owns utterances, not reader DOM. ---
    const ttsPlayerCard = document.getElementById('tts-player');
    const ttsPlayPauseBtn = document.getElementById('tts-play-pause');
    const ttsSpeedSelect = document.getElementById('tts-speed');
    const ttsVoiceSelect = document.getElementById('tts-voice');
    readerTts = createReaderTts({
        content: bookContent, speedSelect: ttsSpeedSelect, voiceSelect: ttsVoiceSelect,
        getRoots: ttsRoots, getStartWord: ttsStartWord,
        getContext: () => ({bookId: currentBookId, paged: currentSettings.readingMode === 'paged',
            columned: currentSettings.readingMode === 'paged' && currentBookType !== 'pdf',
            busy: isNavigatingPage || !!layoutPosition}),
        reveal: revealTtsWord, nextSection: nextTtsSection,
        onPosition: word => {
            const section = word.startContainer.parentElement.closest('#book-content > section');
            const previous = ttsPosition?.sectionIndex;
            const anchor = readerTextAnchorAt(section.querySelector('.pdf-page-text') || section,
                word.startContainer, word.startOffset, currentSettings.readingMode === 'paged');
            if (!anchor) return;
            const bounds = readerViewBounds(currentSettings.readingMode === 'paged');
            anchor.top = word.getBoundingClientRect().top - (anchor.paged ? bounds.top : 80);
            ttsPosition = {sectionIndex: Number(section.dataset.index), anchor};
            ttsInView = rangeWithin(word, bounds);
            if (previous !== ttsPosition.sectionIndex && currentSettings.readingMode === 'scroll') void updateScrollWindow();
        },
        onState: ({active, playing}) => {
            ttsPlayerCard.classList.toggle('active', active);
            ttsPlayPauseBtn.innerHTML = playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
        }
    });

    function stopTTS() {
        readerTts?.stop();
        ttsPosition = null;
        ttsInView = false;
    }

    function ttsRoots() {
        return [...bookContent.children].filter(section => section.dataset.loaded !== 'false')
            .map(section => currentBookType === 'pdf' ? section.querySelector('.pdf-page-text') : section)
            .filter(root => root && !root.querySelector('.pdf-empty-text'));
    }

    function ttsStartWord() {
        const paged = currentSettings.readingMode === 'paged';
        const roots = ttsRoots();
        const kept = paged && keptAnchor && roots.find(root => Number(root.dataset.index) === keptAnchor.sectionIndex);
        const word = kept && readerTextAnchorWord(kept, keptAnchor.anchor);
        const screen = readerViewBounds(paged);
        return word && rangeWithin(word, screen) ? word : firstVisibleWord(roots, paged ? screen : {...screen, top: 80});
    }

    function ttsColumn(word) {
        if (!word || !bookViewport.clientWidth) return null;
        return Math.max(0, Math.floor((word.getBoundingClientRect().left - bookViewport.getBoundingClientRect().left +
            bookViewport.scrollLeft) / bookViewport.clientWidth));
    }

    function ttsLinkPosition(base) {
        if (!readerTts?.range() || !ttsInView || !ttsPosition || !base) return null;
        return {...base, chapterIndex: currentBookType === 'epub' ? ttsPosition.sectionIndex : 0,
            anchor: ttsPosition.anchor, spoken: true};
    }

    function restoreTtsTextAnchor() {
        if (!readerTts?.range() || !ttsInView || !ttsPosition) return;
        const section = readerTts.section();
        restoreReaderTextAnchor(section?.querySelector('.pdf-page-text') || section, bookViewport,
            currentSettings.readingMode === 'paged', false, ttsPosition.anchor);
    }

    function revealTtsWord(word) {
        if (isNavigatingPage || layoutPosition || !word.startContainer.isConnected) return;
        const section = word.startContainer.parentElement.closest('#book-content > section');
        const paged = currentSettings.readingMode === 'paged';
        if (paged && currentBookType !== 'pdf') {
            const chapter = Number(section.dataset.index);
            const page = ttsColumn(word);
            if (chapter !== currentChapterIndex || page !== localPagedIndex ||
                Math.abs(bookViewport.scrollLeft - page * bookViewport.clientWidth) > 1) {
                currentChapterIndex = chapter;
                localPagedIndex = page;
                keptAnchor = null;
                updatePagedView();
                saveCurrentProgress();
            }
        } else {
            if (currentBookType === 'pdf' && paged) {
                const page = Number(section.dataset.pageIndex);
                if (page !== currentPdfPage) {
                    currentPdfPage = page;
                    localPagedIndex = page - 1;
                    updatePagedView();
                    saveCurrentProgress();
                }
            }
            const bounds = readerViewBounds(paged);
            const rect = word.getBoundingClientRect();
            if (!rangeWithin(word, bounds)) {
                (paged ? bookViewport : window).scrollBy({top: rect.top - (paged ? bounds.top + 20 : 80), behavior: 'instant'});
                if (paged) saveCurrentProgress();
                else syncScrollPage();
            }
        }
        loadVisibleAssets();
    }

    async function nextTtsSection(section, direction, isCurrent) {
        const index = Number(section.dataset.index) + direction;
        const length = currentBookType === 'epub' ? epubSpine.length : currentBookType === 'pdf' ? totalPdfPages : 1;
        if (index < 0 || index >= length || !isCurrent()) return null;
        const token = session;
        const location = locationVersion;
        if (currentSettings.readingMode === 'paged') {
            const moved = await navigate(() => showLocation(currentBookType === 'epub' ? index : 0,
                currentBookType === 'pdf' ? index : direction < 0 ? Number.MAX_SAFE_INTEGER : 0, null, isCurrent), {followSpeech: true});
            if (!moved || token !== session || !isCurrent()) return null;
        } else {
            const active = [...bookContent.children].find(element => element.getBoundingClientRect().bottom > 100) || section;
            if (!await hydrateScrollSection(index, active, token, location, isCurrent)) return null;
        }
        const next = bookContent.querySelector(':scope > section[data-index="' + index + '"]');
        await pdfPageStates.get(next)?.hydration;
        return token === session && isCurrent() && next?.isConnected ? next : null;
    }

    function rememberTtsView() {
        const word = readerTts?.range();
        if (!word || layoutPosition) return;
        const paged = currentSettings.readingMode === 'paged';
        const bounds = readerViewBounds(paged);
        ttsInView = rangeWithin(word, bounds);
        if (ttsInView && ttsPosition) ttsPosition.anchor.top = word.getBoundingClientRect().top - (paged ? bounds.top : 80);
    }
    window.addEventListener('scroll', rememberTtsView, {passive: true});
    bookViewport.addEventListener('scroll', rememberTtsView, {passive: true});
    document.getElementById('tts-toggle').addEventListener('click', () => readerTts.active ? stopTTS() : readerTts.start());
    ttsPlayPauseBtn.addEventListener('click', () => readerTts.togglePlayPause());
    document.getElementById('tts-prev-sentence').addEventListener('click', () => readerTts.step(-1));
    document.getElementById('tts-next-sentence').addEventListener('click', () => readerTts.step(1));
    document.getElementById('tts-close').addEventListener('click', stopTTS);

    // --- Init ---
    loadSettings();

    window.addEventListener('popstate', () => {
        handleRouting();
    });
});
