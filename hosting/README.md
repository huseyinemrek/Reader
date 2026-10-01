# Edge Reader — Firebase Cloud (Hosting) Sürümü

Bu klasör Firebase Hosting, Cloud Firestore ve Cloud Storage altyapısı üzerinde çalışan sunucusuz (serverless) bulut sürümüdür.

## Özellikler

- **Bulut Senkronizasyonu:** Kullanıcı kimlik doğrulama (Firebase Auth) ile kişisel kütüphane ve okuma ilerlemesi (Firestore) tüm cihazlarda anlık eşitlenir.
- **Range Streaming & Düşük Veri Tüketimi:** Kitapların tamamı tek seferde indirilmez; EPUB ve PDF dosyaları HTTP `Range` istekleriyle parça parça çekilir.
- **Önceden Hesaplanmış Düzen (Layout Bundle):** EPUB yüklenirken görsel boyutları ve bölüm metinleri optimize edilmiş bir paket haline getirilir; ilk açılışta devasa resimler indirilmeden tam sayfa sayısı hesaplanabilir.
- **Sayfa Sayfa ve Kaydırma Modları:** CSS Columns tabanlı çift yönlü sayfa çevirme ve akıcı dikey kaydırma modu.
- **Ortak PDF okuyucu:** Kaynak yer işaretleri ve adlandırılmış/iç içe hedefler, yerleşik font vurgusu/göreli boyutlar, üç metin/PDF düzeni, klavye/fare ayırıcısı ve döşemeli kaynak yakınlaştırma.
- **Okurken arka plan yükleme:** Üst menüde `+`, çoklu/tekrarlı seçim, kitap adı tooltip’i olan küçük yüzde dairesi; tamamlanma okuyucu sayfasını veya rotasını sıfırlamaz.
- **OCR yok:** Yerleşik PDF metni ve kaynak görüntü kullanılır; taranmış sayfaya metin/font tahmini veya OCR/ev worker arayüzü eklenmez.

## Hızlı Kurulum

### 1. Ön Gereksinimler

- [Node.js](https://nodejs.org/) (22.13+ veya 24 LTS önerilir; yalnız CLI/test araçları, hosting’de Node sunucu çalışmaz)
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`)
- Firebase Konsolu'nda oluşturulmuş bir proje (Blaze / Pay-as-you-go planı Cloud Storage kullanımı için gereklidir)
- Bütün gerçek hosting regresyonları için Java 21+ ve `local/` geliştirme bağımlılıkları; yalnız statik Hosting emülatörü Java gerektirmez.

### 2. Proje Yapılandırması

1. Firebase projenizi bağlayın:
   `.firebaserc.example` dosyasını `.firebaserc` olarak kopyalayın ve proje ID'nizi girin:
   ```bash
   cp .firebaserc.example .firebaserc
   ```
   Veya doğrudan CLI ile seçin:
   ```bash
   firebase login
   firebase use --add <PROJE_ID>
   ```

2. Web SDK konfigürasyonunu ekleyin:
   `public/firebase-config.example.js` dosyasını `public/firebase-config.js` olarak kopyalayın ve Firebase Console > Project Settings > General > Your Apps altındaki bilgilerinizi yazın:
   ```bash
   cp public/firebase-config.example.js public/firebase-config.js
   ```

### 3. Yerel Test

```bash
firebase emulators:start --only hosting
```
Tarayıcınızda `http://localhost:5000` adresinden açabilirsiniz.

### 4. Canlıya Dağıtım

#### GitHub Actions ile Otomatik Dağıtım (CI/CD)

`main` dalına push yapıldığında `.github/workflows/deploy.yml` workflow'u tetiklenir ve Firebase Hosting sürümünü (`https://book-reader-upload.web.app`) otomatik olarak canlıya alır.

İlgili GitHub Secrets:
- `FIREBASE_TOKEN`: Firebase CLI CI yetkilendirme belirteci (`firebase login:ci`).
- `FIREBASE_CONFIG_JS`: `hosting/public/firebase-config.js` dosyasının içeriği (Web SDK istemci konfigürasyonu).

Workflow, `FIREBASE_CONFIG_JS` içeriğinden `hosting/public/firebase-config.js` ve `.firebaserc` dosyalarını oluşturup `firebase deploy --only hosting` adımını çalıştırır.

#### Manuel Dağıtım

```bash
firebase deploy --only "hosting,firestore:rules,storage"
# Yalnızca hosting dosyalarını güncellemek için:
firebase deploy --only hosting
```
### 5. Cloud Storage CORS Ayarları

Storage üzerinden Range isteklerinin tarayıcıda sorunsuz çalışabilmesi için CORS kuralını uygulayın:
```bash
gcloud storage buckets update gs://<PROJE_ID>.firebasestorage.app --cors-file=storage.cors.json
```

Yerel Firebase yapılandırması `book-reader-upload` projesinin `book-reader-upload.firebasestorage.app` bucket’ını kullanır. Bu uzantı yeni Firebase bucket’ları için doğrudur; `.appspot.com` ile değiştirmeyin. Önceki billing/kota incelemesinin gözlemleri güncel bir kesinti iddiası değildir.

Yeni bir `storage/quota-exceeded` hatasında başarısız isteğin gerçek HTTP durumunu ve gövdesini, hesabın etkin ödeme durumunu, Storage kotasını ve yanıtın işaret ettiği IAM izinlerini kontrol edin. Blaze etiketi, Hosting kotası veya uyarı bütçesi tek başına Storage erişimini/harcama tavanını garanti etmez. Kitapları herkese açık yapmak ya da kuralları `allow read, write: if true` yapmak çözüm değildir. İndirme token’larını paylaşmayın. [Firebase hata kodları](https://firebase.google.com/docs/storage/web/handle-errors), [Storage faturalandırma gereklilikleri](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).

## Ücretsiz kullanım hangi ürüne ait?

| Ürün | Bu uygulamadaki veri | İlgili ücretsiz kullanım |
| --- | --- | --- |
| Firebase Hosting | HTML, JS, CSS ve okuyucu kütüphaneleri | 10 GB saklama, 360 MB/gün veri aktarımı |
| Cloud Storage | Kitaplar, kapaklar ve EPUB düzen indeksi | Uygun bölgelerde 5 GB-ay Standard saklama; 5.000 Class A ve 50.000 Class B işlem/ay; uygun çıkış için 100 GB/ay |
| Firestore | Kütüphane kaydı, kitap bağlantıları, okuma konumu | Ayrı okuma/yazma ve saklama kotası |

360 MB/gün Hosting kotası, Storage'dan indirilen EPUB/PDF dosyasının kotası değildir. Hosting saklama alanı da Storage bucket alanından ayrıdır. [Firebase fiyatlandırma](https://firebase.google.com/pricing), [Hosting kotaları](https://firebase.google.com/docs/hosting/usage-quotas-pricing).

`*.firebasestorage.app` bucket'ları Google Cloud Storage fiyatlandırmasına tabidir. Always Free Standard saklama/işlem hakları `us-central1`, `us-east1`, `us-west1` bölgelerine bağlıdır ve bu üç bölgenin kullanımı birlikte hesaplanır. Ücretsiz veri aktarımı Kuzey Amerika'dan uygun hedeflere uygulanır; Avustralya ve Çin hariçtir. Bucket konumu bilinmeden bu projeye 100 GB ücretsiz indirme garantisi verilemez. [Google Cloud Storage Always Free](https://cloud.google.com/storage/pricing#cloud-storage-always-free).

Cloud Storage erişimi için Blaze gerekir; ücretsiz eşikleri aşan kullanım ücretlidir. Ücretsiz haklar ve standart bütçe uyarıları **harcama tavanı değildir**. Eylül 2026'daki Firebase spend-cap önizlemesinde Storage desteklenen servisler arasında değildir. [Bütçe uyarıları](https://docs.cloud.google.com/billing/docs/how-to/budgets), [desteklenen spend-cap servisleri](https://firebase.google.com/docs/projects/billing/spend-caps).

## Parça parça okuma ve toplam sayfa

EPUB tek bir ZIP dosyasıdır; bir HTTP `Range` isteği sayfa numarasını doğrudan seçemez. Okuyucu ZIP dizinini ve gerekli sıkıştırılmış girdileri byte aralıklarıyla alır. Yeni EPUB yüklemelerinde yerel dosyadan ayrıca küçük bir düzen paketi hazırlanır: bölüm metinleri ve yerleşim bilgileri ile görsel boyutları. Görsellerin asıl verisi ihtiyaç duyulduğunda orijinal EPUB'dan alınır.

Tam toplam sayfa sayısını hesaplamak için bütün bölüm metinlerinin yerleşimi ölçülmelidir. Yazı tipi/boyutu, satır aralığı, içerik genişliği ve pencere boyutu değişince sayfa sayısı değişebilir. Görseller için boyutları bilinen yer tutucular kullanmak, sayfa hesabı sırasında büyük görsellerin tamamını indirme gereksinimini kaldırır. Bu nedenle ilk açılışta yalnızca ekranda görünen metnin indirilmesi ile bütün kitabın kesin toplam sayfasının bilinmesi aynı anda mümkün değildir; düzen paketindeki bütün metinler gerekir. Büyük görsellerin geciktirilmesi özellikle resimli kitaplarda aktarımı azaltır.

Eski kayıtlarda `layoutVersion: 1` düzen paketi yoksa görsel boyutlarını belirlemek için görsellerin bir kez okunması gerekebilir. En az indirme için kitabın yerel kopyasını yeni sürümle yeniden yükleyin; yeni kayıt doğrulandıktan sonra eski kaydı uygulamadan silebilirsiniz. Otomatik sunucu dönüştürme veya yerel `uploads/` klasörü eşitlemesi yoktur.

PDF sabit sayfalıdır: orijinal sayfa sayısı font ayarından etkilenmez. Okuyucu PDF.js'in istediği byte aralıklarını alır. PDF içindeki çapraz başvuru tablosu, paylaşılan fontlar/görseller ve sayfa bağımlılıkları ek aralıklar gerektirebilir; bir sayfa açmak her PDF için sabit miktarda veri demek değildir.

Range yanıtının `206 Partial Content` olması ve okunabilir, doğru bir `Content-Range` taşıması gerekir. Sunucu `200 OK` ile dosyanın tamamını göndermeye çalışırsa uygulama hatayı göstermeli ve sessizce tam dosyaya geçmemelidir. EPUB/PDF objelerine `Content-Encoding: gzip` vermeyin; Cloud Storage indirme sırasında dönüştürme yaparsa `Range` başlığını yok sayabilir. [Range indirme belgesi](https://docs.cloud.google.com/storage/docs/downloading-objects).

## Ortak PDF tipografisi ve yükleme kuyruğu

PDF.js 6 ile yerleşik font metadata’sı okunur; normal/italik/oblik/kalın ve göreli başlık/dipnot ölçüleri metin parçalarıyla korunur. Kullanıcının seçtiği aile, renk ve temel boyut kaynak vurgusunu silmez. **Ayarlar → PDF Görünümü** yalnız metin veya iki yönlü kaynak PDF/metin düzeni sunar; ayırıcı fare/dokunma ve ok/Shift/Home/End tuşlarıyla ayarlanır. Kaynak sayfa döşemelerle %500’e kadar yeniden çizilir. Yer işareti yoksa kütüphane kaydından uydurma içindekiler kullanılmaz.

**Sığdır** sayfanın tamamını, **Doldur** sütun genişliğini kullanır; Doldur ekran/ayırıcı değişimini izler. Metin kaydırması büyütülmüş kaynağın aynı sayfadaki başlangıç/orta/son oranını izler, paragrafla birebir eşleştirme değildir. Kaynağı elle kaydırmak metni değiştirmez; sonraki metin kaydırması eşzamanlamayı sürdürür.

Kaynak PDF’nin yerleşik metni fareyle seçilip **Ctrl/Cmd+C** veya **Kopyala** ile kopyalanır; alan odaktayken **Ctrl/Cmd+A** sayfa metnini seçer. Kaynak metin ikinci bir DOM metin katmanına eklenmez; boş görsel vurgu kutuları, metin/erişilebilirlik ağacı üzerinden sesli okumada çift kitap metni oluşmasını önler. Karakter konumu PDF.js öğe dönüşümü ve göreli ölçüyle belirlenir. Hosting’de OCR yoktur; yalnız taranmış sayfalarda kaynak üzerinden kopyalanabilir metin üretilemez.

Ortak `pdf-graphics.mjs` resim ve vektör çizimleri tarayıcıda kaynak PDF’den kırpar; döndürme, clipping ve maskeler korunur. Görseller yalnız metin düzeninde de kaynak sırasıyla metin arasına girer; görsel içindeki etiketler yinelenmez. Yalnız resim içeren kapak/sayfa gerçek görüntüyü gösterir, metin veya OCR uydurulmaz. Bu işlem mevcut Range PDF kaynağını kullanır; Storage’a ek dosya yazmaz ve eski kitabı tekrar yüklemeyi gerektirmez.

Beyaz sayfa/paragraf dolguları ve ince alt çizgiler ayrı görsel sayılmaz; bu bölgelerdeki yerleşik metin seçilebilir paragraf olarak kalır.

Kütüphaneden veya üst okuyucu menüsündeki `+` ile birden fazla dosya seçebilirsiniz; sonraki seçim kuyruğa eklenir. Hazırlama ve kayıt sonlandırma belirsiz aşamalar, Storage aktarımı gerçek byte yüzdesidir. Orijinal kitap, düzen paketi ve kapak aktarımı bitip Firestore kaydı tamamlanmadan `%100` gösterilmez. Dairenin tooltip’i hazırlanan gerçek kitap adını ve aşamasını gösterir. Kuyruk okuyucu etkileşimini engellemez; tamamlanma yalnız kütüphaneyi sessizce yeniler.

Kuyruk dosyaları yalnız açık sekmenin belleğindedir, IndexedDB/localStorage’da yükleme işi tutulmaz. Bekleyen/çalışan işte kapatma/yenileme uyarısı vardır; sekme kapandıktan sonra otomatik devam yoktur. Tamamlanmış kitaplar Storage/Firestore’da kalır. Hatalı iş sonraki kitabı durdurmaz; yeniden deneme veya listeden kaldırma sunulur. Çıkış/hesap değişimi eski hesabın işlerini iptal eder. Kuyruk OCR sistemi değildir.


## Veri yolları ve erişim

| Yol | İçerik |
| --- | --- |
| Storage `users/{uid}/books/{safeFileName}` | Orijinal EPUB/PDF/TXT |
| Storage `users/{uid}/covers/{fileName}` | Kapak |
| Storage `users/{uid}/layouts/{bookId}.zip` | EPUB düzen paketi |
| Firestore `users/{uid}/library/{bookId}` | Kitap ve ilerleme bilgileri |

Yeni düzen kaydı `layoutUrl`, `layoutStoragePath`, `layoutVersion: 1` ve `fileSize` alanlarını kullanır. `storage.rules` yalnızca sahibinin kitap/kapak/düzen dosyalarını; `firestore.rules` yalnızca sahibinin kütüphanesini açar. Kurallar toplam hesap/bucket harcamasını sınırlandırmaz. `getDownloadURL` ile üretilen token'lı indirme bağlantıları bağlantıyı bilen kişi tarafından kullanılabilir; bunları herkese açık yerde paylaşmayın. CORS bir kimlik doğrulama kuralı değildir.

## Yerelde açma ve yayınlama

Komutları bu `hosting/` klasöründe çalıştırın. Firebase CLI ve Google Cloud CLI kurulu ve ilgili proje hesabıyla oturum açılmış olmalıdır.

```powershell
firebase login
firebase use book-reader-upload
firebase emulators:start --only hosting
```

Hosting emülatörü `http://localhost:5000` adresini açar. Yalnızca Hosting emülatörü seçildiğinden Auth/Firestore/Storage bağlantıları gerçek projedir; uygulamada yükleme/silme gerçek veriyi etkiler. Başka bir port kullanırsanız `storage.cors.json` içindeki origin listesini de uyarlayın.

Yerelde hazırlanmış dosyaları yayına almak için:

```powershell
firebase deploy --only "hosting,firestore:rules,storage" --project book-reader-upload
```

Bu komut canlı Hosting ve kuralları değiştirir; mevcut kurallar başka uygulamalar tarafından kullanılıyorsa önce karşılaştırın. `firebase.json` yalnızca `public/` klasörünü yayınlar.

## Bucket CORS ve Range doğrulaması

Firebase'in [tarayıcı indirme belgesi](https://firebase.google.com/docs/storage/web/download-files#cors_configuration) Cloud Storage CORS yapılandırmasını ister. `storage.cors.json` bu projenin iki Hosting alan adını ve yerel port 5000'i içerir; yeni bir domain veya preview kanalı için exact origin ekleyin.

Önce mevcut yapılandırmayı okuyun:

```powershell
gcloud storage buckets describe gs://book-reader-upload.firebasestorage.app --format="json(name,location,storageClass,cors)"
```

Gerekli bucket yönetim izni olan hesapla CORS'u uygulayın:

```powershell
gcloud storage buckets update gs://book-reader-upload.firebasestorage.app --cors-file=storage.cors.json
```

Bu işlem bucket'ın mevcut CORS listesini değiştirir; başka bir uygulama kullanıyorsa onun origin'lerini koruyun. CORS `firebase deploy` tarafından uygulanmaz. [Google Cloud CORS ayarlama](https://cloud.google.com/storage/docs/configuring-cors).

Tarayıcı geliştirici araçlarında gerçek Storage isteğini kontrol edin: `Range: bytes=...`, HTTP `206`, `Content-Range: bytes başlangıç-bitiş/toplam`, uygun `Access-Control-Allow-Origin` ve JavaScript'e açık `Content-Range`. `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag` başlıkları CORS dosyasında listelenir. GCS API türleri CORS'u farklı uygular; Firebase download endpoint'i üzerindeki gerçek yanıtı doğrulamadan bu ayarın tek başına yeterli olduğunu varsaymayın. [CORS davranışı](https://docs.cloud.google.com/storage/docs/cross-origin).

Yeni EPUB ile son kontrol: ilk açılışta büyük görsellerin tamamının inmediğini, sayfa değiştirince gereken görselin geldiğini, font büyütünce toplam sayfanın yeniden hesaplandığını ve aynı hesaptaki ikinci cihazda kitabın açıldığını doğrulayın. Bu kontrol bucket erişimi sağlandıktan sonra yapılmalıdır.

## Commit öncesi gerçek üç-sürüm kontrolü

Depo kökünden `npm --prefix local run check` komutunu çalıştırın; hazırlık ve Java 21 ayarı [local/README.md](../local/README.md#commit-öncesi-kalıcı-regresyon-kontrolü) içinde açıklanır. Hosting vakaları izole resmi Firebase Auth/Firestore/Storage/Hosting emülatörlerinde gerçek SDK, kitap byte’ları ve üretim kurallarıyla çalışır; canlı projeye yükleme/silme gönderilmez. Testteki aynı-origin yönlendirmesi Storage emülatörünün eksik CORS header açılımını giderir, Range/byte/yanıtları değiştirmez; canlı bucket CORS kontrolünün yerine geçmez.

