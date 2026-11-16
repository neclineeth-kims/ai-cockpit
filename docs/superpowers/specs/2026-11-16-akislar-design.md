# Akışlar: tekrarlanabilir teslim süreçleri (SOP)

Durum: taslak, planlamaya alındı (16 Kasım 2026)
Esin kaynağı: [Tencent LoopForge](https://github.com/Tencent/LoopForge) (MIT). Kod alınmaz; kavramlar alınır.

## Neden

Bir ajana "şu görevi yap" dendiğinde sonuç o oturuma bağlı: planı atlayabilir, testi unutabilir, kendi kodunu kendisi inceleyebilir, yarıda kalabilir. Bugün bunu elle yönetiyoruz: Sonnet ya da GLM uygular, Opus inceler, düzeltme turu, kullanıcı onayı, push. Her seferinde aynı adımlar, ama hiçbir yerde kayıtlı değil.

LoopForge bunu **SOP** ile çözüyor: bir teslimin izlediği sabit adımlar (Netleştir, Tasarla, Uygula, İncele, Test, Kabul). Her adım bir rol: kendi istemi, ajanı, modeli. Arada insan onay kapıları var; kabul adımı işi seçilen bir adıma geri gönderebilir. Her adımın durumu, logu ve çıktısı görünür; başarısız adım yeniden denenir ya da herhangi bir adımdan tekrar başlatılır.

Kokpitte bunun parçaları zaten var: görev ve worktree (iş tahtası), ajan başlatma (Ajan Çalıştır, run-spawner, Codex/Cursor spawner), canlı izleme (Panel, Oturumlar), maliyet (Analitik), plan ilerlemesi (Plan). Eksik olan onları sıraya koyan **akış motoru** ve insan kapıları.

## Hedefler

1. **Akış tanımı**: depoda duran, okunabilir bir dosya (`.ai-cockpit/akislar/<ad>.yaml`). Adım türleri: `agent`, `script`, `gate` (insan onayı).
2. **Roller**: her `agent` adımı kendi istem dosyasını, ajanını (Claude Code, Codex, Cursor, opencode üzerinden GLM) ve modelini seçer. Örnek: Uygula = GLM, İncele = Opus.
3. **Çalıştırma**: iş tahtasındaki bir görevde ya da plan görevinde "Akışla başlat". Akış görevin worktree'sinde adım adım ilerler; her adımın çıktısı bir sonrakine dosya olarak geçer (`.ai-cockpit/run/<adım>.md`).
4. **İnsan kapısı**: `gate` adımında akış durur. Kapı, Kararlar sayfasının **Bekleyen** sekmesinde görünür: rapor, "Onayla", "Şu adıma geri gönder" (not ile).
5. **Gözlem ve sürdürme**: adım durumu (bekliyor, çalışıyor, bitti, hata, kapıda), süre, maliyet, log. Hatalı adımı yeniden dene; herhangi bir adımdan yeniden başlat.
6. **Hazır akışlar**: bugünkü çalışma şeklimizden üç şablon: `ozellik` (Netleştir, Uygula, İncele, Test, Kabul), `hata` (Yeniden üret, Düzelt, İncele, Test, Kabul), `inceleme-turu` (İncele, Düzelt, Yeniden incele).
7. **Görev bağı**: her akış koşusu göreve bağlanır; görev satırında hangi adımda olduğu, toplam maliyeti görünür.

## Hedef olmayanlar

- Docker sandbox. İzolasyon iş tahtasının worktree'si ile sağlanır.
- Çok kullanıcılı sunucu, hesaplar, kayıt sayfası. Kokpit kişiseldir; ekip iş tahtası üzerinden çalışır.
- Main Bot sohbet arayüzü, WeCom ya da bot entegrasyonları.
- Görsel sürükle-bırak akış tasarımcısı. Akış YAML ile yazılır; kokpit onu salt okunur diyagram olarak gösterir.
- Ajanın push etmesi. Push ve PR, bugünkü gibi kullanıcı onayıyla.

## Kaçınılacaklar (başarısızlık sayılır)

- Akışın kullanıcıdan habersiz ilerleyip push, PR ya da issue yazması. Dışa yazan her adım bir kapıdan sonra gelir.
- Depodaki akış dosyasının keyfi komut çalıştırması. `script` adımları ilk çalıştırmada gösterilir ve depo bazında onaylanır (Worktrunk hook'larındaki kural gibi).
- Bir adımın sessizce başarısız olması. Ajan sıfırdan farklı kodla çıkarsa ya da beklenen çıktı dosyası yoksa adım hata olur.
- Maliyet tavanı aşımı. Akış başına isteğe bağlı tavan; aşılınca akış kapıda durur.

## Akış dosyası

```yaml
ad: ozellik
aciklama: Netleştir, uygula, bağımsız incele, test, kabul
adimlar:
  - id: netlestir
    tur: agent
    rol: .ai-cockpit/roller/netlestirici.md
    ajan: claude
    model: sonnet
    cikti: netlesmis.md
  - id: uygula
    tur: agent
    rol: .ai-cockpit/roller/uygulayici.md
    ajan: opencode
    model: zai-coding-plan/glm-5.3
    girdi: [netlesmis.md]
  - id: incele
    tur: agent
    rol: .ai-cockpit/roller/inceleyici.md
    ajan: claude
    model: opus
    cikti: inceleme.md
    basarisizsa: uygula        # inceleme "düzelt" derse bir kez geri döner
    en_cok_tur: 2
  - id: test
    tur: script
    komut: npm test
  - id: kabul
    tur: gate
    gosterilen: [inceleme.md]
    geri_gonderilebilir: [uygula, incele]
```

## Bağlantılar

- **Kararlar** (2026-11-16-kararlar-design.md): `gate` adımları Bekleyen sekmesine aynı `Decision` modeliyle düşer (`reason: "confirmation"`, `metadata.kind = "gate"`). Burada cevap kokpitten verilebilir, çünkü akışı kokpit yürütüyor.
- **İş tahtası**: akış görevin worktree'sinde ve brief'iyle çalışır. Teslim adımı bugünkü PR/birleştirme önizlemesini kullanır.
- **Ajan başlatma**: mevcut run-spawner'lar başsız modda kullanılır; yeni ajan entegrasyonu yazılmaz.

## Açık sorular

1. İlk hangi şablonla başlanacak: `ozellik`, `hata` ya da `inceleme-turu`?
2. Akış motoru kokpit sunucusunda mı çalışsın (sunucu kapanınca akış durur, açılınca kaldığı adımdan devam eder), yoksa ayrı bir arka plan süreci mi?
3. Kabul kapısı dışında varsayılan kapı: uygulamadan önce plan onayı da istensin mi?
