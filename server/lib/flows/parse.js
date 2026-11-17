/**
 * @file parse.js
 * @description Pure parser and validator for repo-defined flow (akis) YAML files.
 * @author Caglar Ulkuderner
 */
const yaml = require("js-yaml");

const AGENTS = ["claude", "opencode"];
const TURLER = ["agent", "script", "gate"];

function fail(msg) {
  throw Object.assign(new Error(msg), { code: "EFLOW" });
}

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const strList = (v) => Array.isArray(v) && v.every(isStr);

// shortcut: only "..", absolute and drive-letter paths are rejected; symlinks are not resolved here.
function safePath(p) {
  return !/^([/\\]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes("..");
}

function parseFlow(text) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    const line = err.mark ? err.mark.line + 1 : "?";
    fail(`Akış dosyası geçersiz YAML (satır ${line}): ${err.reason || err.message}`);
  }
  if (!doc || typeof doc !== "object") fail("Akış dosyası boş ya da nesne değil");
  if (!isStr(doc.ad)) fail("ad alanı gerekli");
  if (!Array.isArray(doc.adimlar) || doc.adimlar.length === 0)
    fail("adimlar alanı gerekli ve boş olamaz");
  if (
    doc.maliyet_tavani != null &&
    !(typeof doc.maliyet_tavani === "number" && doc.maliyet_tavani > 0)
  )
    fail("maliyet_tavani pozitif bir sayı olmalı");

  const ids = [];
  const outputs = new Set();
  const adimlar = doc.adimlar.map((raw, i) => {
    const at = `adimlar[${i}]`;
    if (!raw || typeof raw !== "object") fail(`${at} nesne olmalı`);
    if (!isStr(raw.id)) fail(`${at}.id gerekli`);
    if (ids.includes(raw.id)) fail(`${at}.id tekrar ediyor: ${raw.id}`);
    if (!TURLER.includes(raw.tur)) fail(`${at}.tur geçersiz (agent, script ya da gate olmalı)`);
    const step = { id: raw.id, tur: raw.tur };
    const target = (field, v) => {
      if (!ids.includes(v)) fail(`${at}.${field} yalnız önceki bir adımı gösterebilir: ${v}`);
    };
    const path = (field, v) => {
      if (!isStr(v) || !safePath(v)) fail(`${at}.${field} geçersiz yol: ${v}`);
    };

    if (raw.tur === "agent") {
      if (!isStr(raw.rol)) fail(`${at}.rol gerekli`);
      path("rol", raw.rol);
      if (!isStr(raw.ajan)) fail(`${at}.ajan gerekli`);
      if (!AGENTS.includes(raw.ajan)) {
        fail(
          ["codex", "cursor"].includes(raw.ajan)
            ? `${at}.ajan: ${raw.ajan} henüz desteklenmiyor`
            : `${at}.ajan geçersiz: ${raw.ajan}`
        );
      }
      const girdi = raw.girdi ?? [];
      if (!strList(girdi)) fail(`${at}.girdi metin listesi olmalı`);
      for (const g of girdi) {
        path("girdi", g);
        if (!outputs.has(g)) fail(`${at}.girdi: ${g} dosyasını üreten önceki adım yok`);
      }
      const tur = raw.en_cok_tur ?? 2;
      if (!Number.isInteger(tur) || tur < 1 || tur > 5)
        fail(`${at}.en_cok_tur 1 ile 5 arasında olmalı`);
      const dk = raw.zaman_asimi_dk ?? 60;
      if (!(typeof dk === "number" && dk > 0)) fail(`${at}.zaman_asimi_dk pozitif sayı olmalı`);
      Object.assign(step, {
        rol: raw.rol,
        ajan: raw.ajan,
        girdi,
        en_cok_tur: tur,
        zaman_asimi_dk: dk,
      });
      if (raw.model != null) step.model = String(raw.model);
      if (raw.cikti != null) {
        path("cikti", raw.cikti);
        step.cikti = raw.cikti;
      }
      if (raw.basarisizsa != null) {
        target("basarisizsa", raw.basarisizsa);
        // the runner reads "SONUÇ: TAMAM|DÜZELT" from this step's output
        if (!step.cikti) fail(`${at}.basarisizsa için cikti gerekli`);
        step.basarisizsa = raw.basarisizsa;
      }
    } else if (raw.tur === "script") {
      if (!isStr(raw.komut)) fail(`${at}.komut gerekli`);
      const dk = raw.zaman_asimi_dk ?? 10;
      if (!(typeof dk === "number" && dk > 0)) fail(`${at}.zaman_asimi_dk pozitif sayı olmalı`);
      Object.assign(step, { komut: raw.komut, zaman_asimi_dk: dk });
    } else {
      if (!strList(raw.gosterilen)) fail(`${at}.gosterilen metin listesi olmalı`);
      raw.gosterilen.forEach((g) => path("gosterilen", g));
      const geri = raw.geri_gonderilebilir ?? [];
      if (!strList(geri)) fail(`${at}.geri_gonderilebilir metin listesi olmalı`);
      geri.forEach((g) => target("geri_gonderilebilir", g));
      Object.assign(step, { gosterilen: raw.gosterilen, geri_gonderilebilir: geri });
      if (raw.mesaj != null) step.mesaj = String(raw.mesaj);
    }
    ids.push(step.id);
    if (step.cikti) outputs.add(step.cikti);
    return step;
  });

  const flow = { ad: doc.ad, aciklama: doc.aciklama == null ? "" : String(doc.aciklama), adimlar };
  if (doc.maliyet_tavani != null) flow.maliyet_tavani = doc.maliyet_tavani;
  return flow;
}

module.exports = { parseFlow };
