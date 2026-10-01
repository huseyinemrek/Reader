import { RESOURCE_BASE, hydrateVisibleAssets, normalizeInlineStyle } from '/reader-core/cloud-reader.js';
import { createServerBookResources } from '/reader-core/server-reader.js';
import { createUploadQueue, uploadHttp } from '/reader-core/upload-queue.js';
import { loadPdfOutline, renderPdfToc } from '/reader-core/pdf-outline.js';
import { createPdfLayoutView, createPdfPage } from '/reader-core/pdf-layout-view.js';
import { renderNativePdfBlocks } from '/reader-core/pdf-reader.js';

// --- Firebase Auth Entegrasyonu (Dinamik ve Sıfır Kod Düzenleme) ---
let auth = null;
let signInWithEmailAndPassword = null;
let createUserWithEmailAndPassword = null;
let signOut = null;
let onAuthStateChanged = null;
const PDF_PIPELINE_VERSION = 15;
let readerRuntime = { mode: 'local', pipelineVersion: PDF_PIPELINE_VERSION };

async function initFirebaseAuth() {
    const runtimeResponse = await fetch('/api/runtime-config');
    if (!runtimeResponse.ok) throw new Error('Sunucu çalışma yapılandırması okunamadı.');
    readerRuntime = await runtimeResponse.json();
    if (readerRuntime.authEnabled === false) return;
    let config = null;

    // 1. Sunucu API'sinden yapılandırmayı sorgula (.env veya ortam değişkenleri)
    try {
        const res = await fetch('/api/firebase-config');
        if (res.ok) {
            const data = await res.json();
            if (data && data.configured && data.apiKey) {
                config = data;
            }
        }
    } catch (_) {}

    // 2. Sunucu API'sinde yoksa, yerel dosya varsa oradan içe aktarmayı dene
    if (!config) {
        try {
            const fb = await import('./firebase-config.js');
            if (fb && fb.auth) {
                auth = fb.auth;
                const authModule = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js");
                signInWithEmailAndPassword = authModule.signInWithEmailAndPassword;
                createUserWithEmailAndPassword = authModule.createUserWithEmailAndPassword;
                signOut = authModule.signOut;
                onAuthStateChanged = authModule.onAuthStateChanged;
                return;
            }
        } catch (_) {}
    }

    // 3. API'den config alındıysa Firebase Web SDK'sını dinamik başlat
    if (config) {
        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js");
            const authModule = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js");
            const app = initializeApp(config);
            auth = authModule.getAuth(app);
            signInWithEmailAndPassword = authModule.signInWithEmailAndPassword;
            createUserWithEmailAndPassword = authModule.createUserWithEmailAndPassword;
            signOut = authModule.signOut;
            onAuthStateChanged = authModule.onAuthStateChanged;
        } catch (err) {
            console.warn("Firebase SDK başlatılamadı:", err.message);
        }
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initFirebaseAuth();
    // --- Initial Config & Auth State ---
    let currentUser = null;

    const authModal = document.getElementById('auth-modal');
    const authForm = document.getElementById('auth-form');
    const authEmail = document.getElementById('auth-email');
    const authPassword = document.getElementById('auth-password');
    const authSubmitBtn = document.getElementById('auth-submit-btn');
    const authError = document.getElementById('auth-error');
    const userEmailDisplay = document.getElementById('user-email-display');
    const logoutBtn = document.getElementById('logout-btn');

    async function getAuthToken() {
        if (!currentUser) return null;
        try {
            return await currentUser.getIdToken();
        } catch (_) {
            return null;
        }
    }

    async function authFetch(url, options = {}, assetToken) {
        options.signal?.throwIfAborted();
        const sameOrigin = new URL(url, location.href).origin === location.origin;
        const token = sameOrigin ? (assetToken === undefined ? await getAuthToken() : assetToken) : null;
        options.signal?.throwIfAborted();
        const headers = new Headers(options.headers || {});
        if (token) {
            headers.set('Authorization', 'Bearer ' + token);
        } else if (!sameOrigin) {
            headers.delete('Authorization');
        }
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401 && currentUser && sameOrigin) {
            if (signOut && auth) await signOut(auth);
            throw new Error('Oturum süresi doldu. Lütfen tekrar giriş yapın.');
        }
        return response;
    }

    function authenticatedAsset(url, token) {
        if (!token) return url;
        const asset = new URL(url, location.href);
        if (asset.origin !== location.origin) return url;
        const protectedEpub = /^\/api\/books\/[^/]+\/epub\//.test(asset.pathname);
        if (!protectedEpub && !(readerRuntime.mode === 'vps' && asset.pathname.startsWith('/uploads/'))) return url;
        asset.searchParams.set('token', token);
        return asset.pathname + asset.search + asset.hash;
    }

    function waitForCompute(signal, milliseconds = 3000) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const aborted = () => {
                clearTimeout(timer);
                reject(signal.reason);
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', aborted);
                resolve();
            }, milliseconds);
            signal.addEventListener('abort', aborted, { once: true });
        });
    }

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!auth || !signInWithEmailAndPassword) {
                alert('Firebase Auth yapılandırması bulunamadı.');
                return;
            }
            const email = authEmail.value.trim();
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
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (auth && signOut) {
                closeReader();
                uploadQueue.cancelOwner(currentUser?.uid);
                await signOut(auth);
            }
        });
    }

    let currentBookId = null;
    let scrollSaveTimeout = null;
    let globalLibrary = []; // API'den gelen kitapları tutar
    // Layout bundles carry text/CSS/image geometry; illustration bytes load only when visible.
    let currentBookType = null;
    let epubSpine = [];
    let currentChapterIndex = 0;
    let localPagedIndex = 0;
    let currentGlobalPage = 1;
    let totalBookPages = 0;
    let currentPdfDoc = null;
    let currentPdfLoadingTask = null;
    let currentPdfOutline = [];
    let currentPdfMetadata = null;
    let ocrPolicyChanging = false;
    let computeTrackAbort = null;
    let pdfReadingAnchor = null;
    const pdfPageStates = new Map();
    const pdfResources = {
        cMapUrl: '/node_modules/pdfjs-dist/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/node_modules/pdfjs-dist/standard_fonts/',
        wasmUrl: '/node_modules/pdfjs-dist/wasm/'
    };
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
    let bookResources = null;
    let htmlResourceUrl = null;
    let visibleAssetFrame = null;

    function loadVisibleAssets() {
        if (visibleAssetFrame) return;
        visibleAssetFrame = requestAnimationFrame(() => {
            visibleAssetFrame = null;
            if (!bookResources) return;
            const bounds = currentSettings.readingMode === 'paged'
                ? bookViewport.getBoundingClientRect()
                : { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
            hydrateVisibleAssets(bookResources, bookContent, bounds, error => {
                pagedIndicator.title = 'Görsel yüklenemedi: ' + error.message;
            });
        });
    }
    const libraryView = document.getElementById('library-view');
    const readerView = document.getElementById('reader-view');
    const libraryGrid = document.getElementById('library-grid');
    const fileInput = document.getElementById('book-upload');
    document.getElementById('reader-upload-btn').addEventListener('click', () => fileInput.click());
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const uploadOwner = () => currentUser?.uid ?? (auth ? null : 'local_user');
    const uploadQueue = createUploadQueue({
        getOwnerKey: uploadOwner,
        run: uploadBook,
        onComplete: async (_, { ownerKey }) => {
            if (uploadOwner() === ownerKey) await loadLibrary();
        }
    });
    
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
    const pdfLayoutSelect = document.getElementById('pdf-layout');
    const pdfOcrSetting = document.getElementById('pdf-ocr-setting');
    const pdfOcrMode = document.getElementById('pdf-ocr-mode');
    const pdfOcrDescription = document.getElementById('pdf-ocr-description');
    const pdfOcrCurrent = document.getElementById('pdf-ocr-current');
    const pdfOcrCurrentStatus = document.getElementById('pdf-ocr-current-status');
    const openPageJumpBtn = document.getElementById('open-page-jump');
    const pageJumpModal = document.getElementById('page-jump-modal');
    const pageJumpClose = document.getElementById('page-jump-close');
    const pageJumpInput = document.getElementById('page-jump-input');
    const pageJumpSlider = document.getElementById('page-jump-slider');
    const pageJumpSubmit = document.getElementById('page-jump-submit');
    const jumpTotalPages = document.getElementById('jump-total-pages');
    const progressBar = document.getElementById('progress-bar');
    const computePanel = document.getElementById('compute-panel');
    const computeForm = document.getElementById('compute-form');
    const computeMode = document.getElementById('compute-mode');
    const computeScope = document.getElementById('compute-scope');
    const computeRange = document.getElementById('compute-range');
    const computeFrom = document.getElementById('compute-from');
    const computeTo = document.getElementById('compute-to');
    const computeSubmit = document.getElementById('compute-submit');
    const computeStatus = document.getElementById('compute-status');
    const pdfOcrCancel = document.getElementById('pdf-ocr-cancel');
    const computeCancel = document.getElementById('compute-cancel');
    let ocrInProgress = false;

    function updateOcrCancelVisibility(active = null) {
        if (active !== null) ocrInProgress = Boolean(active);
        const hasOcr = Boolean(currentPdfMetadata?.hasOcr);
        const ocrModeOn = currentPdfMetadata?.ocrMode === 'on';
        const hasVisibleOcr = Array.from(pdfPageStates.keys()).some(section => section.dataset.textSource === 'ocr');
        const show = currentBookType === 'pdf' && (ocrInProgress || hasOcr || ocrModeOn || hasVisibleOcr);
        if (pdfOcrCancel) pdfOcrCancel.style.display = show ? 'block' : 'none';
        if (computeCancel) computeCancel.style.display = show ? 'inline-block' : 'none';
    }

    async function cancelAndClearOcr() {
        if (currentBookType !== 'pdf' || !currentBookId || ocrPolicyChanging) return;
        const token = session;
        const bookId = currentBookId;
        ocrPolicyChanging = true;
        ocrInProgress = false;
        if (pdfOcrCancel) {
            pdfOcrCancel.disabled = true;
            pdfOcrCancel.textContent = 'OCR iptal ediliyor…';
        }
        if (computeCancel) {
            computeCancel.disabled = true;
            computeCancel.textContent = 'OCR iptal ediliyor…';
        }
        pdfOcrMode.disabled = pdfOcrCurrent.disabled = computeSubmit.disabled = true;
        computeTrackAbort?.abort();
        stopTTS();
        for (const [section, state] of pdfPageStates) {
            state.abort?.abort();
            const text = section.querySelector('.pdf-page-text');
            text.style.minHeight = text.getBoundingClientRect().height + 'px';
            text.replaceChildren();
            delete section.dataset.textSource;
            state.ocrPage = null;
            pdfLayoutView.sync(section, state);
            section.querySelector('[data-pdf-ocr]')?.setAttribute('disabled', 'true');
            const status = section.querySelector('.pdf-text-status');
            if (status) status.textContent = 'OCR iptal ediliyor ve önbellek siliniyor…';
        }
        try {
            const response = await authFetch('/api/books/' + encodeURIComponent(bookId) + '/pdf/ocr', {
                method: 'DELETE', signal: sessionAbort.signal
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'OCR iptal edilemedi.');
            sessionAbort.signal.throwIfAborted();
            if (token !== session) return;
            showPdfMetadata(result);
            if (result.queue) showComputeStatus(result.queue);
            computeStatus.textContent = 'OCR işleri iptal edildi ve önbellek silindi. Sayfalar PDF’nin kendi metnine döndürüldü.';
            updateCurrentPageOcrControls({
                state: '',
                text: `Sayfa ${currentPdfPage}: OCR iptal edildi ve önbellek silindi.`
            });
            updateOcrCancelVisibility(false);
        } catch (error) {
            if (token !== session || sessionAbort.signal.aborted) return;
            computeStatus.textContent = 'İptal hatası: ' + error.message;
            if (pdfOcrDescription) pdfOcrDescription.textContent += ' İptal hatası: ' + error.message;
        } finally {
            if (token === session) {
                ocrPolicyChanging = false;
                pdfOcrMode.disabled = pdfOcrCurrent.disabled = computeSubmit.disabled = false;
                if (pdfOcrCancel) {
                    pdfOcrCancel.disabled = false;
                    pdfOcrCancel.textContent = 'OCR’yi İptal Et ve Önbelleği Sil';
                }
                if (computeCancel) {
                    computeCancel.disabled = false;
                    computeCancel.textContent = 'OCR’yi İptal Et ve Önbelleği Sil';
                }
                for (const section of pdfPageStates.keys()) void hydratePdfPage(section);
            }
        }
    }

    function showPdfMetadata(metadata) {
        currentPdfMetadata = metadata;
        pdfOcrMode.value = metadata.ocrMode;
        const detected = metadata.textLayer === 'native'
            ? 'Kitapta yerleşik PDF metni bulundu. Boş veya kısa kapak sayfaları otomatik OCR başlatmaz.'
            : 'Kitap taranmış olarak algılandı; yerleşik okunabilir metin bulunamadı.';
        pdfOcrDescription.textContent = detected + ' ' + (metadata.automaticOcr
            ? 'Ziyaret edilen sayfalarda OCR açık.'
            : 'Otomatik OCR kapalı; yalnız PDF’nin kendi metni gösterilir.');
        updateCurrentPageOcrControls();
        updateOcrCancelVisibility();
    }

    function updateCurrentPageOcrControls(state = null) {
        if (currentBookType !== 'pdf' || !pdfOcrCurrent) return;
        pdfOcrCurrent.textContent = `Geçerli sayfayı (Sayfa ${currentPdfPage}) OCR yap / yeniden üret`;
        if (!pdfOcrCurrentStatus) return;
        if (state) {
            if (['loading', 'processing', 'pending'].includes(state.state)) updateOcrCancelVisibility(true);
            pdfOcrCurrentStatus.dataset.state = state.state || '';
            pdfOcrCurrentStatus.textContent = state.text || '';
            if (state.title) pdfOcrCurrentStatus.title = state.title;
            else pdfOcrCurrentStatus.removeAttribute('title');
            return;
        }
        const section = bookContent.querySelector(`.pdf-page[data-page-index="${currentPdfPage}"]`);
        const textSource = section?.dataset.textSource;
        if (textSource) {
            pdfOcrCurrentStatus.dataset.state = 'ready';
            pdfOcrCurrentStatus.textContent = textSource === 'ocr'
                ? `Sayfa ${currentPdfPage}: OCR ile tanınan metin gösteriliyor.`
                : `Sayfa ${currentPdfPage}: PDF’nin kendi metin katmanı gösteriliyor.`;
        } else {
            pdfOcrCurrentStatus.dataset.state = '';
            pdfOcrCurrentStatus.textContent = `Sayfa ${currentPdfPage}`;
        }
    }

    pdfOcrMode.addEventListener('change', async () => {
        if (currentBookType !== 'pdf' || !currentPdfMetadata || ocrPolicyChanging) return;
        const token = session;
        const previous = currentPdfMetadata;
        const mode = pdfOcrMode.value;
        ocrPolicyChanging = true;
        pdfOcrMode.disabled = pdfOcrCurrent.disabled = computeSubmit.disabled = true;
        computeTrackAbort?.abort();
        stopTTS();
        for (const [section, state] of pdfPageStates) {
            state.abort?.abort();
            const text = section.querySelector('.pdf-page-text');
            text.style.minHeight = text.getBoundingClientRect().height + 'px';
            text.replaceChildren();
            delete section.dataset.textSource;
            state.ocrPage = null;
            pdfLayoutView.sync(section, state);
            section.querySelector('[data-pdf-ocr]')?.setAttribute('disabled', 'true');
            const status = section.querySelector('.pdf-text-status');
            if (status) status.textContent = 'OCR tercihi kaydediliyor…';
        }
        try {
            const response = await authFetch('/api/books/' + encodeURIComponent(currentBookId) + '/pdf/ocr', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode}), signal: sessionAbort.signal
            });
            const metadata = await response.json();
            if (!response.ok) throw new Error(metadata.error || 'OCR tercihi kaydedilemedi.');
            sessionAbort.signal.throwIfAborted();
            if (token !== session) return;
            showPdfMetadata(metadata);
            computeStatus.textContent = metadata.automaticOcr
                ? '' : 'Otomatik OCR kapalı. Sayfa veya kitap hazırlama işlemini açıkça başlatabilirsiniz.';
        } catch (error) {
            if (token !== session || sessionAbort.signal.aborted) return;
            showPdfMetadata(previous);
            pdfOcrDescription.textContent += ' Tercih kaydedilemedi: ' + error.message;
        } finally {
            if (token === session) {
                ocrPolicyChanging = false;
                pdfOcrMode.disabled = pdfOcrCurrent.disabled = computeSubmit.disabled = false;
                for (const section of pdfPageStates.keys()) void hydratePdfPage(section);
                if (readerRuntime.mode === 'vps' && currentPdfMetadata.automaticOcr) void trackComputeBook();
            }
        }
    });

    pdfOcrCurrent.addEventListener('click', () => {
        if (ocrPolicyChanging) return;
        const section = bookContent.querySelector('.pdf-page[data-page-index="' + currentPdfPage + '"]');
        if (section) {
            stopTTS();
            void hydratePdfPage(section, true);
            updateOcrCancelVisibility(true);
        }
    });
    pdfOcrCancel?.addEventListener('click', cancelAndClearOcr);
    computeCancel?.addEventListener('click', cancelAndClearOcr);

    function showComputeStatus(info) {
        const counts = info.counts;
        if (counts.pending > 0 || counts.processing > 0 || counts.completed > 0) updateOcrCancelVisibility(true);
        computeStatus.textContent = `${counts.completed} / ${info.totalPages} sayfa hazır · ` +
            `${counts.pending} bekliyor · ${counts.processing} işleniyor · ${counts.failed} hata. ` +
            (info.mode === 'compute'
                ? 'Evde GPU worker’ını başlatın; hazır sayfalar burada otomatik görünür.'
                : 'VPS OCR arka planda çalışır; kaynak PDF’yi beklemeden okuyabilirsiniz.');
        const failure = info.jobs.find(job => job.status === 'failed' && job.error);
        if (failure) computeStatus.textContent += ` Sayfa ${failure.page}: ${failure.error}`;
    }

    async function trackComputeBook(initialize = false) {
        computeTrackAbort?.abort();
        const controller = new AbortController();
        computeTrackAbort = controller;
        const token = session;
        const bookId = currentBookId;
        const signal = controller.signal;
        let initial = initialize;
        try {
            while (token === session && currentBookType === 'pdf') {
                const response = await authFetch('/api/books/' + encodeURIComponent(bookId) + '/compute', { signal });
                const info = await response.json();
                if (!response.ok) throw new Error(info.error || 'OCR kuyruğu okunamadı.');
                signal.throwIfAborted();
                if (token !== session) return;
                if (initial) {
                    computeMode.value = info.mode;
                    initial = false;
                }
                showComputeStatus(info);
                if (!info.counts.pending && !info.counts.processing) return;
                await waitForCompute(signal);
            }
        } catch (error) {
            if (!signal.aborted && token === session) computeStatus.textContent = error.message;
        }
    }

    computeScope.addEventListener('change', () => { computeRange.hidden = computeScope.value !== 'range'; });
    computeMode.addEventListener('change', () => {
        if (computeMode.value === 'compute') {
            computeScope.value = 'all';
            computeRange.hidden = true;
        }
    });
    computeForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (currentBookType !== 'pdf' || readerRuntime.mode !== 'vps' || ocrPolicyChanging || computeSubmit.disabled) return;
        const token = session;
        const signal = sessionAbort.signal;
        const body = { mode: computeMode.value };
        if (computeScope.value === 'range') {
            body.fromPage = Number(computeFrom.value);
            body.toPage = Number(computeTo.value);
            if (!Number.isSafeInteger(body.fromPage) || !Number.isSafeInteger(body.toPage) ||
                body.fromPage < 1 || body.toPage < body.fromPage || body.toPage > totalPdfPages) {
                computeStatus.textContent = `1–${totalPdfPages} arasında geçerli bir sayfa aralığı seçin.`;
                return;
            }
        } else if (computeScope.value === 'current') {
            body.fromPage = body.toPage = currentPdfPage;
        }
        computeSubmit.disabled = pdfOcrMode.disabled = true;
        try {
            const response = await authFetch('/api/books/' + encodeURIComponent(currentBookId) + '/compute', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
            });
            const info = await response.json();
            if (!response.ok) throw new Error(info.error || 'OCR işleri kuyruğa eklenemedi.');
            signal.throwIfAborted();
            if (token !== session) return;
            showPdfMetadata(info);
            showComputeStatus(info);
            updateOcrCancelVisibility(true);
            for (const section of pdfPageStates.keys()) {
                const page = Number(section.dataset.pageIndex);
                if ((body.fromPage && page < body.fromPage) || (body.toPage && page > body.toPage)) continue;
                const job = info.jobs.find(item => item.page === page);
                if (job) void hydratePdfPage(section, false, job.id);
            }
            void trackComputeBook();
        } catch (error) {
            if (!signal.aborted && token === session) computeStatus.textContent = error.message;
        } finally {
            if (token === session) computeSubmit.disabled = pdfOcrMode.disabled = false;
        }
    });
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
        onNavigate: page => goToPage(page),
        onSettingsChange: () => localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings)),
        onInteraction: ({ type }) => {
            if (['drag-end', 'keyboard', 'zoom'].includes(type)) {
                pdfReadingAnchor = capturePdfReadingAnchor();
                if (currentBookId) saveCurrentProgress();
            }
        }
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
        const anchor = currentBookType === 'pdf' ? capturePdfReadingAnchor() : null;
        localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings));
        applySettings();
        if (currentBookType === 'pdf') restorePdfReadingAnchor(anchor);
        else scheduleRepagination();
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
    pdfLayoutSelect.addEventListener('change', () => {
        currentSettings.pdfLayout = pdfLayoutSelect.value;
        saveSettings();
        saveCurrentProgress();
    });

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
        const pdfAnchor = currentBookType === 'pdf' ? capturePdfReadingAnchor() : null;
        currentSettings.readingMode = mode;
        localStorage.setItem('edgeReaderSettings', JSON.stringify(currentSettings));
        applySettings();
        updateUI();
        if (!currentBookId) return;
        if (currentBookType === 'pdf') {
            if (pdfAnchor?.section) currentPdfPage = currentGlobalPage = Number(pdfAnchor.section.dataset.pageIndex);
            localPagedIndex = currentPdfPage - 1;
            updatePagedView();
            pdfLayoutView.apply();
            if (mode === 'paged') window.scrollTo({top: 0, behavior: 'instant'});
            restorePdfReadingAnchor(pdfAnchor);
            saveCurrentProgress();
            if (mode === 'scroll') void updateScrollWindow();
            return;
        }
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
        const ownerKey = uploadOwner();
        libraryGrid.innerHTML = '';
        try {
            await progressWrite;
            if (uploadOwner() !== ownerKey) return;
            const res = await authFetch('/api/books');
            const books = await res.json();
            const assetToken = await getAuthToken();
            if (uploadOwner() !== ownerKey) return;
            globalLibrary = books;
            
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
                    coverHtml = `<div class="book-cover" style="background-image: url('${authenticatedAsset(bookData.coverUrl, assetToken)}')"></div>`;
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
            await authFetch(`/api/books/${id}`, { method: 'DELETE' });
            loadLibrary();
        }
    };

    deleteBookBtn.addEventListener('click', async () => {
        if(currentBookId && confirm("Şu an okuduğunuz kitabı silmek istediğinize emin misiniz?")) {
            await authFetch(`/api/books/${currentBookId}`, { method: 'DELETE' });
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
        disposePdfPages();
        computeTrackAbort?.abort();
        pdfLayoutView.reset();
        computePanel.hidden = true;
        computePanel.open = false;
        pdfOcrSetting.hidden = originalPdfSetting.hidden = true;
        pdfOcrMode.disabled = pdfOcrCurrent.disabled = false;
        currentPdfMetadata = null;
        ocrPolicyChanging = false;
        pdfReadingAnchor = null;
        computeSubmit.disabled = false;
        computeStatus.textContent = '';
        ocrInProgress = false;
        updateOcrCancelVisibility(false);
        if (currentPdfLoadingTask) currentPdfLoadingTask.destroy().catch(error => console.error('PDF kapatılamadı:', error));
        currentPdfLoadingTask = null;
        currentPdfDoc = null;
        currentPdfOutline = [];
        currentBookId = null;
        currentBookType = null;
        epubSpine = [];
        bookResources?.dispose();
        bookResources = null;
        htmlResourceUrl = null;
        if (visibleAssetFrame) cancelAnimationFrame(visibleAssetFrame);
        visibleAssetFrame = null;
        htmlSource = '';
        bookContent.replaceChildren();
        bookContent.classList.remove('pdf-content');
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
        libraryView.style.display = 'block';
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
        return JSON.stringify([5, innerWidth, innerHeight, devicePixelRatio,
            s.fontSize, s.fontFamily, s.lineHeight, s.maxWidth, s.sidePadding, s.paragraphSpacing,
            bookResources?.sourceVersion]);
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
            updateCurrentPageOcrControls();
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
        pagedPageText.textContent = isNavigatingPage && currentBookType === 'pdf'
            ? 'PDF sayfası hazırlanıyor…'
            : ready ? 'Sayfa ' + currentGlobalPage + ' / ' + totalBookPages + (missing ? ' · eksik EPUB' : '') : 'Sayfalar hesaplanıyor…';
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
        const sectionIndex = currentBookType === 'pdf' ? currentPdfPage - 1 : currentChapterIndex;
        const section = bookContent.querySelector(':scope > section[data-index="' + sectionIndex + '"]');
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
        progressWrite = progressWrite.then(async () => {
            const response = await authFetch('/api/books/' + id + '/progress', {
                method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data), keepalive: true
            });
            if (!response.ok) throw new Error('Okuma konumu kaydedilemedi.');
        }).catch(error => console.error(error));
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
        if (bookResources) await bookResources.layoutReady;
        signal.throwIfAborted();
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
                        ? await loadEpubChapter(index, doc, signal) : await makeHtmlSection(doc);
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
            section = createPdfPageSection(localPage + 1);
        } else section = await makeHtmlSection(document);
        if (token !== session || location !== locationVersion) return;
        stopTTS();
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
        if (type === 'pdf') pdfReadingAnchor = capturePdfReadingAnchor();
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
        if (pdfLayoutView.isDragging || !Number.isSafeInteger(page) || page < 1 || page > totalBookPages) return;
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
        if (scrollWindowBusy || isNavigatingPage || pdfLayoutView.isDragging || currentSettings.readingMode !== 'scroll' || !['epub', 'pdf'].includes(currentBookType)) return;
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
                    else fresh = createPdfPageSection(i + 1);
                    if (token !== session || location !== locationVersion || currentSettings.readingMode !== 'scroll') return;
                    const anchor = active.getBoundingClientRect().top;
                    if (section) disposePdfPage(section);
                    if (section) section.replaceWith(fresh);
                    else {
                        const after = Array.from(bookContent.children).find(el => Number(el.dataset.index) > i);
                        bookContent.insertBefore(fresh, after || null);
                    }
                    section = fresh;
                    if (!isEpub) mountPdfPage(section);
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
                disposePdfPage(element);
                element.replaceChildren();
                element.style.height = height + 'px';
                element.dataset.loaded = 'false';
            }
            const current = bookContent.querySelector(':scope > section[data-index="' + index + '"]');
            const ratio = Math.max(0, Math.min(0.999999, (80 - current.getBoundingClientRect().top) / Math.max(1, current.offsetHeight)));
            localPagedIndex = isEpub ? Math.floor(ratio * (epubSpine[index].pageCount || 1)) : index;
            updatePagedIndicator();
            saveCurrentProgress();
            loadVisibleAssets();
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
    bookViewport.addEventListener('click', event => {
        if (pdfLayoutView.isDragging || currentSettings.readingMode !== 'paged' ||
            event.target.closest('a,button,input,select,[role="separator"],.pdf-page-image-column') || window.getSelection().toString()) return;
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
        if (!currentBookId || pdfLayoutView.isDragging || pageJumpModal.open ||
            event.target.closest('input,textarea,select,[contenteditable="true"],[role="separator"]')) return;
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
            return;
        }
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
                resourceBase = RESOURCE_BASE;
                bookResources = await createServerBookResources(book, {
                    signal: sessionAbort.signal, request: authFetch,
                    assetUrl: async url => authenticatedAsset(url, await getAuthToken())
                });
                await loadEpubSpine();
            } else if (fileName.endsWith('.pdf')) {
                currentBookType = 'pdf';
                const authToken = await getAuthToken();
                const httpHeaders = authToken ? { Authorization: 'Bearer ' + authToken } : {};
                const loadingTask = pdfjsLib.getDocument({...pdfResources, url: book.bookUrl, httpHeaders, disableAutoFetch: true, disableStream: true});
                currentPdfLoadingTask = loadingTask;
                const pdf = await loadingTask.promise;
                if (token !== session) return;
                currentPdfDoc = pdf;
                totalBookPages = totalPdfPages = pdf.numPages;
                currentPdfOutline = await loadPdfOutline(pdf, sessionAbort.signal);
                if (token !== session) return;
                const metadataResponse = await authFetch('/api/books/' + encodeURIComponent(id) + '/pdf', {signal: sessionAbort.signal});
                const metadata = await metadataResponse.json();
                if (!metadataResponse.ok) throw new Error(metadata.error || 'PDF metin türü belirlenemedi.');
                sessionAbort.signal.throwIfAborted();
                if (token !== session) return;
                showPdfMetadata(metadata);
                pdfOcrSetting.hidden = false;
                if (readerRuntime.mode === 'vps') {
                    computePanel.hidden = false;
                    computeScope.value = 'all';
                    computeRange.hidden = true;
                    computeFrom.max = computeTo.max = totalPdfPages;
                    computeFrom.value = '1';
                    computeTo.value = String(totalPdfPages);
                    void trackComputeBook(true);
                }
            } else {
                currentBookType = 'html';
                if (/\.(htmlz|zip)$/.test(fileName)) {
                    resourceBase = RESOURCE_BASE;
                    bookResources = await createServerBookResources(book, {
                        signal: sessionAbort.signal, request: authFetch,
                        assetUrl: async url => authenticatedAsset(url, await getAuthToken())
                    });
                    const main = (await bookResources.names()).find(name => /\.html?$/i.test(name));
                    if (!main) throw new Error('Arşivde HTML bulunamadı.');
                    htmlResourceUrl = new URL(main.split('/').map(encodeURIComponent).join('/'), RESOURCE_BASE).href;
                    htmlSource = await bookResources.text(htmlResourceUrl);
                } else {
                    const response = await authFetch(book.bookUrl, { signal: sessionAbort.signal });
                    if (!response.ok) throw new Error('Kitap dosyası alınamadı.');
                    htmlSource = extractBodyContent(await response.text());
                }
            }
            if (token !== session) return;
            if (originalPdfSetting) originalPdfSetting.hidden = currentBookType !== 'pdf';
            if (currentBookType === 'pdf' && openOriginalPdf) {
                openOriginalPdf.href = authenticatedAsset(book.bookUrl, await getAuthToken());
            }
            libraryView.classList.remove('active');
            libraryView.style.display = 'none';
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
                if (currentBookType !== 'pdf' && saved && saved.layoutKey !== layoutKey && !params.has('local')) {
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
        if (currentBookType === 'pdf') {
            renderPdfToc(currentPdfOutline, tocList, {
                bookId: currentBookId,
                onNavigate: async page => { closeSidebar(tocSidebar); await goToPage(page); }
            });
            if (!tocList.children.length) tocList.textContent = 'PDF’de yer işareti/içindekiler kaydı bulunamadı.';
            return;
        }
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

    fileInput.addEventListener('change', event => {
        const files = [...event.target.files];
        fileInput.value = '';
        const ownerKey = uploadOwner();
        if (files.length && ownerKey) uploadQueue.add(files, ownerKey);
    });

    async function uploadBook(file, { report, signal, ownerKey, throwIfCancelled }) {
        report({ stage: 'preparing', detail: 'Kitap bilgileri hazırlanıyor' });
        const fileName = file.name.toLowerCase();
        let title = file.name.replace(/\.[^/.]+$/, '');
        let coverBlob = null;
        let toc = [];
        if (fileName.endsWith('.epub')) {
            const zip = await JSZip.loadAsync(await file.arrayBuffer());
            throwIfCancelled();
            const meta = await extractEpubMeta(zip);
            if (meta.title) title = meta.title;
            coverBlob = meta.coverBlob;
            toc = meta.toc;
        } else if (fileName.endsWith('.pdf')) {
            const loadingTask = pdfjsLib.getDocument({ ...pdfResources, data: await file.arrayBuffer() });
            const abort = () => { void loadingTask.destroy(); };
            signal.addEventListener('abort', abort, { once: true });
            try {
                throwIfCancelled();
                const pdf = await loadingTask.promise;
                const metadata = await pdf.getMetadata();
                if (metadata.info?.Title) title = metadata.info.Title;
            } finally {
                signal.removeEventListener('abort', abort);
                await loadingTask.destroy();
            }
        }
        throwIfCancelled();
        report({ stage: 'preparing', name: title, detail: 'Sunucuya aktarım hazırlanıyor' });
        const user = currentUser;
        if (user && user.uid !== ownerKey) throw new DOMException('Oturum değişti', 'AbortError');
        const token = user ? await user.getIdToken() : null;
        throwIfCancelled();
        const formData = new FormData();
        formData.append('bookFile', file);
        formData.append('fileName', fileName);
        formData.append('title', title);
        formData.append('toc', JSON.stringify(toc));
        if (coverBlob) formData.append('coverBlob', coverBlob, 'cover.jpg');
        const book = await uploadHttp('/api/books', formData, {
            token, signal,
            onProgress: progress => report({ ...progress, detail: 'Kitap sunucuya aktarılıyor' })
        });
        throwIfCancelled();
        return book;
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

    async function fetchText(url, signal = sessionAbort.signal, assetToken) {
        if (bookResources) {
            try { return await bookResources.text(url, signal); }
            catch (error) { error.url = url; throw error; }
        }
        const response = await authFetch(url, {signal}, assetToken);
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


    async function loadEpubChapter(index, targetDocument = document, signal = sessionAbort.signal) {
        const chapter = epubSpine[index];
        if (!chapter) throw new Error('Bölüm bulunamadı.');
        const resources = bookResources;
        const html = await fetchText(chapter.url, signal);
        signal.throwIfAborted();
        const section = await resources.section(html, chapter.url, targetDocument, index, chapter.id);
        signal.throwIfAborted();
        return section;
    }



    async function makeHtmlSection(doc) {
        if (bookResources) return bookResources.section(htmlSource, htmlResourceUrl, doc);
        const section = doc.createElement('section');
        section.className = 'epub-chapter';
        section.dataset.index = '0';
        section.innerHTML = htmlSource;
        for (const element of section.querySelectorAll('[style]')) normalizeInlineStyle(element.style);
        return section;
    }

    bookContent.addEventListener('click', async event => {
        const math = event.target.closest('[data-latex]');
        if (math) {
            event.stopPropagation();
            try {
                await navigator.clipboard.writeText(math.dataset.latex);
                math.title = 'LaTeX kopyalandı';
            } catch (error) {
                alert('Denklem kopyalanamadı: ' + error.message);
            }
            return;
        }
        const ocrButton = event.target.closest('[data-pdf-ocr]');
        if (ocrButton && currentBookType === 'pdf' && !ocrPolicyChanging) {
            const section = ocrButton.closest('.pdf-page');
            stopTTS();
            await hydratePdfPage(section, true);
            return;
        }
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

    bookContent.addEventListener('keydown', event => {
        const math = event.target.closest('[data-latex]');
        if (math && ['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            math.click();
        }
    });

    bookContent.addEventListener('copy', event => {
        if (currentBookType !== 'pdf') return;
        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;
        const parent = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        const startMath = parent(selection.anchorNode)?.closest('[data-latex]');
        const endMath = parent(selection.focusNode)?.closest('[data-latex]');
        if (startMath && startMath === endMath) {
            event.clipboardData.setData('text/plain', startMath.dataset.latex);
            event.preventDefault();
            return;
        }
        const fragment = selection.getRangeAt(0).cloneContents();
        const formulas = fragment.querySelectorAll('[data-latex]');
        if (!formulas.length) return;
        for (const formula of formulas) {
            const delimiter = formula.dataset.display === 'true' ? '$$' : '$';
            formula.replaceWith(document.createTextNode(delimiter + formula.dataset.latex + delimiter));
        }
        for (const block of fragment.querySelectorAll('p, .pdf-equation')) block.append('\n\n');
        event.clipboardData.setData('text/plain', fragment.textContent);
        event.preventDefault();
    });

    function makePdfMath(latex, display = false, fontScale = 1) {
        const math = document.createElement('span');
        math.className = 'pdf-math';
        math.style.fontSize = fontScale + 'em';
        math.dataset.latex = latex;
        math.dataset.display = String(display);
        math.tabIndex = 0;
        math.setAttribute('role', 'button');
        math.setAttribute('aria-label', 'Denklemi LaTeX olarak kopyala: ' + latex);
        math.title = 'LaTeX kopyalamak için tıklayın';
        math.innerHTML = katex.renderToString(latex, {
            displayMode: display, output: 'htmlAndMathml', throwOnError: true, trust: false
        });
        return math;
    }

    function capturePdfReadingAnchor() {
        if (currentBookType !== 'pdf') return null;
        const paged = currentSettings.readingMode === 'paged';
        const line = paged ? bookViewport.getBoundingClientRect().top + 20 : 100;
        const section = paged
            ? bookContent.querySelector('.pdf-page[data-page-index="' + currentPdfPage + '"]')
            : Array.from(bookContent.children).find(element => element.getBoundingClientRect().bottom > line);
        if (!section || section.dataset.loaded !== 'true') return null;
        const blocks = Array.from(section.querySelector('.pdf-page-text')?.children || []);
        const node = blocks.find(element => element.getBoundingClientRect().bottom > line) || section;
        const rect = node.getBoundingClientRect();
        const point = Math.max(line, rect.top);
        return {section, node, index: blocks.indexOf(node), point,
            fraction: Math.max(0, Math.min(1, (point - rect.top) / Math.max(1, rect.height)))};
    }

    function restorePdfReadingAnchor(anchor) {
        if (!anchor?.section.isConnected) return;
        const node = anchor.node.isConnected ? anchor.node
            : anchor.section.querySelector('.pdf-page-text')?.children[anchor.index] || anchor.section;
        const rect = node.getBoundingClientRect();
        const delta = rect.top + anchor.fraction * rect.height - anchor.point;
        if (currentSettings.readingMode === 'paged') bookViewport.scrollBy({top: delta, behavior: 'instant'});
        else window.scrollBy({top: delta, behavior: 'instant'});
        pdfReadingAnchor = capturePdfReadingAnchor();
    }

    const rememberPdfReadingAnchor = () => {
        if (currentBookType === 'pdf' && !pdfLayoutView.isDragging) pdfReadingAnchor = capturePdfReadingAnchor();
    };
    window.addEventListener('scroll', rememberPdfReadingAnchor, {passive: true});
    bookViewport.addEventListener('scroll', rememberPdfReadingAnchor, {passive: true});

    function disposePdfPage(section) {
        const state = pdfPageStates.get(section);
        if (!state) return;
        state.abort?.abort();
        pdfLayoutView.dispose(section, state);
        pdfPageStates.delete(section);
    }

    function disposePdfPages() {
        for (const section of pdfPageStates.keys()) disposePdfPage(section);
    }

    function mountPdfPage(section) {
        pdfPageStates.set(section, {viewer: null, abort: null});
        pdfLayoutView.apply();
        void hydratePdfPage(section);
    }

    async function hydratePdfPage(section, forceOcr = false, explicitJob = null) {
        const state = pdfPageStates.get(section);
        if (!state || !section.isConnected || !currentPdfMetadata || ocrPolicyChanging) return;
        state.abort?.abort();
        const controller = new AbortController();
        state.abort = controller;
        const signal = controller.signal;
        const pageNumber = Number(section.dataset.pageIndex);
        const status = section.querySelector('.pdf-text-status');
        const text = section.querySelector('.pdf-page-text');
        const button = section.querySelector('[data-pdf-ocr]');
        const token = session;
        const bookId = currentBookId;
        const isCurrent = () => Number(section.dataset.pageIndex) === currentPdfPage;
        if (button) {
            button.disabled = true;
            button.textContent = forceOcr ? 'OCR yeniden üretiliyor…' : 'Metin hazırlanıyor…';
        }
        if (status) {
            status.dataset.state = 'loading';
            status.removeAttribute('title');
        }
        const wantsOcr = forceOcr || explicitJob || currentPdfMetadata.automaticOcr;
        const loadingMessage = wantsOcr
            ? readerRuntime.mode === 'vps'
                ? 'OCR metni hazırlanıyor; arka plan kuyruğu ve kaynak PDF birbirinden bağımsızdır.'
                : 'Yerel OCR metni hazırlanıyor; ilk kullanımda model yüklenebilir.'
            : 'PDF’nin kendi metin katmanı okunuyor · OCR çalıştırılmıyor.';
        if (status) status.textContent = loadingMessage;
        if (isCurrent()) {
            pdfOcrCurrent.disabled = true;
            pdfOcrCurrent.textContent = forceOcr ? `Sayfa ${pageNumber} OCR yeniden üretiliyor…` : `Sayfa ${pageNumber} metni hazırlanıyor…`;
            if (pdfOcrCurrentStatus) {
                pdfOcrCurrentStatus.dataset.state = 'loading';
                pdfOcrCurrentStatus.removeAttribute('title');
                pdfOcrCurrentStatus.textContent = `Sayfa ${pageNumber}: ${loadingMessage}`;
            }
        }
        text.setAttribute('aria-busy', 'true');
        try {
            const pageUrl = '/api/books/' + encodeURIComponent(bookId) + '/pdf/pages/' + pageNumber;
            let result;
            let regenerate = forceOcr;
            let jobId = explicitJob;
            while (true) {
                const query = regenerate ? '?ocr=1' : jobId ? '?ocrJob=' + encodeURIComponent(jobId)
                    : currentPdfMetadata.automaticOcr ? '' : '?ocr=0';
                const response = await authFetch(pageUrl + query, {signal});
                regenerate = false;
                result = await response.json();
                if (!response.ok) throw new Error(result.error || 'PDF metni hazırlanamadı.');
                signal.throwIfAborted();
                if (response.status !== 202) break;
                if (result.status === 'failed') throw new Error(result.error || 'Arka plan OCR işi başarısız oldu.');
                if (!['pending', 'processing'].includes(result.status)) throw new Error('Geçersiz OCR kuyruk durumu.');
                if (!result.jobId) throw new Error('OCR kuyruğu iş kimliği döndürmedi.');
                jobId = result.jobId;
                const pollState = result.status;
                const pollText = (result.status === 'processing' ? 'OCR işleniyor' : 'OCR kuyrukta bekliyor') +
                    (result.mode === 'compute' ? ' · Evde GPU worker’ını başlatın.' : ' · VPS arka planda çalışıyor.') +
                    ' Kaynak PDF kullanılabilir; metin hazır olduğunda otomatik görünür.';
                updateOcrCancelVisibility(true);
                if (status) {
                    status.dataset.state = pollState;
                    status.textContent = pollText;
                }
                if (button) button.textContent = result.status === 'processing' ? 'OCR işleniyor…' : 'OCR kuyrukta…';
                if (isCurrent()) {
                    pdfOcrCurrent.textContent = result.status === 'processing' ? `Sayfa ${pageNumber} OCR işleniyor…` : `Sayfa ${pageNumber} OCR kuyrukta…`;
                    if (pdfOcrCurrentStatus) {
                        pdfOcrCurrentStatus.dataset.state = pollState;
                        pdfOcrCurrentStatus.textContent = `Sayfa ${pageNumber}: ${pollText}`;
                    }
                }
                await waitForCompute(signal);
            }
            signal.throwIfAborted();
            if (token !== session || pdfPageStates.get(section) !== state || !section.isConnected) return;
            if (result.pipelineVersion !== PDF_PIPELINE_VERSION) {
                text.replaceChildren();
                delete section.dataset.textSource;
                state.ocrPage = null;
                pdfLayoutView.sync(section, state);
                throw new Error(`Uyumsuz sunucu yanıtı (beklenen belge hattı: ${PDF_PIPELINE_VERSION}). Sunucuyu yeniden başlatın, ardından OCR sonucunu yeniden üretin.`);
            }
            const qualityLimits = result.qualityLimits ?? [];
            if (!Array.isArray(qualityLimits) || qualityLimits.some(limit => typeof limit !== 'string' || !limit.trim())) {
                throw new Error('Belge OCR kaynak doğruluğu uyarıları geçersiz.');
            }
            const content = makePdfPageText(result, await getAuthToken());
            signal.throwIfAborted();
            const anchor = capturePdfReadingAnchor();
            text.replaceChildren(...content.childNodes);
            text.style.removeProperty('min-height');
            text.setAttribute('aria-label', result.source === 'ocr' ? 'OCR ile tanınan metin' : 'PDF’nin kendi metin katmanı');
            section.dataset.textSource = result.source;
            state.ocrPage = result.source === 'ocr' ? result : null;
            if (result.source === 'ocr') updateOcrCancelVisibility(true);
            pdfLayoutView.sync(section, state);
            const stateKind = qualityLimits.length ? 'warning' : 'ready';
            const metadata = [result.engine, result.device,
                result.modelRevision ? 'Model: ' + result.modelRevision.split(':').map(revision => revision.slice(0, 8)).join(':') : null,
                Number.isFinite(result.elapsedMs) ? (result.elapsedMs / 1000).toFixed(1) + ' sn' : null].filter(Boolean);
            const statusTitle = [result.engine, result.device, result.modelRevision, ...qualityLimits].filter(Boolean).join('\n');
            const nativeText = result.source === 'native'
                ? (result.text ?? result.blocks.map(block => block.text || '').join(' ')).trim() : '';
            const statusSummary = (result.source === 'ocr'
                ? readerRuntime.mode === 'vps' ? 'OCR ile tanınan metin · VPS önbelleği' : 'Yerel OCR ile tanınan metin'
                : !nativeText ? 'PDF’nin kendi metin katmanı · Bu sayfada metin yok; otomatik OCR başlatılmadı.'
                    : nativeText.length < 100 ? 'PDF’nin kendi metin katmanı · Bu sayfada kısa metin var; otomatik OCR başlatılmadı.'
                        : 'PDF’nin kendi metin katmanı') +
                (metadata.length ? ' · ' + metadata.join(' · ') : '') +
                (qualityLimits.length ? ` · ${qualityLimits.length} bölgede matematik eşleşmesi belirsiz; kaynakla karşılaştırın.` :
                    result.source === 'ocr' ? ' · Tanıma hataları olabilir; kaynakla karşılaştırın.' : '');
            if (status) {
                status.dataset.state = stateKind;
                status.title = statusTitle;
                status.textContent = statusSummary;
            }
            if (isCurrent()) {
                pdfOcrCurrent.disabled = false;
                updateCurrentPageOcrControls({
                    state: stateKind,
                    text: `Sayfa ${pageNumber}: ${statusSummary}`,
                    title: statusTitle
                });
            }
            if (!isNavigatingPage && !pdfLayoutView.isDragging) restorePdfReadingAnchor(anchor);
        } catch (error) {
            if (signal.aborted || token !== session || !section.isConnected) return;
            console.error('PDF metni hazırlanamadı:', error);
            if (status) {
                status.dataset.state = 'error';
                status.textContent = 'Metin hazırlanamadı: ' + error.message + ' · OCR düğmesiyle yeniden deneyebilirsiniz.';
            }
            if (isCurrent() && pdfOcrCurrentStatus) {
                pdfOcrCurrentStatus.dataset.state = 'error';
                pdfOcrCurrentStatus.textContent = `Sayfa ${pageNumber} metni hazırlanamadı: ${error.message} · Ayarlar altındaki düğmeyle yeniden deneyebilirsiniz.`;
            }
        } finally {
            if (state.abort === controller && !ocrPolicyChanging && section.isConnected && pdfPageStates.get(section) === state) {
                text.setAttribute('aria-busy', 'false');
                if (button) {
                    button.disabled = false;
                    button.textContent = 'Bu sayfayı OCR yap / yeniden üret';
                }
                if (isCurrent()) {
                    pdfOcrCurrent.disabled = false;
                    pdfOcrCurrent.textContent = `Geçerli sayfayı (Sayfa ${currentPdfPage}) OCR yap / yeniden üret`;
                }
            }
        }
    }

    function createPdfPageSection(pageNumber) {
        return createPdfPage(pageNumber);
    }

    function makePdfPageText(result, assetToken) {
        const text = result.source === 'native'
            ? renderNativePdfBlocks(result.blocks, document, {
                onNavigate: page => goToPage(page),
                assetUrl: url => authenticatedAsset(url, assetToken)
            }) : document.createElement('div');
        if (result.source !== 'native') for (const block of result.blocks) {
            if (block.type === 'image') {
                const figure = document.createElement('figure');
                figure.className = 'pdf-figure';
                const graphic = document.createElement('img');
                graphic.src = authenticatedAsset(block.imageUrl, assetToken);
                graphic.width = block.width;
                graphic.height = block.height;
                graphic.alt = block.alt;
                figure.appendChild(graphic);
                text.appendChild(figure);
                continue;
            }
            if (block.type === 'math') {
                const equation = document.createElement('div');
                equation.className = 'pdf-equation';
                equation.appendChild(makePdfMath(block.latex, true));
                if (block.label) {
                    const label = document.createElement('span');
                    label.className = 'pdf-equation-number';
                    label.textContent = block.label;
                    equation.appendChild(label);
                }
                text.appendChild(equation);
                continue;
            }
            const p = document.createElement('p');
            p.className = 'pdf-text-block';
            if (block.indented) p.classList.add('pdf-text-indented');
            if (block.preserveWhitespace) p.dataset.preserveWhitespace = 'true';
            p.dataset.ttsText = block.text;
            for (const run of block.runs) {
                if (run.type === 'math') {
                    p.appendChild(makePdfMath(run.latex, false, run.fontScale));
                    continue;
                }
                const span = document.createElement('span');
                span.style.fontSize = run.fontScale + 'em';
                span.textContent = run.text;
                p.appendChild(span);
            }
            text.appendChild(p);
        }
        if (!text.children.length) {
            const notice = document.createElement('div');
            notice.className = 'pdf-empty-text';
            notice.textContent = result.source === 'native'
                ? 'Bu sayfanın yerleşik PDF metni boş. Kapak veya görsel sayfası olabilir. OCR gerekiyorsa “Bu sayfayı OCR yap” düğmesini kullanın.'
                : 'OCR bu sayfada okunabilir metin bulamadı. Kaynak PDF’yi inceleyebilir veya sayfayı yeniden OCR yapabilirsiniz.';
            text.appendChild(notice);
        }
        return text;
    }
    async function handleRouting() {
        if (auth && !currentUser) return;
        const path = window.location.pathname;
        const bookMatch = path.match(/^\/book\/(book_[a-zA-Z0-9_]+)$/);
        
        if (bookMatch) {
            const bookId = bookMatch[1];
            if (globalLibrary.length === 0) {
                try {
                    const res = await authFetch('/api/books');
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
            
            const text = (p.dataset.ttsText ?? p.innerText).trim();
            if (!text) return;
            
            p.classList.add('tts-sentence');
            p.dataset.index = sentenceIndex;
            
            p.onclick = (e) => {
                if (e.target.closest('[data-latex]')) return;
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
        if (!ttsSentences.length && currentBookType === 'pdf') {
            ttsActive = false;
            alert('Bu sayfanın metni henüz hazır değil. OCR tamamlandığında sesli okumayı başlatabilirsiniz.');
            return;
        }
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

    // --- Init & Auth Observer ---
    loadSettings();

    if (auth && onAuthStateChanged) {
        onAuthStateChanged(auth, async (user) => {
            if (currentUser && currentUser.uid !== user?.uid) uploadQueue.cancelOwner(currentUser.uid);
            if (user) {
                currentUser = user;
                if (authModal) authModal.style.display = 'none';
                if (userEmailDisplay) {
                    userEmailDisplay.innerText = user.email || 'Kullanıcı';
                    userEmailDisplay.style.display = 'inline-block';
                }
                if (logoutBtn) logoutBtn.style.display = 'inline-flex';
                libraryView.style.display = 'block';
                await loadLibrary();
                handleRouting();
            } else {
                currentUser = null;
                closeReader();
                if (authModal) authModal.style.display = 'flex';
                if (userEmailDisplay) userEmailDisplay.style.display = 'none';
                if (logoutBtn) logoutBtn.style.display = 'none';
                libraryView.style.display = 'none';
                readerView.style.display = 'none';
                globalLibrary = [];
            }
        });
    } else {
        libraryView.style.display = 'block';
        loadLibrary();
        handleRouting();
    }

    window.addEventListener('popstate', () => {
        if (auth && !currentUser) return;
        handleRouting();
    });
});
