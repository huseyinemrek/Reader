# Edge Reader — Local (Node.js) Sürümü

Bu klasör, yerel ağınızda (Wi-Fi / LAN) veya çevrimdışı (offline) bilgisayarınızda çalışan bağımsız Node.js sunucu sürümüdür.

## Özellikler

- **Yerel Depolama:** Kitaplar ve kapaklar yerel diskte (`uploads/`) saklanır, harici bulut servisine ihtiyaç duymaz.
- **Yerel Veritabanı:** Kitap listesi ve okuma ilerlemesi `library.json` dosyasında tutulur.
- **Ağ İçi Senkronizasyon:** Aynı Wi-Fi ağındaki telefon, tablet veya diğer bilgisayarlardan sunucu IP adresi ile erişilebilir.
- **Sayfa Sayfa ve Kaydırma Modları:** CSS Column tabanlı yatay sayfa modu ve dinamik bölüm pencereli dikey kaydırma modu.
- **EPUB, PDF, HTML Desteği:** Kitap içi arama, sayfa atlama (G kısayolu), metin boyutu, yazı tipi ve tema özelleştirmeleri.
- **Edge Sesli Okuma (TTS):** Cümle düzeyinde vurgulama ve hız ayarı.
- **Yerel PDF OCR:** GLM-OCR ile bölge bazında metin ve LaTeX tanıma; PP-DocLayoutV3 ile başlık, paragraf, algoritma, formül ve görsel yapısının çıkarılması.
- **Sunucu düzen paketi:** EPUB/HTMLZ bölüm metni, CSS ve görsel ölçüleri arka plan worker’ında hazırlanıp diskte saklanır; sayfa hesabı tarayıcıda mevcut ekran/font ayarlarına göre yapılır.
- **Okurken kitap ekleme:** Üst okuyucu menüsündeki `+`, çoklu seçim ve art arda ekleme; kitap adı tooltip’i olan küçük yüzde dairesi, sekme kapanırken bekleyen iş uyarısı.

## Gereksinimler

- [Node.js](https://nodejs.org/) (22.13+ sürümünün 22.x dalı veya 24+; Node.js 24 LTS önerilir)
- npm
- OCR için [uv](https://docs.astral.sh/uv/getting-started/installation/); kurulum komutu ayrı bir Python 3.12 ortamı oluşturur.
- Hızlı OCR için BF16 destekli NVIDIA GPU ve güncel sürücü. CPU yolu da vardır; büyük sayfalar daha yavaştır.

## Kurulum ve Çalıştırma

1. Node.js bağımlılıklarını yükleyin:
   ```bash
   npm install
   ```

2. `.env.example` dosyasını `.env` olarak kopyalayın. Kaynak kod düzenlemek gerekmez:
   ```bash
   cp .env.example .env
   ```
   Firebase kullanacaksanız `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_APP_ID` ve ilgili diğer alanları kendi projenize göre doldurun. Firebase yapılandırması yoksa tek kullanıcılı yerel mod kullanılır. Önceden oluşturulmuş `firebase-config.js` dosyaları da okunur. `DISABLE_AUTH=true` yalnız güvenilir ev/LAN kullanımı içindir.

3. PDF OCR kullanacaksanız ortamı ve modelleri hazırlayın (isteğe bağlı):
   ```bash
   npm run ocr:setup
   ```
   Sistem GPU ve mimariyi otomatik algılar:
   - **CUDA Destekli NVIDIA GPU (x64):** Otomatik olarak CUDA 12.8 destekli PyTorch kurulur.
   - **CPU / ARM64 (örn. Oracle Cloud Ampere A1, Apple Silicon, VPS):** Standart CPU PyTorch kurulur (`npm run ocr:setup:cpu`).
   Python ortamı `local/.venv-ocr/` altına kurulur. İlk kurulum modelleri indirmek için internet bağlantısı ve disk alanı gerektirir.
4. Sunucuyu başlatın:
   ```bash
   npm start
   ```

5. Tarayıcınızda açın:
   - Bilgisayarınızdan: `http://localhost:3000`
   - Aynı yerel ağdan: `http://<YEREL_IP>:3000`
---

## VPS sürümü

İnternete açık, 7/24 kullanım ve isteğe bağlı ev GPU worker için [vps/README.md](../vps/README.md) kullanın. VPS sürümü yerel sürümün tüm okuyucu özelliklerini ve kendi CPU OCR motorunu korur; ağır sayfalar kalıcı bir arka plan kuyruğunda işlenir. Ev worker seçilmesi ek bir özelliktir, VPS OCR’nin yerine geçmez.

Mevcut `local/` kitapları ve önbellekleri yerinde kalır; VPS’ye taşıma kılavuzundaki kopyalama adımları özgün veriyi silmez. GitHub Actions artık `vps/` giriş noktasını kullanır.

## EPUB görselleri ve kitap kaynakları

EPUB içindeki görsel, SVG bağlantısı, CSS arka planı ve font yolu kendi bölüm/stylesheet konumuna göre çözülür. Firebase oturumu kullanılıyorsa korumalı aynı-origin kaynaklara güncel kullanıcı token’ı eklenir; bu davranış hem yerel hem VPS modunda geçerlidir. Dış originlere kimlik bilgisi gönderilmez. Okuyucu içindeki kaynak CSS görselleri korunur; sayfa ölçümünün görünmez iframe’inde dekoratif görseller indirilmez.

### Düzen paketi ve sayfa hesabı

Yeni EPUB/HTMLZ yüklemesi arka plan üretimini başlatır; eski diskteki kitap için ilk açılış başlatır. Tek Node worker’ı bölüm metinlerini, CSS’yi ve görsel boyutlarını işler; HTTP olay döngüsü paketin üretilmesini beklemez. Paket görsel/font dosyalarının asıl byte’larını içermez. Tarayıcı bütün bölüm metinlerini mevcut düzenle ölçer; yalnız okunan alandaki EPUB görsellerini yükler. Sayfa sayısı basılı kitap numarası değildir; ekran veya font ölçüleri değişince yeniden hesaplanır.

Kimlik doğrulamalı `GET /api/books/:id/layout`, hazırlanırken `202 {status:'pending'|'processing',sourceVersion}`, hazırken `200` ZIP ve `X-Reader-Source-Version`, üretim başarısızsa `422 {status:'failed',sourceVersion,error}` döndürür. Dosya/üretici sürümü değişmedikçe başarısız arşiv kendiliğinden tekrar işlenmez. Hazır paket `DATA_DIR/layout-cache/<bookId>/<sourceVersion>/` altında yeniden başlatmada kullanılır; kaynak değişikliği ve kitap silme ilgili cache’i iptal eder. Bu dizin kişisel veridir ve Git’e dahil edilmez.

### Sekmelik yükleme kuyruğu

Okuyucunun üst menüsünü açıp `+` ile kitap seçin. Seçili dosyalar sırayla yüklenir; yeni seçim mevcut kuyruğa eklenir. Hazırlama/sonlandırma aşaması belirsiz, aktarım aşaması gerçek byte yüzdesidir; `%100` ancak kitap kaydı tamamlanınca gösterilir. Sayfa çevirebilir, başka kitaba geçebilir ve ayar değiştirebilirsiniz; tamamlanma yalnız kütüphaneyi yeniler, okuyucuyu sıfırlamaz.

Hatalı iş sonraki kitabı durdurmaz; daire üzerinden yeniden deneme/listeden kaldırma kullanılabilir. Bekleyen veya çalışan iş varsa sekme kapatma/yenilemede tarayıcı uyarısı açılır; uyarı geçilip sekme kapanırsa kuyruk geri getirilmez. Tamamlanmış kitaplar diskte kalır. Oturum değiştirme/çıkış eski hesabın bekleyen işlerini iptal eder. Local aynı makinedeki OCR motorunu kullanır; VPS/ev worker hazırlama paneli local arayüzünde gösterilmez.

## PDF ve OCR

PDF dosyasını **Yeni Kitap Ekle** ile yükleyin. Orijinal sayfa tarayıcıda PDF.js ile doğrudan PDF kaynağından çizilir; OCR sonucunu beklemez. Yakınlaştırma düğmeleriyle %500'e kadar büyütebilir, sayfaya sığdırabilir ve görüntüyü kaydırabilirsiniz. Görünen alan cihaz piksel oranında yeniden çizilir; her çizim parçası en fazla 1024 × 1024 fiziksel pikseldir. Kaynak PDF taranmış bir fotoğrafsa renderer kaybolmuş ayrıntıları geri getiremez.

**Sığdır** bütün kaynak sayfayı görünür alana sığdırır; yanındaki **Doldur** sütun genişliğini kullanır ve ekran/ayırıcı değişince yeniden ölçülür. Metin tarafını kaydırınca büyütülmüş PDF aynı sayfanın başlangıç/orta/son oranını izler; paragrafla birebir eşleştirme değildir. PDF’yi elle kaydırmak metni hareket ettirmez; eşzamanlama sonraki metin kaydırmasında devam eder.

Kaynak PDF’yi yatayda ortalama/sağa kaydırma oranı sonraki ve önceki sayfalarda korunur; farklı sayfa/sütun genişliği aynı oranı kullanır. Bu tercih açık kitap oturumuna aittir. Sayfalı mod ekranın üstünden altına uzanır; yan koyu alanlar kalır, en sağdaki okuyucu scrollbar’ı gizlenir ama kaydırma çalışır.

Kaynak PDF üzerinde tarayıcının doğal fare seçimi/sözcüğe çift tıklaması, **Ctrl/Cmd+C** ve sağ tık menüsündeki **Kopyala** kullanılabilir; ayrı Kopyala düğmesi yoktur. PDF alanı odaktayken **Ctrl/Cmd+A** yalnız kaynak sayfanın metnini seçer. PDF.js `TextLayer` kapalı, `aria-hidden` Shadow DOM içinde tutulur: kaynak viewport’un light-DOM metni boş kalır ve erişilebilirlik ağacı ikinci kitap metni içermez. Yerleşik metinde karakter hizasını PDF.js sağlar; gerçek OCR çıktısında yalnız bilinen bölge kutuları atomik seçilir, formüller LaTeX olarak kopyalanır. OCR’sız taramada metin uydurulmaz.

**Ayarlar → PDF Görünümü** üç düzen sunar: **Yalnız metin**, **Metin sağda + PDF solda**, **Metin solda + PDF sağda**. İki sütun arasındaki ayırıcıyı fare/dokunmayla sürükleyin; odaklanan ayırıcı sol/sağ okları, Shift ile daha büyük adımları ve Home/End sınırlarını da destekler. Görünüm ve metin genişliği tarayıcıda saklanır; sayfa geçişi ve yeniden açma oranı korur. Dar ekranda yalnız metin görünümü yatay karşılaştırma genişliğini zorlamaz.

Yerleşik PDF metninde italik/oblik, font ağırlığı ve göreli boyut farkları metin parçalarıyla korunur. Kullanıcının seçtiği font, renk ve temel boyut override’ları geçerli kalır; kaynak vurgu bu seçilmiş stilin üzerine uygulanır, kaynak font zorla dayatılmaz. Font bilgisi bulunmayan taranmış/vektör gövdeli OCR çıktısında italik veya font adı tahmin edilmez.

PDF içindeki resimler ve vektör çizimler OCR’den bağımsız olarak kaynak sayfadan kırpılır; **Yalnız metin** düzeninde de metin arasındaki kaynak konumlarına yerleştirilir. Döndürme, clipping ve maskeler PDF.js çizimiyle korunur; kapak/görsel sayfası boş metin uyarısıyla değiştirilmez. Kırpım içinde zaten görünen etiketler metinde ikinci kez yazılmaz. Local/VPS bu sonucu kaynak dosyası değişince geçersizleşen ayrı `-native` PNG/JSON önbelleğinde tutar; OCR sonucu ve tercihiyle karışmaz. Mevcut kitapları yeniden yüklemek gerekmez.

**İçindekiler** PDF’nin yer işaretlerinden doğrudan yüklenir; alt başlıklar ve adlandırılmış/sayfa referanslı hedefler korunur. Bağlantı doğru PDF sayfasına gider. Kaynak PDF’de yer işareti kaydı yoksa bu açıkça belirtilir; uydurma bölüm listesi üretilmez.

PDF türü kapaktan değil **kitap düzeyinde** belirlenir: boş/görsel başlangıç sayfalarından sonra gelen metin de incelenir. Yerleşik paragraf, kısa cümle veya grafik çizimleri içermeyen kısa dijital metin bulunduğunda kitap yerleşik metinle okunur. Vektör çizimine dönüşmüş gövde ve yalnız grafik etiketleri OCR gerektirir. Sınıflandırma PDF kaynağına ve sınıflandırıcı sürümüne bağlı önbelleğe alınır; model yüklemez veya sayfa rasterleştirmez.

**Ayarlar → Bu kitap için OCR** tercihi kitapla birlikte kaydedilir:

- **Otomatik:** Yerleşik metinli kitapta OCR çalışmaz; boş kapak olduğu gibi gösterilir. Taranmış/vektör gövdeli kitapta ziyaret edilen sayfalar OCR kullanır.
- **Açık:** Yerleşik metin bulunsa bile ziyaret edilen sayfalar OCR kullanır.
- **Kapalı:** PDF’nin kendi metni ve kaynak görselleri gösterilir; hazır OCR önbelleği de bu tercihi geçersiz kılamaz. Bekleyen/işlenen OCR nesilleri iptal edilir.

**Geçerli sayfayı OCR yap / yeniden üret** veya sayfadaki aynı düğme, **Kapalı** seçiliyken bile yalnız o sayfa için açık istek gönderir; kitap tercihini değiştirmez. Sayfa yeniden açıldığında kitap tercihi yeniden geçerlidir. Karma kitapların görsel sayfalarında da bu düğmeyi kullanabilirsiniz. Yerel **Açık** tüm ziyaret edilen sayfaları yerel motorla işler; VPS’de tüm kitap/sayfa aralığı hazırlama ayrıca ayarlardaki panelden yapılır.

### Yapı önce, uygun büyüklükte pencereler sonra

1. PP-DocLayoutV3 genel sayfa yapısını ve kaynak koordinatlarını çıkarır; bu aşamada bütün sayfanın metni tek bir GLM çağrısıyla okunmaz.
2. **Tüm metinler** — başlıklar, paragraflar, açıklamalar ve algoritma satırları — kendi kaynak çerçevelerinden okunur. Uzun bloklar ve algoritmalar boş kaynak satırlarından bölünür; harf veya alt/üst indis üzerinden kesilmez. Algoritma içindeki metin ve formül bölgeleri ayrıca sınıflandırılır.
3. Her pencere PDF kaynağından yeniden çizilir. Kaynak mürekkep satırlarının yüksekliği yakınlaştırmayı belirler; metinde yaklaşık 48, formülde 64 piksel hedeflenir. Yakınlaştırma en fazla 4 kattır; beyaz bağlam dahil pencere 1,6 milyon pikseli ve 2400 piksellik kenarı aşmaz. Komşu çerçevenin mürekkebi beyaz kenarlığa taşınmaz. Taranmış PDF'de bu işlem fotoğrafta bulunmayan ayrıntı üretmez.
4. GLM-OCR aynı kalıcı süreçte `Text Recognition:` ve `Formula Recognition:` görevleriyle parçaları okur. En fazla dört pencere birlikte işlenir; aynı görüntü/görev/model sonucu sınırlı bölge önbelleğinden kullanılır.
5. Paragraf içindeki küçük formül pencereleri ayrı LaTeX çağrılarıyla okunur. Sonuç ancak özgün metindeki matematik aralığıyla güvenli eşleşiyorsa o konuma yerleştirilir; noktalama ve çevredeki metin korunur. Belirsiz eşleşmede sembol veya konum tahmin edilmez; mevcut paragraf korunur ve arayüzde kaynak karşılaştırma uyarısı gösterilir.

Metin, satır içi matematik, numaralı denklemler ve algoritma satırları ayrı seçilebilir öğelerdir. Fiziksel OCR satırları paragraf içinde boşlukla birleştirilir; paragraf sınırları, algoritma/kod girintileri ve açık satır yapısı korunur. Bu davranış seçilebilir metin ve sesli okuma metnine de uygulanır. LaTeX KaTeX ile çizilir ve kopyalanabilir; açık çok sözcüklü `\mathrm` metinleri sözcük aralıklarını korur, matematiksel çarpımlar değiştirilmez. Denklem karakterleri sesli okuma metnine eklenmez. Grafik ve tablolar kaynak görüntü olarak korunur; tablo hücrelerini semantik HTML’ye dönüştürme desteği yoktur. OCR çıktısı gerçek PDF font metrikleri değildir.

- Belgeler buluta gönderilmez. Sabit sürümlü GLM-OCR ve PP-DocLayoutV3 modelleri ilk hazırlamada indirilir; hazır modellerle yerel çıkarım yapılır.
- Sayfalar ihtiyaç oldukça işlenir. Kalıcı model süreci ve tek işlem kuyruğu yeniden model yüklemeyi önler; hazır sayfa önbelleği bu kuyruğu beklemez.
- Sonuçlar `uploads/pdf/<kitap-id>/page-<N>-v15.*` altında saklanır. Eski işlem hatlarının önbelleği yeniden kullanılmaz; sürümlü dosya adları eski sunucu süreçlerinin sonuçlarıyla çakışmaz. Kitap silinince ilgili önbellek de silinir.
- `GET /api/books/:id/pdf` → `{totalPages,sourceVersion,textLayer:'native'|'scanned',ocrMode:'auto'|'on'|'off',automaticOcr}`. `POST /api/books/:id/pdf/ocr` gövdesi `{mode:'auto'|'on'|'off'}` kitap tercihini kaydeder ve güncel tanımı döndürür.
- `GET /api/books/:id/pdf/pages/:page` seçilebilir `blocks`, kaynak (`native`/`ocr`), `engine`, `device`, `modelRevision`, `elapsedMs`, `pipelineVersion`, `metrics`, `qualityLimits` döndürür. OCR sonuçları kaynak görsel adresini de içerir; yerleşik metin okuması görsel üretmez. `?ocr=0` yalnız yerleşik metni, `?ocr=1` açık yeniden çıkarımı ister. VPS’de dönen `jobId` için `?ocrJob=<id>` aynı nesli izler; iptal edilen/değiştirilen iş 410 döndürür. GLM için `confidence` değeri `null`dır; uydurma doğruluk yüzdesi verilmez.
- OCR kusursuz değildir: geçerli LaTeX doğru denklem garantisi vermez. Küçük semboller, grafik etiketleri ve karmaşık düzen için orijinal sayfa esas alınmalıdır. GLM'nin model kartı Türkçe için ayrı doğruluk garantisi sunmaz.

Ortak OCR motoru `local/`, `vps/` ve isteğe bağlı `compute/` tarafından kullanılır; Firebase `hosting/` sürümünde yalnız yerleşik PDF metni ve kaynak görüntü vardır, OCR çalışmaz.

### GPU kullanımı

Metin ve formül tanıma aynı GLM-OCR modelini kullanır. `OCR_DEVICE=auto` kullanılabilir CUDA GPU'yu, yoksa CPU'yu seçer. CUDA yolunda BF16/SDPA, CPU yolunda FP32/SDPA kullanılır; CPU iş parçacığı sayısı en fazla dörttür. `cuda` GPU'yu zorunlu kılar ve başlatma hatasını gizlemez; `cpu` GPU kullanımını kapatır. Seçilen cihaz ve model sürümü sonuçla birlikte arayüzde görünür.

`OCR_REQUEST_TIMEOUT_MS` yavaş CPU sayfaları için model isteği süresini ayarlar; örnek değer 30 dakikadır. VPS’de bu süre boyunca HTTP isteği açık kalmaz. Yerel sürüm aynı makinede tamamlanan sonucu doğrudan döndürür.

```powershell
$env:OCR_DEVICE = "cuda"
npm start
```

Kaynak kod veya cihaz ayarı değişince çalışan Node.js sunucusunu yeniden başlatın. Eski API işlem hattı saptanırsa okuyucu sonucu yeni modelden gelmiş gibi göstermeyip yeniden başlatma uyarısı verir.

### WR-1.pdf ile doğrulama

Örnek dosya `Microsoft: Print To PDF` tarafından üretilmiş; şifreleme ve kopyalama izni kısıtlaması yoktur. Sekiz sayfada metin/font kaydı yok, dört sayfada yalnızca grafik etiketleri vardır. Gövde harfleri vektör çizim yollarına dönüştürülmüştür: keskin yakınlaştırma mümkündür fakat metin çıkarmak için OCR gerekir.

RTX 4070 SUPER üzerinde gerçek 8. sayfa 28 kaynak penceresinden okundu: 14 metin ve 14 formül; dokuz satır içi formül güvenli konum bilgisiyle birleştirildi. Hazır modelle uçtan uca çıkarım 13,9 saniye, disk sayfa önbelleği 1 ms sürdü. Bağımsız pencere ölçümü 15,2 saniye; aynı 28 pencereyle ikinci çağrı 0,63 saniye ve 28 bölge önbelleği isabeti verdi. İlk tarayıcı isteği model yüklemesi dahil 33 saniyeydi. Ölçümler bu makineye aittir; daha az ayrıştıran önceki GLM hattı 8,39 saniyeydi. Yeni hat daha fazla kaynak kontrolü yapar, soğuk çıkarımın her durumda hızlandığı iddia edilmez.

Algoritma başlığı, başlatma, koşullu seçim, ödül/sayaç/değer güncellemeleri, `1/n`, `alpha_t(a)`, `Q_{n+1}`, epsilon ve (2.5)/(2.6) numaraları kaynakla karşılaştırıldı. İki belirsiz bölge korunup açık uyarıyla gösterildi; formül modelinin yanlış harf eklediği koşul satırı doğru bağlam sonucunun üzerine yazılmadı. Algoritma LaTeX'indeki çok sözcüklü `mathrm` metinleri sözcük aralıklarını koruyan `text` olarak aktarılır; tek harfli matematik çarpımları değiştirilmez. %500 yakınlaştırma ve dar ekran kaynak görünümü önceki renderer doğrulamasında kontrol edildi.

Kaynak pencere sınırlarını, yerel PDF metnini ve karma metin/LaTeX sözleşmesini doğrulamak için:

```bash
npm test
```

### RLbook2018 ile bu değişikliğin doğrulaması

Yerel kütüphanedeki RLbook2018 örneğinin 3, 4, 8 ve 11. PDF sayfaları gerçek CUDA OCR ile yeniden işlendi. Normal paragrafların fiziksel satırları birleştirildi; algoritma satırları ve girintileri korundu. (2.1) kesrindeki uzun sözcüklü metin, aynı kaynak penceresinden bağlamlı metin göreviyle yeniden okunarak doğal sözcük aralıklarıyla çizildi.

11. sayfadaki (2.10) kökü OCR LaTeX'inde zaten vardı. Sayfalı okuyucunun genel SVG boyutlandırması KaTeX kökünü de küçültüyordu; KaTeX SVG'leri bu kuraldan çıkarıldı. Aynı tarayıcı görünümünde eski kuralla 0,67 px olan kök yüksekliği düzeltilmiş kuralla 73,9 px oldu. Hem kaydırmalı hem sayfalı görünümde kontrol edildi; denkleme kitaba özel bir kök eklenmedi.

Gerçek Oracle Ubuntu 26.04 ARM64 VPS'ye taşınan mevcut 12 sayfalık kitap, evdeki RTX 4070 SUPER işçisi tarafından şifreli outbound SSH üzerinden yaklaşık 128 saniyede tamamlandı. Her sayfanın OCR süresi 5,4–14,9 saniyeydi; kuyruk 12 `completed`, sıfır `pending/processing/failed` durumuna geldi ve işçi `204` yanıtında kapandı. Bunlar bu kitap ve donanım için ölçümlerdir, genel performans garantisi değildir. Ortak davranış testlerinin 50'si geçti.

Aynı gerçek Ampere VPS'de, metin katmanı olmayan ayrı tek satırlık taranmış PDF CPU yolundan da işlendi: ilk sayfa isteği 60 ms'de `202 pending` döndü, tamamlanınca `200` ve `CPU FP32 SDPA` metadata ile `CPU OCR is available.` metni geldi. Arayüzde kaynak görüntü ve seçilebilir sonuç birlikte görüldü; çıkarım metadata süresi 11,6 saniyeydi. Bu küçük CPU smoke dosyası, RLbook2018 sayfa süresi ölçümü değildir.

### Kitap düzeyinde OCR ve PDF düzeni doğrulaması

Gerçek Circe PDF’sinin ilk beş sayfası boş/görsel olmasına rağmen kitap yerleşik metinli tanındı; kapak OCR işi oluşturmadı ve 9. sayfadaki bölüm PDF metninden okundu. Tek sayfalık 19 karakterlik dijital PDF de OCR’sız okundu. RLbook2018 taranmış/vektör gövdeli tanındı ve otomatik OCR varsayılanını korudu.

Gerçek tarayıcıda ayarlar içindeki hazırlama paneli, üç düzen, iki yönde fare sürüklemesi, klavye ayarı, yeniden açmada oran, sayfalı/kaydırmalı okumada sayfa konumu ve 390 px ekranda yalnız metin görünümü kontrol edildi. OCR kapalıyken tek sayfa GPU isteği tamamlandı; yeniden açma hazır OCR yerine yerleşik metne döndü. İzole VPS giriş noktasından bütün kitap kapsamıyla gönderilen tek sayfalık tarama CPU FP32 yolunda `A scanned reading page.` olarak tamamlandı. Ortak davranış testlerinin 55’i geçti.

### EPUB görsel, PDF vurgu ve içindekiler regresyonları

Gerçek Firebase oturumuyla bağımsız local ve VPS giriş noktalarında ReZero 28 kapağı yüklendi; token’lı EPUB görseli 200, kimliksiz aynı kaynak 401 döndürdü. Sapiens’in bölüm içindeki `f079-01.jpg` görseli de korumalı kaynaktan çizildi. Circe’nin 36 yer işareti yüklendi; 9. sayfadaki italik sözcükler kullanıcı fontuyla korundu. İç içe PDF yer işaretinden 3. sayfaya geçiş ve kullanıcının Inter / 32 px / özel renk seçimine rağmen italik-kalın vurgunun korunması gerçek tarayıcıda kontrol edildi. Ortak davranış testlerinin 60’ı geçti.

### Commit öncesi kalıcı regresyon kontrolü

Özgün, küçük PDF vakaları `../tests/fixtures/` altında saklanır; kişisel kitaplar ve Firebase kimlik bilgileri bu vakalara dahil değildir. `typography-outline.pdf` normal/italik/oblik/kalın/monospace metin, büyük başlık, küçük dipnot, iç içe yer işaretleri ve adlandırılmış hedef içerir. `without-outline.pdf` yer işareti olmayan sınırı kontrol eder. PDF’ler doğrudan test verisidir; testleri çalıştırmak için Python veya OCR modeli gerekmez. `create-pdf.py` yalnız yeniden üretmek içindir ve PyMuPDF gerektirir.

Depo kökünden ilk kurulum:

```sh
npm --prefix local ci
npm --prefix local exec -- puppeteer browsers install chrome
npm --prefix local exec -- firebase setup:emulators:firestore
npm --prefix local exec -- firebase setup:emulators:storage
```

Gerçek hosting vakaları resmi Auth, Firestore, Storage ve Hosting emülatörleriyle çalışır; **Java 21+** gerekir. Java’nın PATH’teki sürümünü değiştirmek istemiyorsanız yalnız bu komut için `READER_TEST_JAVA_HOME` ayarlayın:

```powershell
$env:READER_TEST_JAVA_HOME = "C:\path\to\jdk-21"
npm --prefix local run check
```

Chromium kurulumu, ilk emülatör JAR indirmeleri ve gerçek Firebase Web SDK / font dosyaları için internet erişimi gerekir. Python/GPU/OCR modelleri bu okuyucu regresyonlarının ön koşulu değildir.


Her commit öncesi:

```sh
npm --prefix local run check
```

`check`, ortak Node davranış testlerini, hosting Range/layout/upload testlerini ve `tests/reader.test.cjs` gerçek Chromium okuyucu kontrollerini birlikte çalıştırır. Yalnız okuyucu vakaları için `npm --prefix local run test:reader` kullanın. Local ve VPS ayrı geçici veri dizinlerinde, hosting izole `demo-reader-regression` projesinin resmi emülatörlerinde çalışır; hepsi yalnız `127.0.0.1` kullanır. Üretim kütüphanesi, oturumları ve kuralları değiştirilmez. Storage emülatörü `Content-Range` başlığını CORS ile açmadığından test yönlendirmesi Hosting ve gerçek Storage yanıtlarını tek origin’de aktarır; byte, Range, durum veya yanıt başlığı değiştirmez. Canlı Storage CORS doğrulamasının yerini almaz.

PDF vurgu/göreli boyutları ve kullanıcı override’ları, kaynak yer işaretleri, gerçek kaynak canvas mürekkebi, üç düzen/ayırıcı/zoom, EPUB paketinden resimler indirilmeden sayfa hesabı, görünen resmin gerçek pikseli, yeniden boyutlandırma/font değişimi sonrası konum/ilerleme ve okurken iki gerçek dosya yüklenmesi kontrol edilir. Başarısızlık sıfır olmayan çıkış kodu verir. VPS üretim kurulumunda `--omit=dev` korunur; Puppeteer, Firebase CLI, Chromium ve Java üretim OCR bağımlılığı değildir.

Bu değişikliklerin tam kontrolünde 102 davranış testi ve üç sürümde 24 gerçek okuyucu senaryosu başarılı oldu; Node okuyucu raporu üç üst kapsayıcıyla birlikte 27/27 geçti.
