# Edge Reader — Firebase sürümü

Bu klasör Firebase Hosting üzerinde çalışan sürümdür. `save/edge-reader` yerel sunucu sürümüdür. Hosting yalnızca `public/` içeriğini yayınlar; `uploads/` ve `library.json` otomatik olarak buluta aktarılmaz. Kitapları bu sürümde hesabınıza giriş yaparak ekleyin. Aynı hesapla başka cihazdan açtığınızda Firestore kütüphanesi ve okuma konumu alınır.

## 13 Eylül 2026 incelemesi

Yerel Firebase yapılandırması ve açık konsol aynı `book-reader-upload` projesine, `book-reader-upload.firebasestorage.app` bucket'ına işaret ediyor. Bu uzantı yeni Firebase bucket'ları için doğrudur; `.appspot.com` ile değiştirmeyin.

Canlı konsolda görülenler:

- Proje Blaze planında ve bir Cloud Billing hesabına bağlı. **Cloud Billing > Account management ekranında hesabın vadesi geçmiş ödemesi veya geçerli ödeme bilgisi bulunmadığına ilişkin kırmızı hata var.** Aynı ekran `book-reader-upload` projesinin bu hesaba bağlı olduğunu gösteriyor.
- Firebase ve Google Cloud dosya listelerinde bucket boş görünüyor. Storage kullanım ekranı veri göstermiyor; kullanım verileri gecikmeli olduğundan bu tek başına geçmiş kota tüketimini kanıtlamaz.
- Yayınlanmış Storage kuralı giriş yapan kullanıcının yalnızca kendi `users/{uid}/...` alanını okumasına/yazmasına izin veriyor; uygulamanın mevcut dosya yollarıyla uyumlu.
- Mevcut aylık 300 TL bütçe bir uyarı bütçesi. Konsolda harcama 0 TL, harcama durdurma durumu uygulanamaz olarak görünüyor.
- Google Cloud Configuration sekmesi `storage.buckets.get` ve `storage.buckets.getIamPolicy` izinleri eksik uyarısı verdi. Bu oturumla bucket bölgesi ve mevcut CORS ayarı doğrulanamadı.

İlk giderilmesi gereken somut sorun **Cloud Billing hesabının ödeme durumu**. Blaze etiketi hesabın geçerli ödeme bilgisine sahip olduğunu garanti etmiyor. Hesap sahibi Google Cloud Billing içindeki **Payment overview** sayfasında gösterilen işlemi tamamlamalı; ödeme bilgisi değiştirilmedi veya ödeme yapılmadı. Hosting'de boş yer bulunması bu sorunu çözmez. Firebase `storage/quota-exceeded` kodunu gerçek kota aşımı yanında Storage faturalandırma erişimi kapalı olduğunda da döndürebilir; görülen billing uyarısı bu hatayla uyumludur. Başarısız yüklemenin ham HTTP yanıtı alınmadığından bunun tek neden olduğu henüz doğrulanmadı. [Firebase hata kodları](https://firebase.google.com/docs/storage/web/handle-errors), [Storage faturalandırma gereklilikleri](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).

Billing uyarısı giderildikten sonra hata sürerse proje/billing yöneticisinin aynı proje üzerinde şunları kontrol etmesi gerekir:

1. Başarısız yüklemenin tarayıcı Network ekranındaki HTTP durumu ve yanıt gövdesi: özellikle `402`, `403`, `429`, `UserProjectAccountProblem` veya kota adı. İndirme token'larını paylaşmayın.
2. Cloud Billing hesabının etkin olması ve ödeme/hesap kısıtlaması bulunmaması; Blaze etiketi tek başına tüm bu durumları açıklamaz.
3. Cloud Storage bucket konumu, Google Cloud Quotas & System Limits ve ilgili servislerin durumu. Bölge, Firestore bölgesinden bağımsız olabilir.
4. Yanıt servis hesabı/IAM sorununu belirtiyorsa Firebase Storage servis hesabı yapılandırması. Genel bir çözüm olarak kitapları herkese açık yapmayın veya kuralları `allow read, write: if true` olarak değiştirmeyin.

İnceleme sırasında canlı deployment, kural/CORS değişikliği, dosya yükleme veya billing değişikliği yapılmadı.

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

## Veri yolları ve erişim

| Yol | İçerik |
| --- | --- |
| Storage `users/{uid}/books/{safeFileName}` | Orijinal EPUB/PDF/TXT |
| Storage `users/{uid}/covers/{fileName}` | Kapak |
| Storage `users/{uid}/layouts/{bookId}.zip` | EPUB düzen paketi |
| Firestore `users/{uid}/library/{bookId}` | Kitap ve ilerleme bilgileri |

Yeni düzen kaydı `layoutUrl`, `layoutStoragePath`, `layoutVersion: 1` ve `fileSize` alanlarını kullanır. `storage.rules` yalnızca sahibinin kitap/kapak/düzen dosyalarını; `firestore.rules` yalnızca sahibinin kütüphanesini açar. Kurallar toplam hesap/bucket harcamasını sınırlandırmaz. `getDownloadURL` ile üretilen token'lı indirme bağlantıları bağlantıyı bilen kişi tarafından kullanılabilir; bunları herkese açık yerde paylaşmayın. CORS bir kimlik doğrulama kuralı değildir.

## Yerelde açma ve yayınlama

Komutları bu `edge-reader` klasöründe çalıştırın. Firebase CLI ve Google Cloud CLI kurulu ve ilgili proje hesabıyla oturum açılmış olmalıdır.

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
