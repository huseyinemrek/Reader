# İsteğe bağlı ev bilgisayarı CUDA OCR işçisi

Bu klasör, **yalnız dışarı bağlantı kuran** bağımsız Python işçisidir. Ev bilgisayarında port açılmaz; VPS'ye HTTPS üzerinden bearer kimlik doğrulamalı istekler yapılır. VPS'nin kendi CPU OCR yolu korunur. İşçi yalnız `compute` moduna atanmış işleri alır; `vps` işleri hiçbir zaman bu bilgisayara atanmaz ve bilgisayara atanmış işler CPU'ya düşmez.

VPS arayüzünde bilgisayar modunu seçip tüm kitabı veya sayfa aralığını kuyruğa alın. Sonra bu işçiyi ihtiyaç olduğunda başlatın. Tek GPU'da sayfaları sırayla işler; kuyruk `204` döndürünce kapanır. Sürekli çalışan servis veya 7/24 kuyruk yoklaması değildir. Kitap işleri kalıcı olarak VPS'de bekler; bilgisayar kapalıyken kaybolmaz.

## Gereksinimler

- Bu deponun tamamı (`compute/` yanında `local/` bulunmalı).
- Windows veya Linux, Python 3.12.14 ve `uv`.
- CUDA 12.8 PyTorch paketine uygun güncel NVIDIA sürücüsü ve **BF16 destekleyen NVIDIA GPU**. CPU/otomatik mod yasaktır; destek yoksa işçi açık hata ile durur.
- İlk hazırlamada Hugging Face'den indirilen model ağırlıkları için internet ve yeterli disk/GPU belleği. Model kimlikleri ve sabit revision'lar ortak `local/document-ocr-worker.py` içinden kullanılır; ayrı OCR modeli veya uzak OCR servisi yoktur.

## Kurulum

Depo kökünde Windows PowerShell:

```powershell
uv venv --python 3.12.14 compute/.venv
uv pip install --python compute/.venv/Scripts/python.exe --index-url https://download.pytorch.org/whl/cu128 -r compute/cuda-requirements.txt
uv pip install --python compute/.venv/Scripts/python.exe -r compute/requirements.txt
Copy-Item compute/.env.example compute/.env
```

Linux:

```sh
uv venv --python 3.12.14 compute/.venv
uv pip install --python compute/.venv/bin/python --index-url https://download.pytorch.org/whl/cu128 -r compute/cuda-requirements.txt
uv pip install --python compute/.venv/bin/python -r compute/requirements.txt
cp compute/.env.example compute/.env
```

CUDA paketleri ayrı aşamada kurulmalıdır; tüm bağımlılıkları PyTorch paket dizininden kurmaya çalışmayın. İki requirements dosyası ortak yerel bağımlılıkları içerir; `httpx` de ortak sabitlenmiş listeden gelir.

`compute/.env` içindeki `VPS_URL` ve `WORKER_SECRET` değerlerini ayarlayın. Secret VPS'deki `WORKER_SECRET` ile aynı, uzun rastgele değer olmalı; tarayıcı yapılandırmasına, URL'ye veya kaynak kontrolüne konmamalı. Ortam değişkenleri `.env` değerlerini geçersiz kılar. İşçi varsayılan olarak kendi klasöründeki `.env` dosyasını okur, çalışma dizinine bağlı değildir. Başka dosya: `--env-file /path/to/private.env`.

## Çalıştırma

```powershell
compute/.venv/Scripts/python.exe compute/worker.py
```

```sh
compute/.venv/bin/python compute/worker.py
```

Modeller **iş almadan önce** hazırlanır; soğuk model yüklemesi bir işin lease süresini tüketmez. İşi aldıktan sonra ayrı outbound heartbeat, PDF indirme, render, uzun CUDA çıkarımı ve sonuç gönderimi boyunca lease'i yeniler. Art arda aynı kitabın aynı `sourceVersion` değerindeki sayfalarında indirilmiş PDF yeniden kullanılır; kaynak değişirse tekrar indirilir. Sadece son PDF geçici klasörde tutulur, çıkışta kapatılıp silinir.

Ctrl+C veya SIGTERM yeni iş almayı durdurur. İndirme/render aşamasındaki iş yeniden kuyruğa bırakılır. Sinyal CUDA çıkarımı sırasında gelirse mevcut çıkarım ve sonuç teslimi bitirilip çıkılır; bu nedenle GPU çağrısının bitmesi beklenebilir. Lease yenilemeleri bu sürede devam eder. GPU modelleri, plan görüntüleri, önbellek ve CUDA allocator belleği çıkışta bırakılır. Çıkarım hatası işin `failed` olmasına yol açar ve diğer işler işlenir; outbound iletişim/teslim hatası aktif işi yeniden kuyruğa bırakmayı deneyip açık hata ile durur. Bağlantı tamamen kopmuşsa VPS lease zaman aşımı işi kurtarır. Çıkış kodları: başarılı boşaltma `0`, hata `1`, kullanıcı durdurması `130`.

`VPS_CONNECT_TIMEOUT_SECONDS`, `VPS_READ_TIMEOUT_SECONDS`, `VPS_WRITE_TIMEOUT_SECONDS` ağ sürelerini ayarlar. `VPS_DELIVERY_ATTEMPTS` aynı lease sonucunun idempotent teslim denemesi sayısıdır. TLS sertifika doğrulaması kapatılmaz ve yönlendirmeler izlenmez. Üretimde HTTPS zorunludur. `http://127.0.0.1:PORT` / `http://localhost:PORT` yerel smoke için kabul edilir. Yalnız izole geçici geliştirme ağında açıkça `ALLOW_UNSAFE_HTTP=true` ayarıyla diğer HTTP adresleri kullanılabilir; bu durumda secret ve PDF düz metin taşınır, üretimde kullanılmamalıdır.

### HTTPS henüz yoksa: otomatik outbound SSH tüneli

Doğrudan HTTP `:3000` ile çalışan VPS için token’ı açık internette düz metin göndermeyin. Worker kendi SSH tünelini açıp kapatabilir; ayrı bir kalıcı servis veya evde port yönlendirme gerekmez. Windows/Linux OpenSSH istemcisi kurulu olmalıdır.

Önce VPS’nin SSH host fingerprint’ini sağlayıcının konsoluyla doğrulayıp normal bir `ssh -i <anahtar> ubuntu@<VPS-IP>` bağlantısıyla `known_hosts` kaydını oluşturun. Worker `StrictHostKeyChecking=yes` ve `BatchMode=yes` kullanır; bilinmeyen/değişmiş sunucu anahtarını veya parola sorusunu sessizce kabul etmez.

`compute/.env`:

```dotenv
SSH_HOST=VPS-IP-VEYA-SSH-HOST
SSH_USER=ubuntu
SSH_KEY_FILE=C:/Users/USER/.ssh/reader_compute.key
SSH_PORT=22
SSH_REMOTE_PORT=3000
WORKER_SECRET=VPS-ILE-AYNI-UZUN-RASTGELE-SECRET
```

`SSH_HOST` doluysa `VPS_URL` yerine şifreli SSH üzerinden VPS’nin `127.0.0.1:SSH_REMOTE_PORT` adresine bağlanılır. Dinleme portu yalnız ev bilgisayarının loopback adresinde ve otomatik seçilir; internete açılmaz. Kuyruk boşalması, hata veya kullanıcı durdurmasında SSH süreci de kapatılır. SSH anahtarı repoya kopyalanmaz. OpenSSH “bad permissions” hatası verirse anahtar dosyasına yalnız kendi kullanıcınızın erişmesine izin verin (Linux `chmod 600`; Windows kullanıcıya özel ACL). Özgün anahtarın geniş izinlerini korumanız gerekiyorsa kullanıcıya özel izinli ayrı bir kopya kullanın.


## Gerçek CUDA / PDF smoke

Mevcut yerel CUDA ortamı yeniden kullanılabilir; compute ek bağımlılıklarını önce bu ortama kurun. Depo kökünde Windows:

```powershell
uv pip install --python local/.venv-ocr/Scripts/python.exe -r compute/requirements.txt
local/.venv-ocr/Scripts/python.exe compute/worker.py --smoke-pdf "path/to/RLbook2018.pdf" --page 11 --output "$env:TEMP/reader-compute-page11.json"
```

Linux'ta aynı komutta Python yolu `local/.venv-ocr/bin/python` olur ve örnek çıktı yolu `/tmp/reader-compute-page11.json` kullanılabilir. PDF yolunu gerçek kitap dosyasıyla değiştirin. Bu komut VPS veya secret gerektirmez; gerçek ortak CUDA modellerini yükler, PDF sayfasını render eder, `layout` ve kaynak PDF operatörlerinden adaptif yeniden render edilmiş text/formula pencereleri ile `regions` çalıştırır. Konsolda GPU/model metadata, ölçüler, kaynak render metrikleri ve gerçek semantik bölgeler görülür. JSON dosyası PNG + sonuç gövdesini içerir; test bitince silin. Uçtan uca kanıt için VPS'de bilgisayar moduna bir sayfa atayıp normal işçiyi çalıştırın; sonrasında VPS arayüzünün tamamlanmış GPU sonucu göstermesini kontrol edin.

## VPS protokolü

Tüm istekler `Authorization: Bearer WORKER_SECRET` taşır; secret ve lease URL'ye eklenmez.

- `GET /api/compute/jobs`: atomik olarak bir compute işi alır; boşsa `204`. Claim: `id`, `bookId`, 1-tabanlı `page`, `pipelineVersion:15`, `leaseToken`, `leaseSeconds`, `inputUrl`, isteğe bağlı `sourceVersion`.
- `GET /api/compute/jobs/:id/input`: `X-Compute-Lease` header'ı ile doğrulanan PDF akışı. `inputUrl` beklenen aynı-origin iş yoluyla birebir eşleşmelidir.
- `POST /api/compute/jobs/:id/renew`: `{leaseToken}`; yanıt `{leaseSeconds}`. Lease reddedilirse eski sonucu yüklemeye çalışılmaz.
- `POST /api/compute/jobs/:id/complete`: `{leaseToken,image,result}`. `image` orijinal sayfanın base64 PNG'si, `result` ortak `DocumentOcr.regions` semantik sonucu ve metadatasıdır. VPS ortak JS block dönüşümünü ve pipeline-15 disk önbelleğini kullanır; aynı lease için tekrar teslim idempotenttir.
- `POST /api/compute/jobs/:id/fail`: `{leaseToken,error,requeue}`; kullanıcı durdurması/iletişim hatası için `true`, çıkarım hatası için `false`.

Kaynak sayfa ölçeği `min(2.5, 3200 / max(page width, page height))`, ölçüleri `ceil(width * scale)` / `ceil(height * scale)` olur. Figure koordinatları bu orijinal PNG üzerindedir. Adaptif pencereler metin için 48, formül için 64 piksel satır yüksekliğini hedefler; en fazla 4x zoom, 2400 piksel kenar, 1.6M piksel alan ve 12 piksel beyaz sınır ortak yerel renderer ile aynı yaklaşımı izler. PDF'den yeniden çizilirler; düşük çözünürlüklü bitmap büyütülmez.
