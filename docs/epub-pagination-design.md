# EPUB sayfalama tasarımı

Tarih: 2026-10-03. Durum: ilk sürüm ortak `epub-pagination.js` ve `epub-object-view.js` ile Local/VPS/Hosting okuyucusuna uygulandı (düzen anahtarı 8). Kapsam: yeniden akan EPUB/HTMLZ'nin sayfalı görünümü, ortak Local/VPS/Hosting yolu. İlk uygulama ve gerçek tarayıcı denemesi Local'de yapılmalı; dış servis gerektirmeden aynı düzen motorunu doğrular.

## 1. Başarı tanımı

Amaç, kullanıcı fontunu ve kenar boşluklarını koruyarak anlamlı içerik gruplarını birlikte göstermek ve gereksiz seyrek sayfaları azaltmaktır. Öncelik sırası:

1. Bütün içeriğin erişilebilir olması, kaynak okuma sırası ve bağlantı/konum kimlikleri.
2. Kullanıcının seçtiği okunabilirlik ayarları ve geçerli zorunlu kaynak kırımları.
3. Birlikte sığabilen anlamlı grupların bütünlüğü.
4. Başlık/paragraf geçişleri ve görsellerin okunabilirliği.
5. Sayfa doluluğu ve komşu sayfaların dengesi.

İlk dört maddeyi bozarak kazanılan doluluk başarı sayılmaz. Kullanıcının tablosu tam sayfaya sığıyorsa, önceki sayfanın altında boşluk kalması kabul edilir. Kitabın son sayfası, bilinçli bölüm başlangıcı veya tam sayfa illüstrasyonu sırf seyrek olduğu için düzeltilmez. Calibre'den üstünlük, aynı kaynak/ekran/font koşullarında ölçülecek bir hedeftir; bütün EPUB'lar için garanti değildir.

## 2. Mevcut davranıştan fark

`hosting/public/cloud-reader.js` içindeki `createImageGapLayout` yalnız iki görsel arasındaki kısa ve izole metne bakıyor; en az küçültülecek komşuyu seçiyor. Açıklamanın hangi görsele ait olduğunu modellemiyor. Böylece Louis XIV açıklamasını Obama görselinin üstünde tutabiliyor.

Bu aday taraması tabloları açıkça dışlıyor. Dolayısıyla bildirilen tablo bölünmesini doğrudan bu fonksiyonun böldüğü sonucuna varamayız. Mevcut sayfalı CSS'te tabloyu tam sayfaya sığdığı zaman birlikte tutan ayrı bir politika bulunmuyor; geometrinin değişmesi kırılma yerini de değiştirebilir.

Yeni tasarım, mevcut boşluk düzenleyicinin üzerine bağımsız ikinci bir düzenleyici eklemez. Tek ortak planlayıcı; kaynak kuralları, tablo bütünlüğü ve görsel yerleşimini birlikte değerlendirir.

## 3. Kaynak kurallarını yorumlama

EPUB paketindeki `rendition:layout` ve bölüm düzeyindeki geçersiz kılmalar önce okunur. `pre-paginated` içerik bu optimizasyona girmez; sabit düzen yolunda kalır. Mevcut uygulamada bu ayrımın eksiksiz desteklendiği varsayılmamalı, uygulama aşamasında adapter sözleşmesi doğrulanmalıdır. [EPUB 3.3 düzen tanımı](https://www.w3.org/TR/epub-33/#layout).

Kaynak DOM, kaynak CSS ve kullanıcının ayarları birleştirildikten sonra etkin kurallar okunur:

- `break-before`, `break-after`, `break-inside` ve eski `page-break-*` karşılıkları.
- `widows`, `orphans`, `white-space`, yön, yazım modu ve bölüm sınırları.
- Tablo başlığı, başlık hücreleri, satır grupları, `rowspan`/`colspan`; figür/açıklama ilişkileri.
- Görsel oranı, kaynak boyut sınırları ve kaynakta özellikle birlikte tutulmuş kısa bloklar.

Kaynakta zorunlu kırılma, birleştirme adayını keser. `avoid` tercihleri tek başına mutlak garanti değildir; sığmayan içerikte tarayıcı bunları gevşetebilir. Bu nedenle sonuç geometriyle de denetlenir. [CSS kırılma kuralları](https://www.w3.org/TR/css-break-3/#breaking-rules).

Okuyucunun fiziksel uygulaması CSS sütunlarıdır. Okuyucu sayfası anlamındaki `page`/`avoid-page` niyetini sütun kırımlarına taşıyan açık bir adapter gerekir; yalnız `avoid-page` yazmak yeterli sayılmaz. Özgün kural saklanır, dönüşüm sadece sayfalı okuyucuya uygulanır. `left/right/recto/verso` isteklerinde mantıksal sayfa yönü/paritesi korunur; gerekli parite önbelleğe girer. Kaynak `epub:type="pagebreak"` işareti ise basılı sayfa konumudur, tek başına zorunlu ekran kırımı yapılmaz.

Zorunlu kaynak kırımı bir grubun içindeyse grup bu sınırın üzerinden birleştirilmez. Desteklenmeyen karmaşık CSS, float veya yazım modunda agresif optimizasyon uygulanmaz; doğal akış ve bütün içeriğe erişim korunur. RTL/dikey yazı yalnız x koordinatından sayfa çıkaran mevcut varsayımlarla desteklenmiş sayılmaz; mantıksal eksen adapter'ı ve gerçek test gerekir.

## 4. Anlamlı gruplar

İlk geçiş DOM'u doğrusal tarar. Bölümün tamamını yeniden yazmak yerine kaynak kimliklerine bağlı, iç içe geçebilen bir grup modeli çıkarır.

| İçerik | Yerleşim politikası |
| --- | --- |
| Bir sayfaya sığan tablo ve başlığı | Tek grup; kalan yere sığmıyorsa sonraki sayfaya geçer. |
| `figure` / `figcaption`, açıkça bağlı açıklama | Görsel ve açıklama birlikte değerlendirilir; açıklama başka görsele bağlanmaz. |
| Açıklamayı izleyen ilişkili telif satırı | Aynı figür grubuna katılır. |
| Başlık | Ardındaki metnin en az iki satırıyla kalır; kaynak daha sıkıysa kaynak kuralı uygulanır. |
| Normal paragraf | Uygun satır sınırından bölünebilir; varsayılan en az iki satır iki tarafta kalır. |
| Liste | İşaret ilk satırdan ayrılmaz; uzun listenin tamamı tek grup yapılmaz. |
| Kısa formül, diyagram, şiir kıtası | Semantik/kaynak işaretleriyle tanınabiliyorsa sığdığı sürece bütün tutulur. |
| Uzun alıntı, çok paragraflı kapsayıcı | Otomatik olarak bölünmez sayılmaz; kaynak kuralları ve güvenli alt sınırlar kullanılır. |

İlişki kanıtının sırası: HTML semantiği ve açık referanslar → yerel kaynak yapısı/kuralları → ihtiyatlı örüntü. Örneğin aynı kapsayıcıda görselin hemen ardından gelen `caption`/`cap…` sınıfı, açıklama tipografisi ve bunu izleyen `credit` birlikte güçlü bir ipucudur. Tek başına küçük punto, kalınlık veya kısa uzunluk açıklama kanıtı değildir. Bu ipuçları genel HTML standardının garantisi olarak sunulmaz.

İki görsel arasında bulunmak, metni ikisinden birinin açıklaması yapmaz. Düz metin normal akış olarak kalır. Güvenilir sahiplik varsa diğer görselle eşleştirme adayı üretilmez; sahiplik belirsizse yeni bir zorunlu ilişki icat edilmez. Normal metin doğal olarak görselle aynı sayfada bulunabilir.

`break-after:avoid` zincirleri bütün bölümü dev bir gruba dönüştürmez. Yeni bağımsız figür, başlık veya zorunlu kırılma sınırlarında ilişkiler yeniden değerlendirilir. Kaynaktaki tercihi gevşetmek yalnız sığmama durumunda, kaydedilmiş bir gerekçeyle mümkündür; bütün `avoid` kurallarını topluca silmek yoktur.

## 5. Gerçek boyutları ölçme

Karakter sayısı karar ölçüsü değildir. Gizli ölçüm belgesi görünür okuyucuyla aynı genişlik, yükseklik, fontlar, satır aralığı, paragraf aralığı, padding ve kaynak stillerini kullanır. Gerekli fontlar kullanıma sokulup yüklenmesi beklenir; yedek fontla ölçülen sonuç son fontun sonucu olarak saklanmaz.

Kullanılabilir alan, okuyucunun gerçek içerik kutusundan alınır. HUD/araçların metin üzerine gelmeyeceği alan önceden ayrılır. Sürekli akışta blok ve grup geometrisi toplu okunur; sütun akışında gerçek parçalar ayrıca gözlenir. Çöken marjlar, tablo kenarlıkları ve satır yüksekliği yalnız sayısal CSS toplamı varsayılarak hesaplanmaz.

Görsellerin ölçüsü mevcut düzen paketindeki boyutlarla sağlanır. Sayfa hesabı için tüm resimler indirilmez. Yeni ölçüm, font/padding/ekran değişiminde gereklidir; her sayfa çevirmede gerekmez.

## 6. Nesne yerleştirme kararları

### Tablo

`T` tablo+başlığın gerçek yüksekliği, `H` boş sayfanın kullanılabilir yüksekliği, `R` geçerli sayfanın kalan alanıdır:

1. `T ≤ R`: burada bütünüyle göster.
2. `R < T ≤ H`: sonraki sayfaya bütünüyle taşı.
3. `T > H` veya genişliği okunabilir biçimde sığmıyorsa: ayrı okuyucu sayfasında bütün tabloyu tek erişilebilir nesne olarak tut; gerekli yönde kaydırılabilen tablo alanı ve “Tabloyu genişlet” görünümü sağla.

Üçüncü durumda kullanıcının puntosu otomatik küçültülmez; tablonun tamamını aynı anda ekrana sığdırma iddiası yoktur. Başlık/hücre ilişkileri ve birleştirilmiş hücreler korunur. Klavye/dokunmatik kaydırma, açılan görünümden aynı konuma dönüş ve seçim/kopyalama çalışmalıdır. Kitap içi link tablonun içindeyse ilgili satır iç kaydırmada da görünür yapılır.

Varsayılan olarak uzun tablolar da sırf boşluk kazanmak için satırlara bölünmez. İleride kontrollü çok sayfalı tablo yolu istenirse tekrarlanan başlık, devam işareti ve `rowspan` grupları ayrıca tasarlanmalı; tarayıcının başlıkları kendiliğinden tekrarlayacağı varsayılmamalıdır.

### Görsel ve açıklama

Önce kendi açıklaması/telifinin gerçek yüksekliği için alan ayrılır. Görselin oranı korunur, kırpma yapılmaz. Başlangıç boyutu `I`, açıklama ve aralık toplamı `C` ise tam sayfa için aday yükseklik `min(I, H − C)` olur. Bu yalnız ön tahmindir; birlikte gerçek render ile doğrulanır.

Başlangıç politikası: mevcut sayfaya zaten sığdırılmış görsel boyutundan en fazla %25 ilave küçültme; %0–15 arası düşük, %15–25 arası artan maliyet. %25 bir hedef değildir. Örneğin 1000 px içerik alanında 180 px açıklama/aralık varsa, 1000 px portre 820 px'e inerek aynı sayfada kalabilir. Sadece daha az küçülüyor diye açıklama sonraki portreye taşınmaz.

Formül, yazı içeren SVG ve semantik olarak tanınan diyagramlarda bu bütçe otomatik kullanılmaz. Etiketsiz raster resmin içinde okunacak yazı olup olmadığını DOM'dan kesin bilemeyiz; bu sınıf için agresif küçültme yapılmaz ve özgün ölçekte açma yolu gerekir. Fotoğraf olduğu güvenilir biçimde bilinmeyen her raster'a “fotoğraf” varsayımı yapılmamalıdır. Bu belirsizlik, kaynak örnekleri üzerinden uygulamada açıkça ele alınacaktır.

Sınır içinde birlikte sığmayan figür/açıklama, bütünlüğün gerekli olduğu durumda tablo gibi ayrı genişletilebilir nesne olabilir. Tam sayfa bağımsız görsele zorla metin eklenmez. Kaynakta özellikle ayrılmış sayfalar birleştirilmez.

### Normal metin

Tarayıcı satır dizgisine devam eder. Başlık altında en az iki satır; paragrafın her iki parçasında kaynak kuralı veya varsayılan iki satır korunur. Üç satır, daha kötü boşluk üretmiyorsa tercih olabilir. Çok kısa ekranda kuralların aynı anda sağlanamadığı durum önce saptanır; içerik kesilerek gizlenmez.

Kullanıcının fontu, font boyutu, satır aralığı ve padding'i sayfa doldurmak için değiştirilmez. Kaynağın italik/kalın ve göreli başlık boyutları korunur. Heceleme dili ve kaynak tercihleri korunur; desteklenmeyen sözlük varmış gibi davranılmaz. Sayfayı doldurmak için sözcük veya paragraf sırası değiştirilmez.

## 7. Birkaç sayfayı birlikte değerlendirme

Yalnız mevcut sayfayı olabildiğince doldurmak sonraki sayfada tek satır bırakabilir. Planlayıcı geçerli sayfa ve sonraki iki sayfayı kapsayan sınırlı bir pencere kullanır.

Her sınırda uygulanabilir seçenekler: doğal tarayıcı kırımı, uygun blok öncesinde kır, birlikte kalacak grubu taşı, izin verilen figür boyutunu seç. Metin içindeki keyfî karaktere CSS ile kırılma dayatılabildiği varsayılmaz. İlk sürüm blok sınırlarını planlar; paragraf içi satır kırımları `widows/orphans` ile tarayıcıya bırakılır. Bu, tüm kitabın satır düzeyinde küresel optimumunu bulma iddiası değildir.

Önce geçersiz seçenekler elenir: kaynak sırası değişiyor, içerik kayboluyor, zorunlu kırım atlanıyor, sığabilen korumalı grup bölünüyor veya izin verilmeyen ölçek kullanılıyor. Kalanlar sözlük sırasıyla karşılaştırılır:

1. Kaynak keep tercihleri ve başlık/satır bütünlüğündeki kaçınılabilir ihlaller.
2. Gereksiz sayfa sayısı ve belirgin tek satırlık devam sayfaları.
3. Boşluk dağılımı ve görsel küçültme maliyeti.
4. Eşitlikte daha az müdahale ve kararlı kaynak sırası.

Son maliyet için başlangıç modeli: normal sayfalardaki boş oranlarının kareleri + komşu sayfa doluluk farkı + artan görsel küçültme bedeli. Bölüm sonu, zorunlu kırımla biten sayfa, bağımsız figür ve büyük tablo görünümü doluluk yarışına sokulmaz. Ağırlıklar kitap örnekleriyle ayarlanacak parametrelerdir; henüz ölçülmüş kalite katsayıları değildir.

Başlangıç hesap sınırları: üç sayfalık ufuk, en fazla 32 aday sınır/karar, her derinlikte en iyi dört durumu saklayan dar arama. Maliyet hesabı saf veri üzerinde yapılır; bütün seçenekler ayrı ayrı DOM'da denenmez. Sınırı aşan bölümde semantik korumalı doğal akış kullanılır.

Tahmini en iyi plan toplu uygulanır ve gerçek sütun geometrisi doğrulanır. Marj/float/ölçek etkisi nedeniyle tahmin tutmazsa en fazla iki düzeltme geçişi yapılır. Sonuç yine tutarsızsa o bölgedeki doluluk optimizasyonu bırakılır; korumalı gruplar ve büyük nesne görünümü korunur. Böylece sonsuz yeniden sayfalama döngüsü oluşmaz.

## 8. Performans ve kararlı konum

- Semantik tarama düğüm sayısıyla doğrusal; sınırlı aday araması yaklaşık `O(N × K × B)` olur. `K/B` üst sınırları sabittir. Bu, tarayıcı layout maliyetinin doğrusal olduğu garantisi değildir.
- Geometri okumaları ve stil yazmaları ayrılır. Küçük ayar hareketleri birleştirilir, eski ölçüm oturum belirteciyle iptal edilir. Büyük bölümün tek tarayıcı layout işi yine pahalı olabilir; ölçülmeden “yavaşlatmaz” denmez.
- Önce görünen bölüm hazırlanır; kesin toplam için bütün bölüm metinleri arka planda ölçülür. İş tamamlanmadan kesin toplam gösterilmez. Saf plan araması gerekirse worker'a taşınabilir, DOM ölçümü taşınamaz.
- Aynı bölüm/düzen planı görünür belge ve gizli sayfa sayım belgesinde kullanılır. Sayfa çevirme yeni plan araması veya grup ölçümü başlatmaz.
- Anahtar: motor/politika sürümü, kitap ve kaynak CSS sürümü, gerçek içerik boyutları, kullanılan fontların kimliği/yükleme durumu, boyut/ağırlık/değişken font eksenleri, satır/paragraf aralığı, padding, dil/heceleme, yön/yazım modu; gerekiyorsa başlangıç paritesi ve tarayıcı düzen uyumluluk sürümü.
- Geç yüklenen font veya değişen kaynak boyutu ölçümü geçersiz kılar. Eski sonucun yeni ayarlara uygulanmasına izin verilmez.
- Konum kaynak bölüm + kararlı düğüm kimliği + karakter/nesne konumudur. Eski sayfa numarası veya render sırasında kopan DOM referansı değildir. Link dönüşü, yer işareti, arama ve yeniden açma aynı kaynak konumuna bağlanır.
- Önbellek; gruplar, seçilen ölçekler, uygulanabilir blok kırımları, büyük nesne modu ve doğrulanmış sayfa sayısını birlikte saklar. Eski `imagePlans` yeni plan sayılmaz; düzen anahtarı sürümü artırılır.

Ölçülecek hedef: aynı makine/kitap kümesinde soğuk toplam hesap süresinin p95 değerini eski motorun yaklaşık 1,25 katı içinde tutmak; sıcak sayfa çevirirken sıfır ek plan ölçümü. Bunlar doğrulanacak bütçelerdir, bugünkü performans sonucu değildir. Bir hedef kaçarsa önce optimizasyon ufku kısılır; içerik bütünlüğü gevşetilmez.

## 9. Mevcut repoya uygulama yolu

Önerilen ortak modül `hosting/public/epub-pagination.js` olur; geometri/CSS eşlikçisi gerekiyorsa aynı ortak klasörde tutulur. `cloud-reader.js` kaynak çözümleme ve semantik işaretlemeyi besler. Mevcut `createImageGapLayout` yeni planlayıcıya dönüştürülür veya caller'ları taşındıktan sonra kaldırılır; aynı anda yarışan iki motor bırakılmaz.

Local ve Hosting `script.js` içindeki `settleContent`, `countBookPages`, sayfa haritası ve yeniden açma yolları aynı sözleşmeye bağlanır. Local/VPS `/reader-core/` whitelist'ine yeni ortak dosya eklenir. Ölçüm iframe'i görünür belgeyle aynı CSS/modülü kullanır. Hosting'e Node/Python işi eklenmez; mevcut sunucu/Storage düzen paketleri ilk uygulamada korunabilir.

Uygulama sırası:

1. Kaynak kırım adapter'ı, sığan tablo koruması, figür/açıklama ilişkileri ve büyük nesne görünümü.
2. Gerçek ölçüm, ortak plan uygulama, konum ve cache sürümü.
3. Sınırlı ileri bakış ve doluluk maliyeti; önceki iki adımın bütünlük testleri sabit kalır.
4. Local gerçek yüzeyden sonra VPS/Hosting adapter kontrolü; son entegrasyonda tek tam `npm --prefix local run check`.

Uygulama; sığan tablo bütünlüğü, kaynak zorunlu kırımı, font/padding değişiminde yeniden ölçüm, büyük tablonun kaydırılabilir/genişletilebilir tek nesne olması ve figür–açıklama sahipliği için üç sürümün gerçek okuyucu senaryolarıyla doğrulandı. Calibre ile sayısal karşılaştırma ve gerçek kitaplarda insan değerlendirmesi henüz yapılmadı.

## 10. Kabul senaryoları

| Senaryo | Beklenen sonuç |
| --- | --- |
| Sapiens, Sex and Gender tablosu | Tam sayfaya sığdığı ayarda başlık ve dokuz satır aynı okuyucu sayfasında. |
| Louis XIV ve Obama portreleri | Her açıklama kendi figüründe; telif yanlış portreye bağlanmaz. |
| İki görsel arasındaki sıradan paragraf | Sırası ve metni tam; açıklama diye sınıflandırılmadan normal akar. |
| Çok uzun/geniş tablo, birleşik hücreler | Kırpılma yok; bütün tablo alanında kaydırma, genişletme, kopyalama ve geri dönüş. |
| Uzun açıklama veya metin içeren diyagram | Punto zorla küçülmez; erişilebilir büyük nesne yolu. |
| Kaynak zorunlu kırımı/avoid zinciri | Zorunlu sınır korunur; imkânsız keep zinciri sonsuz/boş sayfa üretmez. |
| Büyük punto, farklı aile/eksen ve geniş padding | Tekrar ölçülür; bütünlük kuralları yeni kullanılabilir alana göre aynı şekilde işler. |
| Yeniden açma, ekran dönüşü ve linkten dönüş | Kaynak okuma konumu görünür; eski reflow sayfasına saplanmaz. |
| Seçim, kopyalama, arama, sesli okuma | Kaynak metin bir kez ve doğru sırada; sunum kopyaları okuma ağacını çoğaltmaz. |
| Kaydırmalı mod / PDF / sabit düzen EPUB | Bu optimizasyon kapsamı dışında; ilgili mevcut davranış korunur. |

Geometri doğrulaması metnin tamamını, tablo hücrelerini, görselin son pikselini ve gerçek sayfa sınırlarını kapsamalı. En az dar/geniş ekran, kısa/uzun ekran, üç font boyutu ve farklı font ölçüleri seçilmeli. Renklerin aynı geometriyi bozmaması da kontrol edilmeli.

Calibre karşılaştırması aynı kitap, benzer gerçek metin alanı ve yüklenmiş fontla yapılmalı. Ölçüler: sığabilen bölünmüş tablo sayısı, yanlış figür-açıklama eşleşmesi, yalnız kalan başlık/satır, gerekçesiz seyrek sayfa, kırpılma/kayıp, başlangıç süresi ve sayfa çevirme gecikmesi. Zorunlu kırımlar ve son sayfalar seyrek sayfa hatası sayılmamalı. Sayısal ölçülerin yanında aynı bölümlerin yan yana insan tarafından değerlendirilmesi gerekir.
