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

2. PDF OCR kullanacaksanız ortamı ve sabit sürümlü modelleri hazırlayın:
   ```bash
   npm run ocr:setup
   ```
   Python ortamı `local/.venv-ocr/` altına kurulur; CUDA 12.8 destekli PyTorch paketleri kendi çalışma zamanı kitaplıklarını içerir. Ayrı CUDA Toolkit kurulumu gerekmez. İlk kurulum internet ve model indirmeleri için disk alanı gerektirir.

3. (İsteğe bağlı) `.env.example` dosyasını `.env` olarak kopyalayın. `PORT` ve `OCR_DEVICE` ayarlarını değiştirebilirsiniz.

4. Sunucuyu başlatın:
   ```bash
   npm start
   ```

5. Tarayıcınızda açın:
   - Bilgisayarınızdan: `http://localhost:3000`
   - Telefon veya tabletinizden: Konsolda gösterilen yerel IP adresi (örn. `http://192.168.1.X:3000`)

## PDF ve OCR

PDF dosyasını **Yeni Kitap Ekle** ile yükleyin. Orijinal sayfa tarayıcıda PDF.js ile doğrudan PDF kaynağından çizilir; OCR sonucunu beklemez. Yakınlaştırma düğmeleriyle %500'e kadar büyütebilir, sayfaya sığdırabilir ve görüntüyü kaydırabilirsiniz. Görünen alan cihaz piksel oranında yeniden çizilir; her çizim parçası en fazla 1024 × 1024 fiziksel pikseldir. Kaynak PDF taranmış bir fotoğrafsa renderer kaybolmuş ayrıntıları geri getiremez. Seçilebilir metin sağda hazırlanır; dar ekranlarda karşılaştırma alanı yatay kaydırılır.

En az 200 harf/rakam içeren, bozuk karakter barındırmayan PDF metni doğrudan kullanılır. Metin yoksa veya yalnızca kısa grafik etiketleri varsa yerel belge OCR hattı çalışır. **Bu sayfayı OCR ile oku** düğmesi mevcut sonucu atlayarak sayfayı yeniden işler; değişmemiş bölge görüntüleri model önbelleğinden kullanılabilir.

### Yapı önce, uygun büyüklükte pencereler sonra

1. PP-DocLayoutV3 genel sayfa yapısını ve kaynak koordinatlarını çıkarır; bu aşamada bütün sayfanın metni tek bir GLM çağrısıyla okunmaz.
2. **Tüm metinler** — başlıklar, paragraflar, açıklamalar ve algoritma satırları — kendi kaynak çerçevelerinden okunur. Uzun bloklar ve algoritmalar boş kaynak satırlarından bölünür; harf veya alt/üst indis üzerinden kesilmez. Algoritma içindeki metin ve formül bölgeleri ayrıca sınıflandırılır.
3. Her pencere PDF kaynağından yeniden çizilir. Kaynak mürekkep satırlarının yüksekliği yakınlaştırmayı belirler; metinde yaklaşık 48, formülde 64 piksel hedeflenir. Yakınlaştırma en fazla 4 kattır; beyaz bağlam dahil pencere 1,6 milyon pikseli ve 2400 piksellik kenarı aşmaz. Komşu çerçevenin mürekkebi beyaz kenarlığa taşınmaz. Taranmış PDF'de bu işlem fotoğrafta bulunmayan ayrıntı üretmez.
4. GLM-OCR aynı kalıcı süreçte `Text Recognition:` ve `Formula Recognition:` görevleriyle parçaları okur. En fazla dört pencere birlikte işlenir; aynı görüntü/görev/model sonucu sınırlı bölge önbelleğinden kullanılır.
5. Paragraf içindeki küçük formül pencereleri ayrı LaTeX çağrılarıyla okunur. Sonuç ancak özgün metindeki matematik aralığıyla güvenli eşleşiyorsa o konuma yerleştirilir; noktalama ve çevredeki metin korunur. Belirsiz eşleşmede sembol veya konum tahmin edilmez; mevcut paragraf korunur ve arayüzde kaynak karşılaştırma uyarısı gösterilir.

Metin, satır içi matematik, numaralı denklemler ve algoritma satırları ayrı seçilebilir öğelerdir. LaTeX KaTeX ile çizilir ve kopyalanabilir; denklem karakterleri sesli okuma metnine eklenmez. Grafik ve tablolar kaynak görüntü olarak korunur; tablo hücrelerini semantik HTML'ye dönüştürme desteği yoktur. PDF metin katmanındaki font oranları gerçek kaynak ölçülerinden gelir; OCR çıktısı gerçek PDF font metrikleri değildir.

- Belgeler buluta gönderilmez. Sabit sürümlü GLM-OCR ve PP-DocLayoutV3 modelleri ilk hazırlamada indirilir; hazır modellerle yerel çıkarım yapılır.
- Sayfalar ihtiyaç oldukça işlenir. Kalıcı model süreci ve tek işlem kuyruğu yeniden model yüklemeyi önler; hazır sayfa önbelleği bu kuyruğu beklemez.
- Sonuçlar `uploads/pdf/<kitap-id>/page-<N>-v14.*` altında saklanır. Eski işlem hatlarının önbelleği yeniden kullanılmaz; sürümlü dosya adları eski sunucu süreçlerinin sonuçlarıyla çakışmaz. Kitap silinince ilgili önbellek de silinir.
- `GET /api/books/:id/pdf/pages/:page` seçilebilir `blocks`, kaynak (`native`/`ocr`), `engine`, `device`, `modelRevision`, `elapsedMs`, `pipelineVersion`, `metrics`, `qualityLimits` ve kaynak görsel adresini döndürür. `?ocr=1` yeniden çıkarım ister. GLM için `confidence` değeri `null`dır; uydurma doğruluk yüzdesi verilmez.
- OCR kusursuz değildir: geçerli LaTeX doğru denklem garantisi vermez. Küçük semboller, grafik etiketleri ve karmaşık düzen için orijinal sayfa esas alınmalıdır. GLM'nin model kartı Türkçe için ayrı doğruluk garantisi sunmaz.

Bu destek yalnızca `local/` sürümündedir; Firebase hosting tarafı değişmez.

### GPU kullanımı

Metin ve formül tanıma aynı GLM-OCR modelini kullanır. `OCR_DEVICE=auto` kullanılabilir CUDA GPU'yu, yoksa CPU'yu seçer. CUDA yolunda BF16/SDPA, CPU yolunda FP32/SDPA kullanılır; CPU iş parçacığı sayısı en fazla dörttür. `cuda` GPU'yu zorunlu kılar ve başlatma hatasını gizlemez; `cpu` GPU kullanımını kapatır. Seçilen cihaz ve model sürümü sonuçla birlikte arayüzde görünür.

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
