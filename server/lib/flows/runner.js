/**
 * @file runner.js
 * @description Step-by-step executor for flow (akislar) runs. All store access is synchronous;
 * only agent and script runs are awaited.
 * @author Caglar Ulkuderner
 */
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store");

const RUN_DIR = ".ai-cockpit/run";
const RESULT_RE = /^SONUÇ:\s*(TAMAM|DÜZELT)\s*$/;

const now = () => new Date().toISOString();
const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

function buildPrompt(run, step) {
  const parts = [fs.readFileSync(path.join(run.cwd, step.rol), "utf8")];
  const brief = readIf(path.join(run.cwd, ".ai-cockpit", "brief.md"));
  if (brief != null) parts.push(`## Görev\n${brief}`);
  for (const ad of step.girdi) {
    parts.push(`## Girdi: ${ad}\n${fs.readFileSync(path.join(run.cwd, RUN_DIR, ad), "utf8")}`);
  }
  if (run.gate_note) parts.push(`## Kapı notu\n${run.gate_note}`);
  if (step.cikti) {
    let line = `Çıktını ${RUN_DIR}/${step.cikti} dosyasına yaz.`;
    if (step.basarisizsa) line += '\nİlk satır "SONUÇ: TAMAM" ya da "SONUÇ: DÜZELT" olsun.';
    parts.push(line);
  }
  return parts.join("\n\n");
}

// Keeps the previous round's output as <name>.tur<N>.md before the step runs again.
function keepPreviousOutput(run, step, previousRound) {
  if (!step.cikti || previousRound < 1) return;
  const file = path.join(run.cwd, RUN_DIR, step.cikti);
  if (!fs.existsSync(file)) return;
  const { dir, name, ext } = path.parse(file);
  fs.renameSync(file, path.join(dir, `${name}.tur${previousRound}${ext || ".md"}`));
}

function createRunner({ db, agents = require("./agents") }) {
  const active = new Set();
  const kills = new Map();

  const setRun = (id, patch) => store.setRun(db, id, patch);

  function toGate(run, step, note, row) {
    const r = row || store.startStep(db, run.id, step.id, "gate");
    store.finishStep(db, r.id, { status: "gate", note });
    setRun(run.id, { status: "gate", current_step: step.id });
  }

  function fail(run, row, note) {
    store.finishStep(db, row.id, { status: "failed", note, ended_at: now() });
    setRun(run.id, { status: "failed", ended_at: now() });
  }

  // Marks the step done and moves current_step on; `target` overrides the next step (send-back).
  function advance(run, row, step, target) {
    store.finishStep(db, row.id, { status: "done", ended_at: now() });
    const ids = run.flow.adimlar.map((s) => s.id);
    const next = target || ids[ids.indexOf(step.id) + 1];
    if (next) setRun(run.id, { current_step: next });
    else setRun(run.id, { status: "done", ended_at: now() });
  }

  // Awaits a handle while keeping its kill function reachable for stop().
  async function awaitHandle(runId, handle) {
    kills.set(runId, handle.kill);
    try {
      return await handle.promise;
    } finally {
      kills.delete(runId);
    }
  }

  const stillRunning = (runId) => store.getRun(db, runId).status === "running";

  async function execAgent(run, step) {
    if (run.cost_cap_usd != null && run.cost_usd >= run.cost_cap_usd) {
      return toGate(run, step, "Maliyet tavanı aşıldı");
    }
    const round = store.roundsOf(db, run.id, step.id) + 1;
    keepPreviousOutput(run, step, round - 1);
    const logPath = path.join(run.cwd, RUN_DIR, "log", `${step.id}-${round}.log`);
    const row = store.startStep(db, run.id, step.id);
    store.finishStep(db, row.id, { log_path: logPath });
    let res;
    try {
      const prompt = buildPrompt(run, step);
      if (run.gate_note) setRun(run.id, { gate_note: null });
      res = await awaitHandle(
        run.id,
        agents.runAgent({
          ajan: step.ajan,
          model: step.model,
          prompt,
          cwd: run.cwd,
          logPath,
          timeoutMs: step.zaman_asimi_dk * 60000,
        })
      );
    } catch (err) {
      return fail(run, row, `Ajan çalıştırılamadı: ${err.message}`);
    }
    if (!stillRunning(run.id)) return;
    if (res.sessionId) {
      store.finishStep(db, row.id, { session_id: res.sessionId });
      store.addCost(db, run.id, row.id, agents.sessionCostUsd(db, res.sessionId));
    }
    store.finishStep(db, row.id, { exit_code: res.exitCode });
    if (res.exitCode !== 0) return fail(run, row, `Ajan ${res.exitCode} koduyla çıktı`);
    judgeOutput(run, step, row);
  }

  function judgeOutput(run, step, row) {
    if (!step.cikti) return advance(run, row, step);
    const text = readIf(path.join(run.cwd, RUN_DIR, step.cikti));
    if (text == null) return fail(run, row, `Çıktı dosyası yazılmadı: ${step.cikti}`);
    if (!step.basarisizsa) return advance(run, row, step);
    const verdict = (text.split(/\r?\n/)[0].match(RESULT_RE) || [])[1];
    if (verdict === "TAMAM") return advance(run, row, step);
    if (verdict !== "DÜZELT")
      return fail(run, row, 'İlk satır "SONUÇ: TAMAM" ya da "SONUÇ: DÜZELT" olmalı');
    if (store.roundsOf(db, run.id, step.id) >= step.en_cok_tur) {
      return toGate(run, step, "Tur sınırı aşıldı", row);
    }
    advance(run, row, step, step.basarisizsa);
  }

  async function execScript(run, step) {
    if (!store.isScriptApproved(db, run.repo, step.komut)) {
      return toGate(run, step, `Script onayı: ${step.komut}`);
    }
    const round = store.roundsOf(db, run.id, step.id) + 1;
    const logPath = path.join(run.cwd, RUN_DIR, "log", `${step.id}-${round}.log`);
    const row = store.startStep(db, run.id, step.id);
    store.finishStep(db, row.id, { log_path: logPath });
    let res;
    try {
      res = await awaitHandle(
        run.id,
        agents.runScript({
          komut: step.komut,
          cwd: run.cwd,
          logPath,
          timeoutMs: step.zaman_asimi_dk * 60000,
        })
      );
    } catch (err) {
      return fail(run, row, `Script çalıştırılamadı: ${err.message}`);
    }
    if (!stillRunning(run.id)) return;
    store.finishStep(db, row.id, { exit_code: res.exitCode });
    if (res.exitCode !== 0) return fail(run, row, `Script ${res.exitCode} koduyla çıktı`);
    advance(run, row, step);
  }

  async function execStep(run, step) {
    setRun(run.id, { current_step: step.id });
    if (step.tur === "agent") return execAgent(run, step);
    if (step.tur === "script") return execScript(run, step);
    toGate(run, step, step.mesaj ?? null);
  }

  async function loop(runId) {
    for (;;) {
      const run = store.getRun(db, runId);
      if (!run || run.status !== "running") return;
      const steps = run.flow.adimlar;
      const step = steps.find((s) => s.id === run.current_step) || steps[0];
      await execStep(run, step);
    }
  }

  async function start(runId) {
    if (active.has(runId)) return;
    active.add(runId);
    try {
      await loop(runId);
    } finally {
      active.delete(runId);
    }
  }

  function resumeAll() {
    const ids = store.markInterrupted(db);
    ids.forEach((id) => setRun(id, { status: "running" }));
    return Promise.all(ids.map(start));
  }

  const onGateAnswered = (runId) => {
    setRun(runId, { status: "running" });
    return start(runId);
  };

  function stop(runId) {
    kills.get(runId)?.();
    const running = store.getRun(db, runId)?.steps.find((s) => s.status === "running");
    if (running) store.finishStep(db, running.id, { status: "stopped", ended_at: now() });
    setRun(runId, { status: "stopped", ended_at: now() });
  }

  return { start, resumeAll, onGateAnswered, stop };
}

module.exports = { createRunner };
