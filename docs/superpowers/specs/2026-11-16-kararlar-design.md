# Kararlar: sorulan sorular, verilen kararlar, tasarımlar

Durum: taslak, planlamaya alındı (16 Kasım 2026)
Esin kaynağı: [AG-UI](https://github.com/ag-ui-protocol/ag-ui) (MIT), özellikle "interrupt" yaşam döngüsü ve insan-onay akışları.

## Neden

Ajanlar çalışırken soru soruyor (Claude Code `AskUserQuestion`), plan onayı istiyor (`ExitPlanMode`) ve tasarım dosyaları üretiyor (spec, HTML taslak, kanvas). Bunların hepsi şu an oturum dökümlerinin içinde kayboluyor. Bir hafta sonra "bunu neden böyle yaptık" diye sorduğunda cevabı bulmak için oturum oturum gezmek gerekiyor; ajan da aynı soruyu yeniden soruyor.

Kokpitin veritabanında bu veri zaten var: hook olayları `events.data` içinde `tool_input.questions`, `tool_input.answers`, `tool_input.annotations` ve `tool_input.plan` olarak saklanıyor (16 Kasım itibarıyla 707 cevaplanmış soru, 15 plan onayı). Eksik olan onu okunur kılan ekran.

AG-UI bu işin ortak dilini tanımlıyor: ajan bir **interrupt** ile durur (`reason`: `input_required`, `confirmation`, `tool_call`), istemci bir **resume** ile cevap verir (`status`, `payload`). Bu modeli içeride kullanırsak kendi verimiz standart bir şekle oturur ve ileride AG-UI konuşan ajanlar (Mastra, LangGraph, Claude Agent SDK bağdaştırıcıları) aynı ekrana bağlanabilir.

## Hedefler

1. **Karar günlüğü**: her projede ajanların sorduğu sorular, seçenekler, verilen cevap, varsa not; tarih ve oturum bağlantısıyla.
2. **Bekleyen sorular**: cevap bekleyen soru ve plan onaylarını tek yerde göstermek (hangi oturum, ne zamandır bekliyor).
3. **Planlar ve tasarımlar**: onaylanan/reddedilen planlar ile ajanların yazdığı tasarım dosyaları (spec, HTML taslak, kanvas) proje bazında listelenir.
4. **Ajana geri besleme**: iş tahtasının brief'ine o depodaki ilgili önceki kararlar girer; ajan aynı soruyu tekrar sormaz.
5. **AG-UI şekli**: iç model AG-UI `Interrupt` ve `resume` alanlarıyla birebir eşlenir; dışa aktarım bu şekilde yapılır.

## Hedef olmayanlar

- CopilotKit ya da AG-UI SDK bağımlılığı (K1-K3 için yalnız veri şekli alınır; kod alınmaz).
- Sohbet arayüzü, üretken UI bileşenleri, paylaşılan durum (shared state). Kokpit izleme aracıdır, ajan ön yüzü değil.
- Claude Code oturumlarındaki soruyu kokpitten cevaplamak. Claude Code'un dışarıdan cevap alacağı bir kanal yok; bu ekran onları yalnız gösterir.

## Kaçınılacaklar (başarısızlık sayılır)

- Kararların makineden dışarı çıkması. Her şey yerel veritabanından okunur; dışa aktarım yalnız kullanıcı isteğiyle dosyaya yazılır.
- Brief'e ilgisiz ya da çok uzun karar listesi girmesi (32 KB tavanı korunur; kararlar en çok 4 KB).
- Yeni bir hook ya da ajan tarafı ayar gerektirmesi. Mevcut olaylar yeterli.

## İç model (AG-UI eşlemesi)

```ts
type Decision = {
  id: string;                 // `${eventId}:${index}`
  project: string;            // cwd'den çözülen depo (plan keşfindeki workRepo)
  sessionId: string;
  agent: "claude" | "codex" | "cursor" | "ag-ui";
  reason: "input_required" | "confirmation" | "plan_approval";
  header?: string;            // AskUserQuestion header
  message: string;            // soru metni ya da plan özeti
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  status: "pending" | "resolved" | "cancelled";
  payload?: { answer?: string | string[]; note?: string; plan?: string };
  askedAt: string;
  resolvedAt?: string;
};
```

| Kaynak | reason | status kuralı |
| --- | --- | --- |
| `AskUserQuestion` PreToolUse | `input_required` | eşleşen PostToolUse yoksa `pending` |
| `AskUserQuestion` PostToolUse | `input_required` | `answers` içinde cevap varsa `resolved`, yoksa `cancelled` |
| `ExitPlanMode` Pre/Post | `plan_approval` | PostToolUse varsa `resolved` (onaylandı), oturum sonraki istemle devam ettiyse ve Post yoksa `cancelled` |

AG-UI dışa aktarımında: `reason` aynen (`plan_approval` -> `confirmation` + `metadata.kind = "plan"`), `responseSchema` seçeneklerden üretilir (`enum`), cevap `resume: [{ interruptId, status, payload }]` olarak yazılır.

"Bekliyor" ile "terk edildi" ayrımı: PreToolUse var, PostToolUse yok ve oturumda daha yeni bir olay varsa `cancelled`; oturumun son olayı buysa `pending`.

## Ekran

Yeni sayfa: **Kararlar** (gezinmede Plan'ın yanında).

- Üstte proje seçici (Plan sayfasındaki keşif listesiyle aynı) ve arama.
- Sekmeler: **Bekleyen** (sayaç rozeti), **Kararlar**, **Planlar**, **Tasarımlar**.
- Karar satırı: başlık etiketi, soru, seçenekler (seçilen vurgulu, açıklaması altta), not, tarih, oturuma bağlantı.
- Plan satırı: ilk başlık ve ilk satırlar, onay durumu, açılınca tam plan (Markdown).
- Tasarım satırı: dosya yolu, türü (spec, HTML taslak, kanvas, görsel), yazan oturum, tarih; HTML taslak için yeni sekmede aç.
- Panel: bekleyen soru varsa üst şeritte "N soru cevap bekliyor" bağlantısı.

Görsel taslak kodlamadan önce `docs/superpowers/specs/` altına HTML olarak hazırlanır ve onaya sunulur.

## Kapsam dışı, sonraya

- **K5 AG-UI girişi**: `POST /api/ag-ui/events` ile AG-UI olay akışını (RUN_STARTED, TOOL_CALL_*, RUN_FINISHED + interrupt) alıp aynı tablolara yazmak.
- **K6 Kokpitten cevap**: Ajan Çalıştır sayfasından başlatılan ve resume destekleyen ajanlar için bekleyen soruyu kokpitten cevaplamak.
- Codex ve Cursor'un soru olayları: hangi olay adıyla geldikleri doğrulanınca eklenir.

## Açık sorular

1. Tasarım dosyası sayılacak yollar: `docs/superpowers/specs/**`, `design/**`, `*.dc.html` ve görseller yeterli mi?
2. Brief'e giren kararlar: aynı depodaki son 20 karar mı, yoksa görevin `Alan:` desenine dokunan oturumlardaki kararlar mı?
3. K5 ve K6 bu planın içine mi girsin, ayrı faz mı olsun?
