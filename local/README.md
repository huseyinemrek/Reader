# Edge Reader — Local (Node.js) Sürümü

Bu klasör, yerel ağınızda (Wi-Fi / LAN) veya çevrimdışı (offline) bilgisayarınızda çalışan bağımsız Node.js sunucu sürümüdür.

## Özellikler

- **Yerel Depolama:** Kitaplar ve kapaklar yerel diskte (`uploads/`) saklanır, harici bulut servisine ihtiyaç duymaz.
- **Yerel Veritabanı:** Kitap listesi ve okuma ilerlemesi `library.json` dosyasında tutulur.
- **Ağ İçi Senkronizasyon:** Aynı Wi-Fi ağındaki telefon, tablet veya diğer bilgisayarlardan sunucu IP adresi ile erişilebilir.
- **Sayfa Sayfa ve Kaydırma Modları:** CSS Column tabanlı yatay sayfa modu ve dinamik bölüm pencereli dikey kaydırma modu.
- **EPUB, PDF, HTML Desteği:** Kitap içi arama, sayfa atlama (G kısayolu), metin boyutu, yazı tipi ve tema özelleştirmeleri.
- **Edge Sesli Okuma (TTS):** Cümle düzeyinde vurgulama ve hız ayarı.
- **Yerel PDF OCR:** Tesseract ile İngilizce ve Türkçe taranmış sayfalardan metin çıkarma; grafik ve resimleri tam sayfa görselinde koruma.

## Gereksinimler

- [Node.js](https://nodejs.org/) (22.13+ sürümünün 22.x dalı veya 24+; Node.js 24 LTS önerilir)
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

## PDF ve OCR

PDF dosyasını **Yeni Kitap Ekle** ile yükleyin. Sayfa açıldığında yerel sunucu PDF.js ile tüm sayfayı JPEG olarak çizer; taranmış resimler ve vektör grafikler bu görselde korunur. Grafikler ayrı kırpılmış dosyalar olarak değil, orijinal sayfanın içinde gösterilir. Orijinal görsel solda, seçilebilir metin sağda gösterilir; dar ekranlarda alt alta geçmek yerine karşılaştırma alanı yatay kaydırılır. Metin uygulamanın sesli okuma akışında kullanılabilir.

En az 200 harf/rakam içeren, bozuk karakter barındırmayan PDF metni doğrudan kullanılır. Metin yoksa veya yalnızca kısa grafik etiketleri varsa Tesseract (`eng+tur`) otomatik çalışır. Kısmen okunabilen bir sayfada eksik metin varsa **Bu sayfayı OCR ile oku** düğmesi yerel metin yerine OCR sonucunu kullanır.

Metin görseldeki paragraf bloklarına göre aktarılır: satır sonları yeniden akıtılır, paragraf girintileri ve boşlukları ayrı paragrafları belirler, sayfa altındaki numara ayrı tutulur. PDF metin katmanında gerçek font ölçüleri, OCR'de ise ölçülen harf geometrisi kullanılarak ana metne göre font boyutu oranları saklanır. Sabit başlık boyutları verilmez; küçük açıklamalar da kendi oranlarıyla gösterilir. Okuyucunun font boyutunu değiştirince oranlar korunur.

OCR harf kutuları kesin font metrikleri değildir. Aynı paragraftaki bir piksellik ölçüm farkları birleştirilir; tek şüpheli harf ölçümü bir kelimeyi büyütmez. Taranmış sayfalarda font oranları tahminidir, özellikle grafik içi metin ve matematik sembolleri hatalı ölçülebilir.

- OCR bilgisayarınızdaki Node.js sunucusunda çalışır; telefon veya başka bir istemcide ek kurulum gerekmez.
- Dil modelleri `npm install` sırasında kurulur. PDF işleme sırasında buluta dosya gönderilmez ve model indirme gereksinimi yoktur; ayrıca Tesseract uygulaması kurmanız gerekmez.
- Sayfalar ihtiyaç oldukça işlenir. Tek işlem kuyruğu CPU kullanımını sınırlar; ilk açılış sonraki açılışlardan daha yavaş olabilir.
- Metin ve görseller `uploads/pdf/<kitap-id>/` altında saklanır, sunucu yeniden başladıktan sonra yeniden kullanılır. Kitap silinince ilgili önbellek de silinir.
- `GET /api/books/:id/pdf/pages/:page` metni, paragraf bloklarını (`blocks`: `text`, `bbox`, `runs` içindeki `text`/`fontScale`), kaynağı (`native`/`ocr`), OCR güven skorunu ve görsel adresini döndürür. `?ocr=1` yerel PDF metni yerine OCR kullanılmasını sağlar; mevcut OCR sonucu tekrar kullanılır.
- OCR kusursuz değildir: formüller, küçük grafik etiketleri ve boşluklar hatalı tanınabilir. Güven skoru doğruluk yüzdesi değildir; orijinal sayfa görselini esas alın.

Bu destek yalnızca `local/` sürümüne eklenmiştir; Firebase hosting tarafında OCR işlem servisi veya compute gereksinimi yoktur.

### WR-1.pdf ile doğrulama

12 sayfalık örnek uygulamaya yüklenerek işlendi. Önceki metin çıkarımı 8 sayfada sıfır karakter, kalan 4 sayfada yalnızca kısa etiketler üretiyordu. Paragraf yapılı yerel OCR 12 sayfada toplam 30.555 karakter metin ve 1489 × 2105 piksel boyutunda 12 sayfa görseli üretti. Sayfa 4'teki dağılım grafiği ve sayfa 5'teki renkli eğriler okuyucu arayüzünde kontrol edildi. İlk sayfanın üç ana paragrafı tek tek aynı font boyutunda, bölünmeden aktarılır; son paragraf ve sayfa numarası ayrıdır. Font ayarı 24'ten 28'e değiştirilerek oranların korunduğu, sayfa/kaydırma modlarında yan yana görünüm ve dar ekranda yatay kaydırma doğrulandı. Yerel PDF metnini kullanma, OCR'ye geçiş ve yapılı önbellek de gerçek API üzerinden çalıştırıldı.

Paragraf ve font ilişkisi regresyonlarını çalıştırmak için:

```bash
node --test pdf-layout.test.js
```
