# Edge Reader — Local (Node.js) Sürümü

Bu klasör, yerel ağınızda (Wi-Fi / LAN) veya çevrimdışı (offline) bilgisayarınızda çalışan bağımsız Node.js sunucu sürümüdür.

## Özellikler

- **Yerel Depolama:** Kitaplar ve kapaklar yerel diskte (`uploads/`) saklanır, harici bulut servisine ihtiyaç duymaz.
- **Yerel Veritabanı:** Kitap listesi ve okuma ilerlemesi `library.json` dosyasında tutulur.
- **Ağ İçi Senkronizasyon:** Aynı Wi-Fi ağındaki telefon, tablet veya diğer bilgisayarlardan sunucu IP adresi ile erişilebilir.
- **Sayfa Sayfa ve Kaydırma Modları:** CSS Column tabanlı yatay sayfa modu ve dinamik bölüm pencereli dikey kaydırma modu.
- **EPUB, PDF, HTML Desteği:** Kitap içi arama, sayfa atlama (G kısayolu), metin boyutu, yazı tipi ve tema özelleştirmeleri.
- **Edge Sesli Okuma (TTS):** Cümle düzeyinde vurgulama ve hız ayarı.

## Gereksinimler

- [Node.js](https://nodejs.org/) (v16 veya üstü)
- npm

## Kurulum ve Çalıştırma

1. Bağımlılıkları yükleyin:
   ```bash
   npm install
   ```

2. (İsteğe bağlı) Ortam değişkenlerini ayarlayın:
   Varsayılan port `3000`'dir. Farklı bir port kullanmak isterseniz `.env.example` dosyasını `.env` olarak kopyalayıp portu belirleyebilirsiniz:
   ```bash
   cp .env.example .env
   ```

3. Sunucuyu başlatın:
   ```bash
   npm start
   ```

4. Tarayıcınızda açın:
   - Bilgisayarınızdan: `http://localhost:3000`
   - Telefon veya tabletinizden: Konsolda gösterilen yerel IP adresi (örn. `http://192.168.1.X:3000`)
