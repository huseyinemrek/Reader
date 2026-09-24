# 📖 Reader

Modern, hızlı ve tarayıcı tabanlı EPUB, PDF ve HTML kitap okuyucu. Özellikle **Microsoft Edge "Sesli Oku" (Read Aloud)** ve dahili Text-to-Speech (TTS) motorlarıyla kusursuz uyum sağlayacak şekilde tasarlanmıştır.

Proje ihtiyacınıza göre iki farklı çalışma modeline sahiptir:
1. **`local/` — Yerel Node.js Sunucu Sürümü:** Çevrimdışı veya evinizdeki yerel ağda (Wi-Fi / LAN) çalışan, harici bulut hesabı gerektirmeyen bağımsız sürüm.
2. **`hosting/` — Firebase Cloud Sürümü:** Firebase Auth, Firestore ve Cloud Storage üzerinde çalışan, HTTP Range streaming destekli sunucusuz (serverless) bulut sürümü.

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

---

## 📂 Proje Yapısı

```text
reader/
├── local/                      # Yerel Node.js / Express sürümü
│   ├── server.js               # Express API ve statik dosya sunucusu
│   ├── package.json            # Sunucu bağımlılıkları (express, multer, cors, yauzl)
│   ├── index.html              # Okuyucu arayüzü
│   ├── script.js               # İstemci mantığı (yerel API entegreli)
│   ├── style.css               # Tema ve okuyucu stilleri
│   ├── .env.example            # Port yapılandırma şablonu
│   ├── library.example.json    # Boş kütüphane şablonu
│   └── README.md               # Yerel sürüm kılavuzu
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

Kendi bilgisayarınızda veya ev ağınızdaki cihazlarda paylaşmak için:

```bash
cd local
npm install
npm start
```

Sunucu başladığında terminalde yerel IP adresiniz listelenir:
- Bilgisayarınızdan: `http://localhost:3000`
- Telefon / Tabletinizden: `http://<YEREL_IP>:3000`

Ayrıntılı bilgi için [local/README.md](local/README.md) dosyasına göz atabilirsiniz.

---

### 2. Bulut Sürümü (`hosting/`)

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
