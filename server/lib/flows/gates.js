/**
 * @file gates.js
 * @description Gate steps of flow (akislar) runs: Kararlar entries for open gates and answering them.
 * @author Caglar Ulkuderner
 */
const store = require("./store");

const ROUND_LIMIT = "Tur sınırı aşıldı";
const COST_CAP = "Maliyet tavanı aşıldı";
const SCRIPT_PREFIX = "Script onayı: ";
const now = () => new Date().toISOString();

const fail = (status, message) => Object.assign(new Error(message), { status });
const gateKind = (note) =>
  note === ROUND_LIMIT
    ? "round"
    : note === COST_CAP
      ? "cost"
      : note?.startsWith(SCRIPT_PREFIX)
        ? "script"
        : "gate";

// Gate answers are stored in the row's note as JSON; the original note lives on in `gate`.
function parseAnswer(note) {
  try {
    const v = JSON.parse(note);
    return v && typeof v === "object" && "answer" in v ? v : null;
  } catch {
    return null;
  }
}

function sendBackTargets(step, kind) {
  if (kind === "round") return step.basarisizsa ? [step.basarisizsa] : [];
  if (kind === "gate") return step.geri_gonderilebilir || [];
  return [];
}

function toDecision(row) {
  const flow = JSON.parse(row.flow_json);
  const step = flow.adimlar.find((s) => s.id === row.step) || {};
  const answer = parseAnswer(row.note);
  const original = answer ? answer.gate : row.note;
  const decision = {
    id: `flow:${row.run_id}:${row.step}:${row.round}`,
    sessionId: "",
    project: row.repo,
    agent: "cockpit",
    reason: "confirmation",
    header: flow.ad,
    message: step.mesaj || original || "Kabul bekleniyor",
    options: [],
    multiSelect: false,
    askedAt: row.started_at,
    selected: [],
    other: false,
    metadata: {
      kind: "gate",
      runId: row.run_id,
      step: row.step,
      shown: step.gosterilen || (step.cikti ? [step.cikti] : []),
      sendBack: sendBackTargets(step, gateKind(original)),
    },
  };
  if (answer) {
    decision.status = "resolved";
    decision.payload = { answer: answer.answer, note: answer.note };
    if (row.ended_at) decision.resolvedAt = row.ended_at;
  } else {
    // An open gate is always the run's newest step row; anything else was overtaken.
    const open = row.status === "gate" && row.run_status === "gate" && row.id === row.last_id;
    decision.status = open ? "pending" : "cancelled";
  }
  return decision;
}

function flowDecisions(db, { project } = {}) {
  const rows = db
    .prepare(
      `SELECT fs.*, fr.repo, fr.flow_json, fr.status AS run_status,
              (SELECT MAX(id) FROM flow_steps x WHERE x.run_id = fs.run_id) AS last_id
       FROM flow_steps fs JOIN flow_runs fr ON fr.id = fs.run_id
       WHERE (fs.status = 'gate' OR (fs.status = 'done' AND fs.note LIKE '{"answer"%'))
         ${project ? "AND fr.repo = ?" : ""}`
    )
    .all(...(project ? [project] : []));
  return rows.map(toDecision);
}

function answerGate(db, runner, runId, body = {}) {
  const run = store.getRun(db, runId);
  if (!run) throw fail(404, "Koşu bulunamadı");
  if (run.status !== "gate") throw fail(409, "Koşu kapıda değil");
  const row = [...run.steps].reverse().find((s) => s.status === "gate");
  const step = run.flow.adimlar.find((s) => s.id === row?.step);
  if (!step) throw fail(409, "Açık kapı bulunamadı");
  const kind = gateKind(row.note);
  const { action } = body;
  let next;
  if (action === "approve") {
    if (kind === "script") store.approveScript(db, run.repo, step.komut);
    if (kind === "cost")
      store.setRun(db, runId, { cost_cap_usd: run.cost_cap_usd + run.flow.maliyet_tavani });
    const ids = run.flow.adimlar.map((s) => s.id);
    next = kind === "cost" || kind === "script" ? step.id : ids[ids.indexOf(step.id) + 1];
  } else if (action === "send_back") {
    if (!sendBackTargets(step, kind).includes(body.step))
      throw fail(400, "Bu kapıdan o adıma geri gönderilemez");
    next = body.step;
    store.setRun(db, runId, { gate_note: body.note || null });
  } else {
    throw fail(400, "action approve ya da send_back olmalı");
  }
  const note = JSON.stringify({ answer: action, note: body.note || "", gate: row.note });
  store.finishStep(db, row.id, { status: "done", note, ended_at: now() });
  if (next) {
    store.setRun(db, runId, { current_step: next });
    runner.onGateAnswered(runId);
  } else {
    store.setRun(db, runId, { status: "done", ended_at: now() });
  }
  return store.getRun(db, runId);
}

module.exports = { flowDecisions, answerGate };
