# VPS okuyucu — Ubuntu 26.04 / Oracle Ampere ARM64

VPS sürümü `../local/server.js` ve aynı istemciyi kullanır: kitap yükleme/silme, kütüphane, EPUB kaynakları, PDF görüntüleme, okuma konumu ve tarayıcı TTS özellikleri ayrı bir uygulamada yeniden yazılmaz. `hosting/` Firebase sürümü ve bağımsız `local/` sürümü değişmeden ayrı kullanım seçenekleridir.

## Kurulum

Node.js 24 LTS önerilir; mevcut Node.js 22.13+ da desteklenir. Ubuntu 26.04 Ampere `aarch64` makinesinde CUDA kurmayın: VPS kendi CPU OCR motorunu korur. İsteğe bağlı NVIDIA CUDA BF16 işçisi başka bilgisayarda çalışır.

Depo kökünden (Windows PowerShell ve Linux'ta aynı npm komutları):

```sh
npm --prefix local ci --omit=dev
npm --prefix vps run ocr:setup
npm --prefix vps start
```

`ocr:setup` için `uv` PATH üzerinde bulunmalıdır. Kurulum CPU PyTorch paketini ve ortak belge OCR modelini `local/.venv-ocr` içine kurar. Zaten çalışan bu ortamı yeniden oluşturmanız gerekmez. Windows'ta Python yolu `local/.venv-ocr/Scripts/python.exe`, Linux'ta `local/.venv-ocr/bin/python` olur. Bağımlılıklar yalnızca `local/node_modules` içine kurulur; kopya npm bağımlılık ağacı veya kaynak kod düzenlemesi gerekmez. Aynı kurulumun kısayolu `npm --prefix vps run deps` komutudur.

Önce `vps/.env.example` dosyasını `vps/.env` olarak kopyalayın ve Firebase web uygulaması ayarlarını girin. `.env`, sunucuyu hangi klasörden başlatırsanız başlatın okunur. Mevcut `local/firebase-config.js` yedek yapılandırması da desteklenir; Firebase olmayan VPS yapılandırması anonim bir genel kütüphaneye dönüşmez, açıklayıcı 503 hatası verir.

| Değişken | Varsayılan / kullanım |
| --- | --- |
| `HOST`, `PORT` | Yeni kurulumda `127.0.0.1`, `3000`; doğrudan mevcut genel erişim için `HOST=0.0.0.0` |
| `DATA_DIR` | `vps/`; bağımsız `uploads/`, `library.json`, `compute-jobs.json` |
| `READER_ENV_FILE` | `vps/.env`; isteğe bağlı başka env dosyası |
| `OCR_PYTHON` | Mevcut ortak `local/.venv-ocr` Python yolu |
| `OCR_REQUEST_TIMEOUT_MS` | `1800000` (30 dakika); gözlenen 13+ dakikalık CPU sayfalarını destekler |
| `OCR_LEASE_SECONDS` | `300`, en az 30 saniye; bilgisayar işçisi lease yeniler |
| `WORKER_SECRET` | Boşsa bilgisayar modu kapalı; en az 32 karakter rastgele gizli değer |
| `FIREBASE_*` | `.env.example` içindeki mevcut Firebase projesi/istemci ayarları |
| `DISABLE_AUTH` | `false`; yalnızca izole loopback denemesi için `true` |

Rastgele işçi gizli değeri üretin:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Bu değeri yalnızca VPS ve `compute/` işçisinin özel env dosyalarında tutun. URL'ye, istemci Firebase ayarlarına, HTML'e veya loglara koymayın. İşçi **HTTPS** adresine veya kimliği doğrulanmış bir **SSH tüneli içindeki loopback HTTP** adresine dışarı doğru bağlanır; ev bilgisayarında port açma veya yönlendirme gerekmez. Genel ağda düz HTTP üzerinden gizli değer göndermeyin. Gizli değerin bulunmaması VPS CPU OCR'ını engellemez; bilgisayar modu seçimi gerekli ayarı bildiren 503 yanıtı verir.

## Mevcut üretim verilerini taşımak

Eski `local/` servisini PM2 ile durdurduktan ve ortak npm bağımlılıklarını kurduktan sonra:

```sh
npm --prefix vps run migrate
pm2 startOrReload vps/ecosystem.config.cjs --update-env
pm2 save
```

Taşıma aracı, VPS kütüphanesi henüz yoksa `local/library.json` ve `local/uploads/` dosyalarını kopyalar. Kaynakları **silmez veya değiştirmez**; mevcut hedef dosyaları ezmez. Varsa `local/.env`, yalnızca `vps/.env` henüz yoksa kopyalanır. Mevcut `local/firebase-config.js` yedek ayarları ve CPU `.venv-ocr` olduğu yerde kalır. Hedefte `library.json` varsa kitapları birleştirmez; dolayısıyla sonraki dağıtımlar silinmiş kitapları yeniden eklemez. Ayrı `DATA_DIR` kullanıyorsanız bunu `vps/.env` veya süreç ortamında belirtin. Veri klasörünü, env dosyasını ve kuyruk dosyasını düzenli yedekleyin.

GitHub Actions dağıtımı aynı geçişi yapar, mevcut PM2 `reader` adını korur ve CPU ortamı varsa yeniden kurmaz. Node.js yükseltmesini ayrı bakım adımı olarak yapın; dağıtım mevcut desteklenen Node sürümünü zorla değiştirmez.
Mevcut doğrudan `0.0.0.0:3000` Reader erişimini korumak için taşıma aracı hedef env dosyasında `HOST` belirtilmemişse `HOST=0.0.0.0` ekler. Var olan açık `HOST` ayarını değiştirmez. Reverse proxy/TLS kurulumu ayrı bir geçiştir; proxy henüz yokken loopback'e geçmek genel okuyucu bağlantısını keser.


## OCR modları ve kalıcı kuyruk

- **Ayarlar → Bu kitap için OCR** varsayılanı **Otomatik**tir: kitap düzeyinde yerleşik metin bulunduysa boş kapakta bile OCR başlamaz; taranmış/vektör gövdeli kitapta açılan sayfa hazırlanır. **Açık** yerleşik metin yerine OCR ister; **Kapalı** hazır OCR cache yerine yalnız PDF metnini gösterir ve devam eden iş nesillerini iptal eder. Tercih `library.json` içindeki `ocrMode` alanında korunur.
- **Ayarlar → OCR işleme ve dışarı çıkmadan kitap hazırlama** paneli **VPS** veya **Bilgisayarım / GPU worker** işlem yerini ve tüm kitap/sayfa aralığı/geçerli sayfa kapsamını seçtirir. Toplu gönderim açık bir OCR isteğidir ve kitap tercihini **Açık** yapar. VPS kendi CPU motoruyla aynı anda yalnızca bir iş çalıştırır; bilgisayar işleri CPU'ya hiçbir zaman düşmez ve işçi kapalıysa bekler.
- **Geçerli sayfayı OCR yap / yeniden üret** düğmesi **Kapalı** durumda da yalnız o sayfayı hazırlar; kitap tercihini değiştirmez. Okuyucu dönen iş kimliğini izler, tamamlanınca sonucu gösterir. Sonraki normal açılış kitap tercihini kullanır.
- İşlem yeri `library.json` içindeki `computeMode` alanında korunur. Aralığı yeniden göndermek veya OCR tercihini değiştirmek eski iş kimliğini/lease'ini iptal eder; geç gelen CPU/GPU sonucu yeni nesli ezemez. Yeniden başlatma öncesinden kalan otomatik işler güncel kitap sınıflandırmasıyla denetlenir; yerleşik metinli kitapta devam ettirilmez.
- Önbellek 15. pipeline sürümünü, kaynak PDF boyutunu/zamanını ve boyutları doğrular. CPU ve bilgisayar sonuçları aynı `documentBlocks` normalizasyonunu ve sürümlü PNG/JSON önbelleğini kullanır. Figürler kaynak PNG kırpımlarıdır, model HTML'i çalıştırılmaz.
- JSON kuyruk her durum değişiminde geçici dosya + rename ile kalıcı yazılır. Lease bitimi işleri tekrar beklemeye alır; VPS yeniden başlatılması yarım kalmış işleri geri alır. Kitap silme/kaynak değişikliği geç gelen sonuçları iptal eder. Aynı tamamlanmış lease'in tekrarlanan teslimi idempotenttir.
- Sayfa API'si cache varsa 200, iş bekliyorsa/çalışıyorsa/hatalıysa 202 döner; PDF render veya model çıkarımını HTTP isteğinin içinde beklemez. Hatalı işi arayüzden yeniden gönderin; otomatik CPU geçişi yoktur.

## HTTP sözleşmesi

Kullanıcı uçları mevcut Firebase Bearer ID token doğrulamasını kullanır; tarayıcı görselleri/indirmeleri için mevcut kullanıcı `?token=` yöntemi korunur. VPS `/uploads/` kitap dosyaları, kapaklar ve oluşturulmuş PDF görsellerini yalnızca sahibi için sunar. Kuyruk, kütüphane JSON'u, `.env`, sunucu/Python kaynakları ve diğer npm modülleri statik olarak sunulmaz. Yerel sürümün bağımsız uploads davranışı korunur.

Korumalı EPUB görsel/SVG/CSS arka plan/font URL’leri de mevcut kullanıcı `?token=` yöntemiyle yüklenir; bölüm ve stylesheet istekleri aynı oturumun Bearer token’ını kullanır. Aynı-origin kaynaklar kapsamındadır; kitapta referans verilen dış sunucuya kimlik bilgisi gönderilmez. Kullanıcı font/renk/boyut override’ları PDF’de de korunur; kaynak italik/kalın/göreli boyut bilgisi üzerine uygulanır. PDF içindekileri kaynağın yer işaretlerinden, alt başlık ve gerçek sayfa hedefleriyle okunur.

- `GET /api/runtime-config` → `{mode:'vps',pipelineVersion:15,authEnabled}`.
- `GET /api/books/:id/pdf` → `{totalPages,sourceVersion,textLayer:'native'|'scanned',ocrMode:'auto'|'on'|'off',automaticOcr}`.
- `POST /api/books/:id/pdf/ocr` gövde `{mode:'auto'|'on'|'off'}` → güncel kitap tanımı; bekleyen/işlenen nesilleri iptal eder.
- `GET /api/books/:id/pdf/pages/:page` → kitap tercihine göre sayfa sonucu veya 202 `{status,jobId,mode,error?}`. `?ocr=0` yalnız yerleşik metni; `?ocr=1` açık yeniden üretimi ister. `?ocrJob=<id>` yalnız bu neslin sonucunu izler; iptal edilen/değiştirilen nesil 410 döndürür.
- `GET /api/books/:id/compute` → `{mode,totalPages,counts:{pending,processing,completed,failed},jobs:[{id,page,status,mode,error?}]}`. Sayımlar kuyruktaki işlere aittir; önceden kuyruğa alınmamış disk cache sayfaları sayılmaz.
- `POST /api/books/:id/compute` gövde `{mode:'vps'|'compute',fromPage?,toPage?}`; aralık verilmezse PDF'nin tamamı. Kitap OCR tercihini `on` yapar; GET kuyruk durumuyla birlikte güncel PDF tanımı alanlarını döndürür.

İşçi uçları **yalnızca** `Authorization: Bearer WORKER_SECRET` başlığını kabul eder:

- `GET /api/compute/jobs`: atomik compute işi alma; boşsa 204, varsa `{id,bookId,page,pipelineVersion:15,sourceVersion,leaseToken,inputUrl,leaseSeconds}`.
- `GET /api/compute/jobs/:id/input`: aynı Bearer başlığına ek `X-Compute-Lease: leaseToken`; PDF akışı. `sourceVersion` kitabın indirilen PDF'sini güvenli yeniden kullanma anahtarıdır.
- `POST /api/compute/jobs/:id/renew`: `{leaseToken}` → `{leaseSeconds}`.
- `POST /api/compute/jobs/:id/complete`: `{leaseToken,image:<base64 PNG>,result:<DocumentOcr regions çıktısı>}` → 200 `{success:true,jobId}`. Sonuç meta verileri `width,height,regions,engine,device,modelRevision,elapsedMs,qualityLimits,metrics` içerir. JSON sınırı 64 MiB, PNG sınırı 32 MiB'dir. PDF geometrisi `min(2.5,3200/max(pagePointsWidth,pagePointsHeight))` ölçeğinde yukarı yuvarlanmış tam boyutla eşleşmelidir.
- `POST /api/compute/jobs/:id/fail`: `{leaseToken,error,requeue?:boolean}`. İşçi durması `requeue:true`, çıkarım hatası `false` kullanır.

## Reverse proxy ve doğrulama

`vps/nginx.conf` HTTP reverse proxy örneğidir. Gerçek alan adınızın TLS sertifikasını Nginx'e ekleyin; bilgisayar işçisini genel ağda çıplak HTTP üzerinden çalıştırmayın. TLS yoksa `compute/` sürümünün güvenli SSH tüneli yolunu kullanın. Oracle güvenlik listesi/NSG ve Ubuntu güvenlik duvarında gerekli SSH/HTTPS portlarını açın; reverse proxy kuruluysa uygulama 3000 portunu loopback'te tutun. Mevcut doğrudan genel okuyucu kullanılıyorsa `HOST=0.0.0.0` ve mevcut 3000 erişimi korunabilir; bu okuyucu bağlantısı TLS kurulana kadar şifrelenmez. Tek PM2 instance/fork kullanın: JSON queue tek Node süreci tarafından yönetilir.

İzole kuyruk davranış testi:

```sh
node --test local/ocr-queue.test.js
```

Ortak mevcut testler: `npm --prefix local test`. Gerçek HTTP denemesi için ayrı boş `DATA_DIR`, loopback `HOST`, başka `PORT` ve yalnızca bu denemede `DISABLE_AUTH=true` kullanın; `/api/runtime-config` auth kapalı bilgisini döndürür ve istemci giriş istemez. Gerçek kitap yükleyip sayfanın hemen 202, tamamlanınca 200 olmasını gözlemleyin; bilgisayar işlerinde claim/input/renew/complete uçlarını gerçek işçiyle çalıştırın.

### Gerçek ARM64 VPS doğrulaması

Yeni kaynak sürümü mevcut PM2 `reader` servisine aktarıldı; genel `/api/runtime-config` yanıtı `mode:vps`, `pipelineVersion:15`, `authEnabled:true` döndürdü. Kimliksiz kitap isteği 401 olarak kaldı.

Aynı ARM64 makinede ayrı loopback portu/veri diziniyle mevcut iki Circe yüklemesi ve RLbook2018 üzerinde gerçek HTTP denemesi yapıldı. İki Circe kitabında kapak ve 9. sayfa yerleşik metin yolundan döndü, OCR işi oluşturulmadı. RLbook2018 otomatik OCR kullandı; mevcut CUDA sayfa önbelleği okundu ve **Kapalı** seçiminde yerleşik metne dönüldü. Deneme özgün PDF dosyalarının inode, boyut ve değişiklik zamanını korudu; geçici veri dizini kaldırıldı. Üretimin Firebase doğrulaması kapatılmadı.

### EPUB kaynakları ve PDF vurgu/içindekiler dağıtım doğrulaması

Ortak `local/` istemci ve PDF metin modülleri çalışan ARM64 VPS’ye kaynak yedeği alınarak aktarıldı. Genel okuyucunun `mode:'vps'`, `authEnabled:true` yapılandırması ve kimliksiz kitap isteğinin 401 sonucu korundu; sunulan istemci aktarılan kaynakla eşleşti. Aynı makinedeki izole loopback denemesinde gerçek Circe PDF’nin 9. sayfası yerleşik metin olarak, `nymph` ve `bride` sözcüklerinde kaynak italikle döndü; gerçek ReZero EPUB görseli 200 ve JPEG içeriğiyle yüklendi. Üretim kütüphanesi ve dört özgün kitabın inode/boyut/değişiklik zamanı değişmedi. Kalıcı PDF vakaları ve commit öncesi `npm --prefix local run check` komutu [local/README.md](../local/README.md#commit-öncesi-kalıcı-regresyon-kontrolü) içinde açıklanır; tarayıcı testleri üretim bağımlılığı değildir.
