/**
 * @file Express router for flow (akislar) runs: start, list, gate answers, retry, restart, stop, run files.
 * @author Caglar Ulkuderner
 */
const { Router } = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../db");
const store = require("../lib/flows/store");
const { parseFlow } = require("../lib/flows/parse");
const { createRunner } = require("../lib/flows/runner");
const { answerGate, APPROVAL_STEP, APPROVAL_NOTE } = require("../lib/flows/gates");
const { flowHash, flowPath } = require("../lib/flows/approval");
const { workRepo, checkoutRoot } = require("../lib/plan");

const router = Router();
let runner = createRunner({ db });
// Test hook: swaps the runner so tests never start real agents.
router.__setRunner = (r) => {
  runner = r;
};

router.resumeAll = () => runner.resumeAll();

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    // Unexpected errors may carry local paths: only deliberate failures show their message.
    res.status(err.status || 500).json({ error: err.status ? err.message : "Sunucu hatası" });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v) => (typeof v === "string" && v ? v : undefined);

function needRun(req) {
  const run = store.getRun(db, req.params.id);
  if (!run) throw fail(404, "Koşu bulunamadı");
  return run;
}

function loadFlow(cwd, name) {
  if (!/^[a-z0-9-]+$/.test(name || "")) throw fail(400, "Akış adı yalnız a-z, 0-9 ve - içerebilir");
  let text;
  try {
    text = fs.readFileSync(flowPath(cwd, name), "utf8");
  } catch {
    throw fail(404, "Akış dosyası bulunamadı");
  }
  let flow;
  try {
    flow = parseFlow(text);
  } catch (err) {
    throw fail(400, err.code === "EFLOW" ? err.message : "Akış dosyası okunamadı");
  }
  // The runner re-reads the file by flow name, so the two must agree.
  if (flow.ad !== name) throw fail(400, "Akışın ad alanı dosya adıyla aynı olmalı");
  return { flow, hash: flowHash(cwd, text, flow) };
}

// Starts a new round at `step`; the run's work goes on in the background.
function resumeAt(run, step) {
  if (run.status === "running") throw fail(409, "Koşu zaten çalışıyor");
  store.setRun(db, run.id, { current_step: step, status: "running", ended_at: null });
  runner.start(run.id);
  return store.getRun(db, run.id);
}

router.get(
  "/",
  wrap((req, res) => res.json({ runs: store.listRuns(db, { repo: str(req.query.repo) }) }))
);

const TEMPLATES = path.join(__dirname, "..", "flows-templates");
const templateFiles = (dir) => fs.readdirSync(path.join(TEMPLATES, dir)).sort();

router.get(
  "/templates",
  wrap((req, res) => {
    const templates = templateFiles("akislar").map((f) => {
      const flow = parseFlow(fs.readFileSync(path.join(TEMPLATES, "akislar", f), "utf8"));
      return {
        ad: flow.ad,
        aciklama: flow.aciklama,
        adimlar: flow.adimlar.map(({ id, tur }) => ({ id, tur })),
      };
    });
    res.json({ templates });
  })
);

// Copies templates and role prompts into the repo; existing files are never overwritten.
router.post(
  "/install",
  wrap((req, res) => {
    const cwd = str(req.body?.cwd);
    if (!cwd || !checkoutRoot(cwd)) throw fail(400, "cwd bir git dizini olmalı");
    const copied = [];
    const skipped = [];
    for (const dir of ["akislar", "roller"]) {
      const out = path.join(cwd, ".ai-cockpit", dir);
      fs.mkdirSync(out, { recursive: true });
      for (const f of templateFiles(dir)) {
        const rel = `.ai-cockpit/${dir}/${f}`;
        try {
          fs.copyFileSync(
            path.join(TEMPLATES, dir, f),
            path.join(out, f),
            fs.constants.COPYFILE_EXCL
          );
          copied.push(rel);
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
          skipped.push(rel);
        }
      }
    }
    res.json({ copied, skipped });
  })
);

router.get(
  "/:id",
  wrap((req, res) => res.json({ run: needRun(req) }))
);

router.post(
  "/",
  wrap((req, res) => {
    const cwd = str(req.body?.cwd);
    if (!cwd || !checkoutRoot(cwd)) throw fail(400, "cwd bir git dizini olmalı");
    const { flow, hash } = loadFlow(cwd, req.body.flow);
    if (store.activeRunForCwd(db, cwd)) throw fail(409, "Bu dizinde zaten etkin bir koşu var");
    const repo = workRepo(cwd);
    const approved = store.isFlowApproved(db, fs.realpathSync(repo), flow.ad, hash);
    const run = store.createRun(db, {
      repo,
      cwd,
      task: str(req.body.task),
      flow,
      flowHash: hash,
      status: approved ? "running" : "gate",
    });
    store.setRun(db, run.id, { current_step: flow.adimlar[0].id });
    if (approved) runner.start(run.id);
    else
      store.finishStep(db, store.startStep(db, run.id, APPROVAL_STEP, "gate").id, {
        note: APPROVAL_NOTE,
      });
    res.status(201).json({ run: store.getRun(db, run.id) });
  })
);

router.post(
  "/:id/gate",
  wrap((req, res) => res.json({ run: answerGate(db, runner, req.params.id, req.body) }))
);

router.post(
  "/:id/retry",
  wrap((req, res) => {
    const run = needRun(req);
    const bad = [...run.steps].reverse().find((s) => ["failed", "interrupted"].includes(s.status));
    if (!bad) throw fail(409, "Yeniden denenecek adım yok");
    res.status(202).json({ run: resumeAt(run, bad.step) });
  })
);

router.post(
  "/:id/restart",
  wrap((req, res) => {
    const run = needRun(req);
    const step = req.body?.step;
    if (!run.flow.adimlar.some((s) => s.id === step)) throw fail(400, "Bilinmeyen adım");
    res.status(202).json({ run: resumeAt(run, step) });
  })
);

router.post(
  "/:id/stop",
  wrap((req, res) => {
    needRun(req);
    runner.stop(req.params.id);
    res.json({ run: store.getRun(db, req.params.id) });
  })
);

router.get(
  "/:id/file",
  wrap((req, res) => {
    const run = needRun(req);
    const rel = str(req.query.path);
    if (!rel) throw fail(400, "path gerekli");
    let base;
    try {
      base = fs.realpathSync(path.join(run.cwd, ".ai-cockpit", "run"));
    } catch {
      throw fail(404, "Dosya bulunamadı");
    }
    const inside = (p) => p.startsWith(base + path.sep);
    const wanted = path.resolve(base, rel);
    if (!inside(wanted)) throw fail(400, "Yalnız koşu dosyaları okunabilir");
    let real;
    try {
      real = fs.realpathSync(wanted);
    } catch {
      throw fail(404, "Dosya bulunamadı");
    }
    if (!inside(real)) throw fail(400, "Yalnız koşu dosyaları okunabilir");
    res
      .type("text/plain")
      .set({ "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" })
      .send(fs.readFileSync(real, "utf8"));
  })
);

module.exports = router;
