# 📖 Reader

Modern, hızlı ve tarayıcı tabanlı EPUB, PDF ve HTML kitap okuyucu. Özellikle **Microsoft Edge "Sesli Oku" (Read Aloud)** ve dahili Text-to-Speech (TTS) motorlarıyla kusursuz uyum sağlayacak şekilde tasarlanmıştır.

Proje dört çalışma bileşenine ayrılır:
1. **`local/` — Bağımsız Yerel Sürüm:** Aynı bilgisayarda Node.js sunucu ve yerel CPU/CUDA OCR; ev/LAN kullanımı.
2. **`vps/` — Sürekli Çalışan Tam Sunucu:** Aynı okuyucu ve kütüphane özellikleri, kendi CPU OCR motoru, kalıcı arka plan kuyruğu ve isteğe bağlı ev worker’ına iş devretme.
3. **`compute/` — İsteğe Bağlı GPU Worker:** Ev bilgisayarından VPS’ye yalnız outbound HTTPS; bilgisayar moduna atanmış kitapları işler, sonuçları VPS diskine teslim eder ve kuyruk boşalınca kapanır.
4. **`hosting/` — Firebase Cloud Sürümü:** Mevcut Auth, Firestore ve Cloud Storage tabanlı statik/serverless sürüm; değişmeden korunur.

---

## ✨ Temel Özellikler

- 📄 **Sayfa Sayfa (Paged) Modu:** CSS Columns mimarisiyle pürüzsüz çift yönlü sayfa çevirme, dokunma/tıklama ile sayfa geçişi ve klavye yön tuşları desteği.
- 📜 **Kesintisiz Kaydırma (Scroll) Modu:** Dinamik bölüm pencereleme (windowing) mimarisi. Uzun kitaplarda tarayıcıyı yormamak için yalnızca ekrandaki ve komşu bölümler canlı tutulur; kaydırdıkça sonraki bölümler otomatik olarak yüklenir.
- ⚡ **Hızlı Sayfa Atlama:** `G` kısayolu veya sayfa rozetine tıklayarak doğrudan istenen sayfaya kaydırma/sayfa numarası ile gitme.
- 🎧 **Sesli Okuma (TTS & Read Aloud):** Cümle düzeyinde görsel vurgulama, hız ayarı (0.75x - 4.0x), Türkçe ve çoklu dil ses seçimi.
- 🎨 **Kişiselleştirilebilir Temalar:** Orijinal Kitap Teması, Koyu Mod, Açık Mod, Sepya, OLED Siyah ve özel renk seçiciler.
- 🔤 **Gelişmiş Tipografi:** Yazı tipi ailesi (Inter, Outfit, Lora, Sistem varsayılanı), boyut, satır yüksekliği, sayfa kenar boşlukları ve paragraf aralığı ayarları.
- 📑 **İçindekiler (TOC):** Bölümler arasında tek tıkla gezinme.
- 📑 **PDF & EPUB Hibrit Desteği:** EPUB arşivlerini doğrudan istemcide açabilme ve PDF dosyalarını optimize edilmiş parça yükleme ile okuma.
- 🔍 **Vektörel PDF Görüntüleyici:** PDF.js ile dinamik döşemeli (tiled canvas) vektör çizim mimarisi. Sayfayı %500'e kadar büyütürken bulanıklaşma ve pikselleşme olmadan orijinal netliği koruma; OCR beklemeden anında kaynak çizimi.
- **Belge OCR & Formül Tanıma (`local/`, `vps/`, `compute/`):** Ortak GLM-OCR / PP-DocLayoutV3 hattı ve kaynak PDF pencereleri; paragraflar doğal olarak yeniden akar, kod/algoritma satırları korunur. VPS’nin CPU OCR yeteneği korunur; kullanıcı bilgisayar modunu seçerek tüm PDF’yi veya sayfa aralığını evdeki CUDA BF16 worker’a hazırlatabilir.
- **PDF Düzeni ve OCR Kontrolü (`local/`, `vps/`):** Ayarlardan yalnız metin veya iki yönlü PDF/metin düzeni; sürüklenebilir, genişliği saklanan ayırıcı. OCR kapaktan değil kitap düzeyindeki metin katmanına göre seçilir; kitap için otomatik/açık/kapalı ve kapalıyken bile açık sayfa OCR isteği desteklenir.

---

## 📂 Proje Yapısı

```text
reader/
├── local/                      # Yerel Node.js / Express sürümü
│   ├── server.js               # Express API ve statik dosya sunucusu
│   ├── firebase-auth.js        # Firebase Auth ID Token (RS256) doğrulama katmanı
│   ├── firebase-config.example.js # Firebase Web SDK yapılandırma şablonu
│   ├── package.json            # Sunucu, PDF çizimi ve yerel OCR bağımlılıkları
│   ├── pdf-ocr.js              # PDF çıkarımı, belge OCR entegrasyonu ve sürümlü önbellek
│   ├── pdf-windows.js          # Tüm metin/formüller için uyarlanabilir kaynak PDF pencereleri
│   ├── document-ocr.js         # Kalıcı Python model süreci ve işlem kuyruğu
│   ├── document-ocr-worker.py  # Yapı analizi, parça bazında metin/LaTeX tanıma
│   ├── document-blocks.js      # Kaynak konumlu satır içi matematik ve seçilebilir çıktı
│   ├── pdf-viewer.js           # Dinamik döşemeli vektörel PDF görüntüleyici (PDF.js)
│   ├── pdf-layout.js           # Yerel PDF paragraf sınırları ve font ölçüleri
│   ├── index.html              # Okuyucu arayüzü
│   ├── script.js               # İstemci mantığı (yerel API entegreli)
│   ├── style.css               # Tema ve okuyucu stilleri
│   ├── .env.example            # Port ve OCR cihazı yapılandırma şablonu
│   ├── library.example.json    # Boş kütüphane şablonu
│   └── README.md               # Yerel sürüm kılavuzu
│
├── vps/                        # Aynı tam okuyucu + kalıcı CPU/GPU iş kuyruğu
│   ├── server.js               # Paylaşılan sunucunun VPS giriş noktası
│   ├── .env.example            # Worker secret, veri dizini, CPU OCR ayarları
│   └── README.md               # Ubuntu / Oracle Ampere kurulum ve taşıma
│
├── compute/                    # Yalnız ihtiyaç olduğunda başlatılan GPU worker
│   ├── worker.py               # Güvenli outbound claim/render/OCR/teslim döngüsü
│   ├── requirements.txt        # Ortak OCR + Python PDF/ağ bağımlılıkları
│   ├── cuda-requirements.txt   # CUDA PyTorch bağımlılıkları
│   ├── .env.example            # VPS_URL ve WORKER_SECRET
│   └── README.md               # Windows/Linux kurulum ve çalıştırma
│
├── hosting/                    # Firebase Cloud sürümü
│   ├── firebase.json           # Firebase Hosting ve SPA yönlendirme kuralları
│   ├── firestore.rules         # Kullanıcıya özel Firestore güvenlik kuralları
│   ├── storage.rules           # Kullanıcıya özel Cloud Storage kuralları
│   ├── storage.cors.json       # Cloud Storage HTTP Range CORS yapılandırması
│   ├── .firebaserc.example     # Firebase proje bağlama şablonu
│   ├── public/
│   │   ├── index.html          # Web arayüzü
│   │   ├── script.js           # İstemci mantığı (Firestore & Storage entegreli)
│   │   ├── cloud-reader.js     # Range tabanlı EPUB ve PDF açıcı
│   │   ├── layout-bundle.js    # Hızlı sayfa hesabı için düzen paketi
│   │   ├── range-archive.js    # HTTP Range ile ZIP okuma motoru
│   │   ├── firebase-config.example.js # Firebase SDK konfigürasyon şablonu
│   │   └── style.css           # Stillendirme
│   └── README.md               # Firebase dağıtım kılavuzu
│
├── .gitignore                  # Hassas anahtar ve kişisel verileri dışlayan kural seti
├── LICENSE                     # MIT Lisansı
└── README.md                   # Genel dokümantasyon
```

---

## 🚀 Hızlı Başlangıç

### 1. Yerel Sürüm (`local/`)

Kendi bilgisayarınızda çalıştırmak için:
Node.js 22 LTS veya 24 LTS önerilir.

```bash
cd local
cp .env.example .env            # Firebase isteğe bağlı; OCR_DEVICE=auto/cuda/cpu
npm install
npm start
```

Sunucu başladığında terminalde yerel IP adresiniz listelenir:
- Bilgisayarınızdan: `http://localhost:3000`
- Telefon / Tabletinizden: `http://<YEREL_IP>:3000`

Ayrıntılı bilgi için [local/README.md](local/README.md) dosyasına göz atabilirsiniz.

---
### 2. VPS + Ev GPU Worker (`vps/` ve `compute/`)

VPS kendi CPU OCR motoruyla tek başına çalışabilir; ev bilgisayarı zorunlu değildir. Ağ isteği OCR bitene kadar açık tutulmaz: kaynak PDF kullanılabilir kalır, metin `pending/processing` durumuyla hazırlanır.

1. [VPS kurulumunu](vps/README.md) uygulayın; `.env` içinden Firebase, CPU OCR ve uzun rastgele `WORKER_SECRET` değerini ayarlayın.
2. [Compute kurulumunu](compute/README.md) uygulayın; `.env` içinde HTTPS `VPS_URL` ve aynı `WORKER_SECRET` değerini kullanın. Mevcut VPS yalnız HTTP sunuyorsa `.env` içindeki `SSH_HOST`, `SSH_USER` ve `SSH_KEY_FILE` ile worker’ın otomatik şifreli outbound SSH tünelini seçin.
3. PDF okuyucusunda **Ayarlar → OCR işleme ve dışarı çıkmadan kitap hazırlama** panelinde **Bilgisayarım / GPU worker** seçin. Varsayılan kapsam **Tüm kitap**; sayfa aralığı da seçilebilir. **OCR hazırlamayı başlat** ile işleri kuyruğa ekleyin; bu açık istek kitap için OCR’ı etkinleştirir.
4. Evde `compute/worker.py` çalıştırın. Worker yalnız bilgisayar modundaki işleri alır; CPU/GPU modları kendiliğinden birbirine düşmez. Kuyruk boşalınca kapanır.
5. Tamamlanan metin, LaTeX, blok koordinatları ve kaynak görseller VPS diskinde saklanır. Ev bilgisayarı kapalıyken de dışarıdan okunabilir ve sesli okumada kullanılabilir.

Otomatik OCR yalnız taranmış/vektör gövdeli kitaplarda açılan sayfaları hazırlar; metinli kitabın boş kapağı iş başlatmaz. Ayarlardan OCR’ı kitap için kapatabilir veya tek sayfayı elle yeniden işletebilirsiniz. Aynı hazırlama panelinden toplu VPS CPU OCR de istenebilir. `local/` kendi kütüphanesini ve motorunu kullanmayı sürdürür; `hosting/` bu kuyruk sisteminden bağımsızdır.


### 3. Bulut Sürümü (`hosting/`)

Kendi Firebase projenizde barındırmak için:

1. `hosting` klasörüne gidin:
   ```bash
   cd hosting
   ```
2. Yapılandırma dosyalarını şablonlardan oluşturun:
   ```bash
   cp .firebaserc.example .firebaserc
   cp public/firebase-config.example.js public/firebase-config.js
   ```
3. `public/firebase-config.js` dosyasını kendi Firebase Konsolunuzdaki Web App ayarlarıyla doldurun.
4. Dağıtımı gerçekleştirin:
   ```bash
   firebase login
   firebase deploy --only "hosting,firestore:rules,storage"
   ```
5. Cloud Storage için CORS yapılandırmasını uygulayın:
   ```bash
   gcloud storage buckets update gs://<PROJE_ID>.firebasestorage.app --cors-file=storage.cors.json
   ```

Ayrıntılı bilgi için [hosting/README.md](hosting/README.md) dosyasına göz atabilirsiniz.

---

## 🔒 Güvenlik ve Gizlilik

Bu depo açık kaynak paylaşımına hazır olarak yapılandırılmıştır:
- Gerçek Firebase API anahtarları, proje kimlikleri ve kullanıcı veritabanları Git takibinden çıkarılmıştır (`.gitignore`).
- Şablon dosyaları (`.example`) kullanılarak her geliştirici kendi güvenli kimlik bilgileriyle projeyi kurabilir.
- Firestore ve Cloud Storage güvenlik kuralları kullanıcı bazlı yetkilendirme (`request.auth.uid == userId`) modelini zorunlu kılar.

---

## 📜 Lisans

Bu proje [MIT Lisansı](LICENSE) altında lisanslanmıştır.
