# Reader — Agent çalışma kuralları

## Her yeni feature ve hata düzeltmesinden önce

1. **Önce bu `AGENTS.md` dosyasını oku.** Kullanıcının mimariyi, sürüm sınırlarını ve test tercihlerini tekrar açıklamasını bekleme.
2. Yalnız ilgili sürümün README bölümünü ve değişecek kodu oku. Mevcut uygulama ile bu belge çelişirse kod/runtime kanıtını esas al ve yanlış bilgiyi düzelt.
3. İstenen davranış, etkilenen sürümler, ilk deneme sürümü ve en küçük doğrulama senaryosunu belirle. Repo/araçlardan bulunabilen bilgiyi kullanıcıya sorma.
4. Kullanıcının bildirdiği hata veya çalışan davranış kanıttır; aynı pahalı kontrolü yalnız bunu yeniden teyit etmek için çalıştırma.
5. Yeni bir teknik limit öğrenilirse bu dosyaya kısa kayıt ekle: **belirti → neden → etkilenen sürüm → geçerli çözüm → doğrulama**. Geçici araç hatasını kalıcı ürün kısıtı gibi yazma; gözlemlenmeyen çıkarımı açıkça belirt.

## Sürüm sınırları

| Alan | Local | VPS | Hosting |
| --- | --- | --- | --- |
| Çalışma ortamı | Node/Express, aynı bilgisayar | Ortak Node/Express sunucu; `vps/server.js` yapılandırma girişidir | Statik Firebase Hosting; Node/Express veya Python sunucu yok |
| Kitap/ilerleme | Yerel disk ve JSON | VPS diski ve JSON; kullanıcı sahipliği/kimlik doğrulama | Firebase Storage / Firestore / Auth |
| EPUB/HTMLZ düzen paketi | Mevcut disk dosyasından arka plan worker + kalıcı cache | Aynı sunucu worker/cache | Yükleme sırasında tarayıcıda hazırlanır, Storage'a yazılır |
| Sayfalama | Güncel ekran/font/CSS ile tarayıcı ölçümü | Aynı | Aynı |
| PDF | Ortak yerleşik font, kaynak yer işareti, üç düzen, döşemeli kaynak viewer | Aynı | Aynı; **OCR yok** |
| OCR | Aynı makinenin CPU/CUDA motoru; uzak işçi paneli yok | Kendi CPU motoru; isteğe bağlı outbound ev GPU worker | Desteklenmez; taranmış PDF için sahte OCR/metin üretme |
| Yükleme | Gerçek HTTP aktarımı + disk kaydı | Aynı; hesap/owner sınırı | Gerçek Storage resumable aktarımı + Firestore kaydı |
| Yükleme kuyruğu | Yalnız açık sekme belleği | Aynı | Aynı; kapatma sonrası kalıcı devam kuyruğu değil |

### İlk nerede uygula ve dene?

| Feature türü | İlk hedef | Sonraki aktarım/doğrulama |
| --- | --- | --- |
| Ortak okuyucu UI, font/renk, PDF, yer işareti, sayfalama, sekmelik kuyruk | **Local**, izole veri ve gerçek tarayıcı: en az dış servis gerektirir | Ortak modülde uygula; VPS ve hosting adapter/asset/auth farklarını hedefli senaryoyla kontrol et |
| Disk API, layout worker/cache, yerel upload | **Local** sunucu ve ilgili Node testi | VPS modu; hosting'e sunucu işi ekleme, yalnız uygun kullanıcı davranışını mevcut tarayıcı/Storage yoluyla sağla |
| Firebase Auth/Firestore/Storage, resumable upload, kurallar, Range/CORS | **Hosting** resmi demo emülatörleri; CORS için ayrıca gerçek yanıt | Local/VPS'ye yalnız geçerli ortak davranışı taşı; Firebase'e özel backend'i kopyalama |
| VPS sahiplik, kalıcı OCR kuyruğu, lease/restart veya ev worker | **İzole VPS modu**, ardından ilgili gerçek CPU/worker yolu | Local'in aynı-makine OCR sınırını koru; hosting'e OCR taşıma |
| CUDA/model/inference değişikliği | İlgili gerçek **local/compute** motoru; küçük tek sayfalık vaka | CPU etkileniyorsa VPS CPU; hosting kapsam dışı |

Seçim katı biçimde “her zaman local” değildir: feature'ın gerçek bağımlılığını en doğrudan ve en ucuz doğrulayan sürümü seç, nedenini bir cümlede belirt. İlk sürümde davranışı doğruladıktan sonra **mümkün olan diğer sürümlere de uygula ve doğrula**; yalnız ilk sürümle işi bitirme. Uyumsuz bir sınırı sessizce aşma, feature'ı sessizce daraltma veya sahte fallback ekleme. Gerçek uyumsuzluğu açıklayıp kullanıcı kararı gereken yerde sor.

## Kod haritası ve korunacak sözleşmeler

- Local/VPS okuyucu: `local/script.js`, `local/index.html`, `local/style.css`; sunucu: `local/server.js`. VPS için ikinci sunucu implementasyonu oluşturma.
- Hosting okuyucu: `hosting/public/script.js`, `index.html`, `style.css`, Firebase adapter'ları.
- Ortak PDF, font, kaynak, layout ve kuyruk modülleri `hosting/public/` altındadır. Local/VPS bunları `/reader-core/` whitelist'iyle sunar; bu klasör local/VPS dağıtımının da bağımlılığıdır. Her sürüm için ayrı PDF implementasyonu üretme.
- Disk layout: `local/layout-source.js`, `layout-worker.js`, `layout-queue.js`; browser adapter: `hosting/public/server-reader.js`. OCR kuyruğundan ayrıdır.
- PDF kaynak italik/kalın/göreli boyutunu koru; kullanıcı ailesi/renk/temel boyutu üstün gelir. OCR metnine kaynakta bilinmeyen font veya vurgu uydurma. Kaynak outline yoksa eski kütüphane TOC'si gösterme.
- EPUB kesin toplam sayfası için bütün bölüm **metinleri** ölçülür; yalnız görünen metinle bütün kitabın kesin toplamını vaat etme. Layout paketi görsel ölçülerini taşır; sayfa sayımı için tüm resimleri indirme. Ekran/font değişince toplamı ve cache kimliğini güncelle, mantıksal okuma konumunu koru.
- Local/VPS eski EPUB/HTMLZ'yi diskten paketler; tekrar upload şartı koyma. Hosting'de eski paketsiz kayıt, ölçüler için ek Range okuması gerektirebilir; otomatik sunucu dönüştürme yoktur.
- Hosting Range okuması doğru `206` ve tarayıcı tarafından okunabilir `Content-Range` ister. `200` yanıtını sessiz tam-dosya fallback'iyle örtme; EPUB/PDF objelerini gzip ile dönüştürme.
- Upload hazırlama/sonlandırma aşaması belirsizdir; transfer yüzdesi gerçek byte'lardan gelir, `%100` ancak kalıcı kitap kaydı tamamlanınca gösterilir. Tamamlanma okuyucuyu/konumu sıfırlamaz. Hesap değişimi eski owner'ın işlerini iptal eder. Başarısız işte retry/listeden kaldırma vardır; yükleme kuyruğu OCR kuyruğu değildir.
- VPS'de kullanıcı kitap/asset sahipliği ve 401 sınırı korunur. `DISABLE_AUTH=true` yalnız izole loopback smoke içindir. Ev worker dışarı bağlanır; evde port açma veya genel HTTP üzerinden secret taşıma gerekmez.
- Kitap içi link/içindekiler dönüşü ortak `reader-link-history.js` ve CSS ile sağlanır. Kayan dönüş düğmesi **5 saniye sonra tamamen gizlenir**; kalan dönüş noktalarına Ayarlar'ın üstünden ters sırayla erişilir. Normal sayfa çevirme geçmişi silmez; açık kitap oturumu sona erince geçmiş temizlenir. Kaynak karakter konumunu sakla; kitap yeniden render edilince kopan DOM node'unu veya eski reflow sayfasını dönüş konumu sayma.

## Optimize geliştirme ve test workflow'u

### 1. Dar kapsam, mevcut ortam

- Önce ilgili kod/sözleşmeyi bul; bütün depoyu veya aynı dosyaları tekrar tekrar tarama. Mevcut ortak yolu kullan. Export/caller değişikliğinde referansları kontrol et.
- Çalışan bağımlılıkları kullan. Her feature'da `npm ci`, Chromium/JAR indirmesi, Java kurulumu, OCR setup veya model indirmesi yapma. Kurulum yalnız gerçekten eksikse; lockfile değiştiyse gerekli bağımlılık güncellemesini yap.
- OCR ile ilgisiz UI/EPUB/PDF native-text işi için Python, CPU/GPU inference veya ev worker başlatma.
- Bağımsız ve yeterince büyük işler varsa net dosya/sözleşme sınırıyla paralelleştir. Küçük tek değişiklikte agent koordinasyonu kurma. Entegrasyon sahibi tek olsun; agent'lar her ara editte tam suite çalıştırmasın.

### 2. İç döngü: ilgili davranış + tek gerçek smoke

Bu bölüm, **mevcut testlerin geliştirme sırasında ve commit öncesinde en verimli kullanım planıdır**. İlgili mevcut kapsamı seç; bütün testleri her ara değişiklikte tekrarlama.

| Değişen alan | İlk çalıştırılacak mevcut testler |
| --- | --- |
| PDF font/native metin/yerleşim | `local/pdf-layout.test.js`, `local/pdf-ocr.test.js` |
| PDF bölge, figür, kaynak pencere | `local/pdf-regions.test.js`, `local/pdf-windows.test.js`, `local/document-blocks.test.js` |
| EPUB layout paketi, worker/cache | `local/layout-queue.test.js`, `hosting/tests/layout-bundle.test.mjs` |
| ZIP/Storage Range | `hosting/tests/range-archive.test.mjs` |
| Sekmelik upload kuyruğu | `hosting/tests/upload-queue.test.mjs` |
| Auth/owner sınırı | `local/firebase-auth.test.js` |
| OCR iş durumu, lease/iptal | `local/ocr-queue.test.js`, gerekiyorsa `local/pdf-ocr.test.js` |
| Görünür okuyucu, ilerleme, ayarlar, kitap değişimi | `tests/reader.test.cjs`, önce seçilen sürüm filtresi |

Tablodaki dosyaları `node --test <dosya> [diğer-ilgili-dosya]` ile seç. Her değişiklikte tablonun tamamını çalıştırma.

Komutlar **depo kökünden**, gerçek **Node.js** ile çalışır:

```sh
# Yalnız değişen alanın testi; örnekler:
node --test local/layout-queue.test.js
node --test hosting/tests/upload-queue.test.mjs

# Ortak davranış testleri; Chromium/Firebase/OCR açmaz:
npm --prefix local test

# İlk seçilen sürümün gerçek okuyucusu; diğer iki sürüm açılmaz:
node --test --test-name-pattern="^local:" tests/reader.test.cjs
node --test --test-name-pattern="^vps:" tests/reader.test.cjs
node --test --test-name-pattern="^hosting:" tests/reader.test.cjs

```

- Bug'da varsa mevcut ilgili regresyonu kullan; kullanıcı zaten hatayı kanıtladıysa yalnız gereksiz teyit için pahalı akışı tekrarlama.
- UI'da gerçek yüzeyi aç, değişen etkileşimi yap, sonucu gör. Test tek başına görsel kanıt değildir. PDF kaynak mürekkebi/görsel için gerçek canvas/piksel; ilerleme için görünür konum + kalıcı kayıt kontrolü kullan.
- Mevcut test sonucunu tüketici davranışı üzerinden yorumla. Mock echo, source-text araması, gizli kontrolün başlangıç değeri veya sürüm numarası pin'i feature doğrulaması sayılmaz.
- Gerçek yüzey zaten kapsamlı mevcut okuyucu testinde doğrulanıyorsa aynı akışı farklı scriptlerle tekrar kurma. Gerekli tek görsel smoke'u mevcut yüzeyde yap; ilgisiz tüm PDF/EPUB/OCR kombinasyonlarını her iterasyonda dolaşma.
- Başarısızlıkta dar failed case'i düzeltip onu tekrar çalıştır; her küçük editten sonra üç-sürüm tam kontrolüne dönme.

### 3. Aktarım ve son kapı

1. İlk hedef doğrulanınca uygun diğer sürümlerin ortak modül/caller/adapter'larını tamamla.
2. Diğer etkilenen sürümlerde ilgili senaryoyu çalıştır; ilgisiz pahalı model/inference yollarını açma.
3. **Kod feature'ı için bütün editler entegre olduktan sonra, commit öncesi bir kez:**

```sh
npm --prefix local run check
```

`check` mevcut davranış testlerini ve üç sürümün gerçek okuyucu senaryolarını kapsar; hata sıfır olmayan exit code'dur. Son doğrulanan koşu 109 davranış testi + 50 okuyucu senaryosuydu (Node raporunda 3 üst kapsayıcıyla 53); hepsi geçti. Kurulumlar hazırken ve test tarayıcısında BackForwardCache kapalıyken, her sürümde gerçek beş saniyelik link dönüş süresini de bekleyen tam koşu yaklaşık **105 saniye** sürdü; bu süre yeni kurulum/indirme veya gerçek OCR inference süresi değildir, garanti değildir. Her iç döngüde tam koşu yapma; final koşudan sonra davranış değiştiyse etkilenen doğrulamayı yenile.

Sürüm filtreleme `^local:` yalnız Local okuyucu grubunu seçer; Hosting emülatörleri ve VPS grubu açılmaz. `--test-skip-pattern` ile diğer alt vaka adları dışlanarak yalnız kaynak kopyalama/senkronizasyon vakası ve üst kapsayıcısı çalıştırıldı: 2/2 geçti, yaklaşık **6,4 saniye** sürdü. Önce ilgili mevcut Node dosyası, gerekiyorsa tek sürümün okuyucusu, en sonda bir tam `check`: varsayılan sıra budur.

**Yalnız doküman değişikliği:** dosya yollarını/komutları ve iddiaları kontrol et; sırf Markdown değişti diye üç-sürüm suite'i, emülatörleri veya modelleri başlatma. Yeni bir test seçim komutu ekleniyorsa en küçük seçimi bir kez çalıştırıp gerçekten filtrelediğini doğrula.

### 4. Test ortamının bilinen limitleri

- Node: `local/package.json` gereği `^22.13.0 || >=24.0.0`; 22/24 LTS kullan. Native `@napi-rs/canvas` gerçek Node'da çalıştırılmalıdır; araç içindeki Bun Eval native addon yüklemesiyle ürün hatası teşhis etme.
- Gerçek okuyucu testleri Chromium/Puppeteer ister. Hosting vakaları ayrıca resmi Firebase Auth/Firestore/Storage/Hosting emülatörleri ve **Java 21+** ister. Bunlar production OCR bağımlılığı değildir.
- Java'yı global olarak değiştirmek yerine mevcut uygun kurulum için `READER_TEST_JAVA_HOME` kullan; helper Java PATH'ini yalnız alt süreçte ayarlar. İlk kurulum için `local/README.md` içindeki komutları kullan, başarılı kurulumu tekrar etme.
- Bu Windows çalışma makinesinde kurulu taşınabilir Java 21 korunmuştur: `%USERPROFILE%\.cache\reader-test-tools\jdk-21.0.12.1+1-jre`. Hosting testi gerektiğinde `READER_TEST_JAVA_HOME` bu mevcut dizine yönlendirilebilir; yeniden indirme veya global Java değişikliği gerekmez. Diğer makinelerde kendi uygun Java kurulumunu kullan.
- İlk Chromium/JAR indirmesi ve Firebase Web SDK/font kaynakları internet gerektirir. Hosting SDK/emülatör senaryoları local'den daha maliyetlidir; Firebase'e dokunmayan değişiklikte ilk deneme sürümü olarak seçme.
- Storage emülatörü `Content-Range`'i CORS ile açmaz. Mevcut helper gerçek Hosting/Storage yanıtlarını aynı-origin relay üzerinden değiştirmeden aktarır. **Bu, canlı Storage CORS'unun doğrulandığı anlamına gelmez.** CORS feature'ında gerçek tarayıcı/yanıt ayrıca kontrol edilir.
- Firebase emülatör config'i kendi geçici proje kökünde public ve gerçek üretim kuralları kopyalarını kullanır; dışarıdaki/absolute rule yollarını config'e vererek yeni convention kurma. Demo projede çalış, production credential/token devralma.
- Bu runner'da üst `test()` grubunu eşleştirmek alt vakaları da çalıştırır. `^local:` bir sürümün bütün okuyucu vakalarını seçer; regex'e alt vaka adı eklemek otomatik olarak “tek vaka” yapmaz. Mevcut yapıyı bunun için yeniden yazma. Dar döngüde ilgili Node dosyası veya tek sürüm grubu; gerekirse `--test-skip-pattern` ile diğer alt vaka adlarını dışlamak yalnız hedef alt vakayı çalıştırır (Local kaynak kopyalama için üst kapsayıcıyla 2 test seçildi).
- UI otomasyonunda üst okuyucu menüsü hover ile açılır: önce `#reader-nav-hit-area`. Sidebar kapanmasında `aria-hidden` ve gerçek visibility/transition sonunu bekle; dar ekranda yalnız geometrik x konumu güvenilir değildir.
- Kısa ekran testinde kaynak kontrolüne tıklayınca okuyucu `hidden` olup rAF/sync timeout’u oluşuyor → kapanma animasyonundaki Ayarlar panelinin “Orijinal PDF” linki kontrolün önünde kalıp yeni sekme açıyordu → yalnız okuyucu otomasyonu → panelin `aria-hidden=true` ve gerçek `visibility:hidden` durumunu bekle; timeout büyütme veya üretim senkronizasyonuna dokunma → gerçek tıklama hedefi ve açılan PDF sekmesiyle neden doğrulandı.
- EPUB resize kontrolünde max-width nedeniyle iki farklı viewport aynı içerik genişliği/sayfa sayısını verebilir; gerçek reflow oluşturan genişliği seç. Yeniden açma konumunu HUD/metin veya **açılmış** sayfaya-git kontrolünden doğrula; kapalı dialog varsayılanını ya da URL'de `?page` bulunmasını konum sanma.
- EPUB link dönüşünde ekran genişliği değişince ilk görünen paragraf farklı olabilir → eski okuma karakteri yeni sütunun ortasına düşer → Local/VPS/Hosting → kaynak karakteri içeren gerçek sütuna dön; testte eski paragrafın görünürlüğünü ölç, sütunun ilk paragrafının birebir aynı olmasını şart koşma → 1400→600 px gerçek Chromium dönüşünde eski paragrafın yeni sayfada görünmesiyle doğrulandı.
- Hosting soğuk EPUB Range testinde beklenen ilk ağ isteğinin görünmemesi → daha önce kitabı açan yeni link dönüş senaryosu kalıcı Range önbelleğini dolduruyordu → yalnız okuyucu test sırası → soğuk paket/Range indirme senaryosunu aynı EPUB'yi açan dönüş senaryosundan önce çalıştır; gerçek ürün önbelleğini kaldırma → aynı Hosting grubunda soğuk indirme ardından link dönüşü birlikte geçti; son tam `check` de geçti.
- PDF metin yolunda görsellerin kaybolması → `getTextContent()` resim/vektör çizimi taşımaz → Local/VPS/Hosting → ortak `pdf-graphics.mjs` ile OCR’den bağımsız kaynak kırpımı ve metin sırasına ekleme; native cache OCR’den ayrı kalır → gerçek raster/vektör, döndürülmüş/clipping’li ve yalnız görsel sayfalarda kaynak pikseliyle doğrula. PDF.js 6 `recordedBBoxes` sınırları sayfanın 1/256’sına nicelenir; bbox testinde bu dışa taşma payını kabul et, renk/piksel doğrulamasını gevşetme.
- Hosting okuyucu testinde ardışık gezinmelerde Firestore bağlantı/kitap açılış timeout’u → Chromium BackForwardCache açıkken gözlendi; aynı altı vaka kapalıyken geçti → yalnız Puppeteer/emülatör runner → launcher’da `--disable-features=BackForwardCache`, üretim Firebase ayarına veya timeout’a dokunma → gerçek emülatör ve kaynak piksel senaryolarını yeniden çalıştır.
- Hosting’de kütüphaneye dönüşte `currentPdfDoc.destroy is not a function` → PDF.js 6 belge proxy’sinde bu API yok → Hosting → mevcut oturum AbortController’ı `openRangePdf` yükleme task’ını kapatır; proxy’ye ikinci destroy çağrısı yapma → kütüphaneye gerçek dönüş ve görsel sayfanın konumuyla yeniden açılmasını doğrula.
- Hosting’de yerleşik metin yerine sayfa PNG’si → içerik alanındaki beyaz dolgu figür sayılıp paragrafları kapsıyordu; nicelenmiş bbox ince alt çizgiyi de büyütebilir → ortak native çıkarıcı, özellikle tarayıcı yolu → beyaz dolgu figür tohumu değildir; ince çizgi eşiğinde 1/256 bbox dışa taşmasını çıkar → gerçek Circe sayfasında 5 metin bloğu/0 PNG ve beyaz dolgulu, alt çizgili resim regresyonuyla doğrula.
- Sayfalar arasında PDF araç şeridi ve VPS'de eski PNG önbelleği → her sayfaya gömülen `.pdf-page-tools` okuma akışını bölüyordu; önceki sürümden kalan native disk önbelleği (`page-N-v15-native.json`) düzeltme öncesi PNG bloklarını sunuyordu → Local ve VPS okuyucu → sayfa şeridi kaldırılıp OCR tetikleyicisi ve durum mesajı yalnız Ayarlar paneline taşındı; `NATIVE_LAYOUT_VERSION = 1` ile eski hatalı native önbellek otomatik geçersiz kılınıp metin olarak yeniden çıkarıldı → Local, VPS ve Hosting okuyucu testleri (33/33) ve gerçek Circe native akışıyla doğrula.
- Kaynak PDF’de doğal tarayıcı seçimi/kopyalaması gerekirken `aria-hidden` tek başına DOM metnini okuyan eklentilere karşı yeterli değildir → Local/VPS/Hosting → ortak `pdf-source-selection.mjs` PDF.js `TextLayer`’ı kapalı ve `aria-hidden` Shadow DOM’da tutar; light-DOM kaynak metni boş, AX ağacında kitap metni tek kopyadır. OCR yalnız gerçek bölge bbox’larıyla atomik seçilir; Hosting’de OCR yoktur → gerçek Chromium’da sözcük seçimi, Ctrl+A/C, yakınlaştırmada seçim ve tek AX metni doğrulandı. Kapalı köklere özel erişim kullanan üçüncü taraf eklentiler için genel engelleme garantisi değildir.
- PDF kaynak seçimi sayfalı modda önceki sayfaya götürüyor → bellekteki kaynak seçimi `window.getSelection()` üretmediğinden Local’in kenar-tıklama gezinmesi kaynak canvas’ını da sayfa çevirme sanıyordu → Local/VPS → mevcut Hosting convention’ıyla `.pdf-page-image-column` gezinme tıklamasından çıkarılır → üç sürümde gerçek çift tıklama, panoya kopyalama ve kaynak/metin kaydırma senaryosu geçti.
- Sayfalı yüzey tam yüksekliğe taşınınca üst PDF satırı seçilemiyor → eski 80px `#reader-nav-hit-area` metnin önünde fare olayını alıyordu → Local/VPS/Hosting → sayfalı modda hotspot 12px üst şeritle sınırlanır; menü hover davranışı korunur → gerçek PDF ilk satırında doğal seçim/panoya kopyalama ve tam yükseklik görüntüsüyle doğrulandı.
- OCR başladığında veya önbellek oluştuğunda iptal ve temizleme seçeneği eksikliği → devam eden sayfa/toplu OCR sırasında düğmeler kilitleniyor, kuyruk durdurulamıyor ve OCR metni native metne geri döndürülemiyordu → Local ve VPS → `clearBookOcrCache` ile native cache ve descriptor korunarak yalnız OCR dosyaları temizlenir, `DELETE /api/books/:id/pdf/ocr` ile kuyruk işleri silinir, `ocrMode` 'off' yapılarak sayfalar native metne rehidrate edilir; UI'da hem geçerli sayfa OCR grubuna hem toplu hazırlama paneline `OCR’yi İptal Et ve Önbelleği Sil` düğmesi eklendi → Local (14/14), VPS (14/14) ve Hosting (13/13) okuyucu testleri ve birim testleriyle (107/107) doğrulandı.
- PDF metin ve OCR modunda paragraf girintisi kaybolması ve kenar boşluğu ayarının işlememesi → layout gruplamasında `indented` bayrağının bloklara aktarılmaması ve CSS'te `--side-padding`'in PDF metin kapsayıcılarına bağlanmaması → Local, VPS ve Hosting → `pdf-layout-core.mjs` içinde çok satırlı/tek satırlı paragrafların ilk satır x0 farkı sütun tabanına göre denetlenip `indented: true` olarak işaretlenir, OCR'de `textBlocks` leading boşluk/tab ile `indented` bayrağını korur, DOM'a `.pdf-text-indented` sınıfı ve `text-indent: 1.8em` eklenir (ilk paragraf, başlık ve TOC girintisiz kalır); `pdf-layout.css`'te `.pdf-page-text` ve text-only mod `var(--side-padding)`'e bağlanır → 109 davranış testi + 41 okuyucu testiyle doğrulandı.
- PDF link çizgileri/vurgularının resim sanılması ve eski native önbellek → Calibre/EPUB dönüştürücülerinin ürettiği vektör link çizgileri/vurguları (`constructPath` #0000ee) `pdf-graphics.mjs` tarafından figür sayılıp metin arasına sahte resim olarak kırpılıyordu; ayrıca `NATIVE_LAYOUT_VERSION = 1` eski önbelleği geçerli saydığı için paragraf girintisi düzeltmesi Circe'de tetiklenmiyordu → Local, VPS ve Hosting → `pdf-graphics.mjs` içinde raster resim içermeyen (`!box.hasImage`) ve link anotasyonlarıyla çakışan vektör bölgeleri figür sayılmaz; `NATIVE_LAYOUT_VERSION = 2` ile eski hatalı native önbellek otomatik geçersiz kılınır → Circe sayfa 7'de 0 sahte resim / 31 temiz metin bloğu ve sayfa 9'da doğru paragraf girintileriyle doğrulandı.

- EPUB’de büyük portreler arasında boş sayfalar ve iki satırlık açıklama sayfaları → inline görselin 40px marjı, kaynak kapsayıcı padding’i ve baseline boşluğu sütunu aşıyor; açıklama/telif `break-after:avoid` zinciri sonraki portreyi de tutmaya çalışıyor → Local/VPS/Hosting → ortak `cloud-reader.js` saf görsel kapsayıcılarını işaretler; yalnız sayfalı modda dikey boşluğu dış kapsayıcıya taşır, görseli block yapar ve yeni görsel öncesi keep zincirini keser; görünür/ölçüm belge aynı kuralları kullanır, düzen anahtarı 6 eski sayfa haritasını geçersiz kılar → gerçek Sapiens bölümünde portreler üç yerine bir fragman, açıklama tek fragman; üç sürümde 1114/640px ekran, tam açıklama, son bölüm ve görselin gerçek alt pikseli regresyonu geçti. Büyük görsel ve açıklaması birlikte sığmıyorsa ayrı sayfalar doğal akışın parçasıdır.
- Hızlı ardışık sayfaya-git otomasyonunda Git tıklaması etkisiz ve dialog açık kalıyor → `.modal-card` 220ms açılış animasyonu sırasında koordinat değişiyor → yalnız okuyucu testi → `jumpTo` kartın çalışan animasyonunun bitmesini bekler; üretim gezinme veya timeout değiştirilmez → aynı dar portre senaryosu üç sürümde geçti.

## Güvenli temizlik ve teslim

- Gerçekten yerini yeni uygulama alan, caller'ı kalmamış eski dosya/kodu kaldır; gereksiz uyumluluk kopyaları bırakma. **Feature dışı “temizlik” veya belirsiz silme yapma.**
- Kullanıcının kitaplarını, `uploads/`, `library.json`, `.env`, Firebase/SSH kimlik bilgilerini, çalışan `.venv-ocr`, modeli ve pahalı indirilen test runtime/cache'lerini silme veya sıfırlama. Kendi izole test verisini gerçek veriden ayır.
- Geçici kendi debug script/servisini kanıttan sonra kaldır/kapat; tekrar kullanılacak kurulu Java/Chromium/model cache'ini debug artığı sanma. Beklenmeyen dosya değişikliğini kullanıcı değişikliği kabul et, üzerine yazma.
- Deployment, birim testin yerine geçmez. Yalnız ilgili ürün/servisi yayınla; hosting feature'ı diye Storage/Firestore kurallarını veya billing'i değiştirme. Kullanıcı commit/push/deploy istemişse bunları ve gözlenen canlı sonucu açıkça bildir.
- Son yanıt: değişen davranışlar, hangi sürümlerde uygulandığı, gerçekten koşulan test/sonuç ve kalan gerçek limit. Çalıştırılmayan kontrolü başarılı gösterme; kalıcı teknik öğrenimi bu dosyaya işle.
