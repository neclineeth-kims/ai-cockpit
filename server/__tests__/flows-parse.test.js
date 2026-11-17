/**
 * @file Verifies the flow file parser and its validation errors.
 * @author Caglar Ulkuderner
 */
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { parseFlow } = require("../lib/flows/parse");

const VALID = `
ad: ozellik
aciklama: Netlestir, uygula, incele, test, kabul
maliyet_tavani: 5
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
    cikti: inceleme.md
    basarisizsa: uygula
    en_cok_tur: 2
  - id: test
    tur: script
    komut: npm test
  - id: kabul
    tur: gate
    gosterilen: [inceleme.md]
    geri_gonderilebilir: [uygula, incele]
`;

const flowWith = (steps) => "ad: x\nadimlar:\n" + steps;
const agent = (extra = "", id = "a") =>
  `  - id: ${id}\n    tur: agent\n    rol: r.md\n    ajan: claude\n${extra}`;

function fails(text, re) {
  assert.throws(
    () => parseFlow(text),
    (err) => err.code === "EFLOW" && re.test(err.message)
  );
}

it("parses a valid flow", () => {
  const f = parseFlow(VALID);
  assert.equal(f.ad, "ozellik");
  assert.equal(f.maliyet_tavani, 5);
  assert.equal(f.adimlar.length, 5);
  const [n, u, i, t, k] = f.adimlar;
  assert.deepEqual(n.girdi, []);
  assert.equal(n.en_cok_tur, 2);
  assert.equal(n.zaman_asimi_dk, 60);
  assert.deepEqual(u.girdi, ["netlesmis.md"]);
  assert.equal(i.basarisizsa, "uygula");
  assert.equal(t.zaman_asimi_dk, 10);
  assert.deepEqual(k.geri_gonderilebilir, ["uygula", "incele"]);
});

it("rejects unknown step type", () => {
  fails(flowWith(agent() + "  - id: b\n    tur: foo\n"), /adimlar\[1\]\.tur/);
});

it("rejects missing fields", () => {
  fails(flowWith("  - id: a\n    tur: agent\n    ajan: claude\n"), /adimlar\[0\]\.rol/);
  fails(flowWith("  - id: a\n    tur: script\n"), /adimlar\[0\]\.komut/);
});

it("rejects duplicate ids", () => {
  fails(flowWith(agent("", "a") + agent("", "a")), /adimlar\[1\]\.id/);
});

it("rejects unknown or forward targets", () => {
  fails(flowWith(agent("    basarisizsa: yok\n")), /adimlar\[0\]\.basarisizsa/);
  fails(flowWith(agent("    basarisizsa: b\n") + agent("", "b")), /adimlar\[0\]\.basarisizsa/);
  fails(
    flowWith(
      agent() + "  - id: g\n    tur: gate\n    gosterilen: []\n    geri_gonderilebilir: [zz]\n"
    ),
    /adimlar\[1\]\.geri_gonderilebilir/
  );
});

it("rejects input with no producer", () => {
  fails(flowWith(agent("    girdi: [x.md]\n")), /adimlar\[0\]\.girdi/);
});

it("rejects unsupported agent", () => {
  fails(
    flowWith("  - id: a\n    tur: agent\n    rol: r.md\n    ajan: codex\n"),
    /henüz desteklenmiyor/
  );
});

it("rejects path escape", () => {
  fails(
    flowWith("  - id: a\n    tur: agent\n    rol: ../r.md\n    ajan: claude\n"),
    /adimlar\[0\]\.rol/
  );
  fails(flowWith(agent("    cikti: /etc/x\n")), /adimlar\[0\]\.cikti/);
  fails(flowWith(agent("    cikti: a/../../x\n")), /adimlar\[0\]\.cikti/);
  fails(
    flowWith(agent("    cikti: x.md\n") + agent("    girdi: [../x.md]\n", "b")),
    /adimlar\[1\]\.girdi/
  );
});

it("rejects bad yaml with line", () => {
  fails("ad: x\nadimlar: [\n  - a: : b\n", /satır \d+/);
});

it("en_cok_tur bounds", () => {
  fails(flowWith(agent("    en_cok_tur: 0\n")), /adimlar\[0\]\.en_cok_tur/);
  fails(flowWith(agent("    en_cok_tur: 6\n")), /adimlar\[0\]\.en_cok_tur/);
  assert.equal(parseFlow(flowWith(agent("    en_cok_tur: 5\n"))).adimlar[0].en_cok_tur, 5);
});
