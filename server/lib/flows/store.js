/**
 * @file store.js
 * @description Synchronous SQLite state store for the flow (akislar) engine.
 * @author Caglar Ulkuderner
 */
const crypto = require("node:crypto");

const RUN_COLS = [
  "status",
  "current_step",
  "gate_note",
  "cost_usd",
  "cost_cap_usd",
  "task",
  "ended_at",
];
const STEP_COLS = ["status", "exit_code", "session_id", "log_path", "note", "cost_usd", "ended_at"];
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function update(db, table, cols, id, patch) {
  const keys = Object.keys(patch);
  const bad = keys.find((k) => !cols.includes(k));
  if (bad) throw new Error(`Bilinmeyen alan: ${bad}`);
  if (!keys.length) return;
  db.prepare(
    `UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`
  ).run({ ...patch, id });
}

function createRun(db, { repo, cwd, task, flow, flowHash = null, status = "running" }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO flow_runs (id, repo, cwd, task, flow, flow_json, status, cost_cap_usd, flow_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    repo,
    cwd,
    task ?? null,
    flow.ad,
    JSON.stringify(flow),
    status,
    flow.maliyet_tavani ?? null,
    flowHash
  );
  return db.prepare("SELECT * FROM flow_runs WHERE id = ?").get(id);
}

function getRun(db, id) {
  const run = db.prepare("SELECT * FROM flow_runs WHERE id = ?").get(id);
  if (!run) return null;
  const steps = db.prepare("SELECT * FROM flow_steps WHERE run_id = ? ORDER BY id").all(id);
  const { flow_json: json, ...rest } = run;
  return { ...rest, flow: JSON.parse(json), steps };
}

function listRuns(db, { repo, cwd, status, task } = {}) {
  const where = [];
  const args = [];
  for (const [col, v] of [
    ["repo", repo],
    ["cwd", cwd],
    ["status", status],
    ["task", task],
  ]) {
    if (v != null) {
      where.push(`${col} = ?`);
      args.push(v);
    }
  }
  const sql = `SELECT * FROM flow_runs${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC, rowid DESC`;
  return db.prepare(sql).all(...args);
}

const activeRunForCwd = (db, cwd) =>
  db
    .prepare("SELECT * FROM flow_runs WHERE cwd = ? AND status IN ('running','gate') LIMIT 1")
    .get(cwd) ?? null;

const setRun = (db, id, patch) => update(db, "flow_runs", RUN_COLS, id, patch);

function startStep(db, runId, step, status = "running") {
  const round = roundsOf(db, runId, step) + 1;
  const info = db
    .prepare(
      `INSERT INTO flow_steps (run_id, step, round, status, started_at) VALUES (?, ?, ?, ?, ${NOW})`
    )
    .run(runId, step, round, status);
  return db.prepare("SELECT * FROM flow_steps WHERE id = ?").get(info.lastInsertRowid);
}

const finishStep = (db, rowId, patch) => update(db, "flow_steps", STEP_COLS, rowId, patch);

const lastStep = (db, runId, step) =>
  db
    .prepare("SELECT * FROM flow_steps WHERE run_id = ? AND step = ? ORDER BY id DESC LIMIT 1")
    .get(runId, step) ?? null;

const roundsOf = (db, runId, step) =>
  db.prepare("SELECT COUNT(*) AS n FROM flow_steps WHERE run_id = ? AND step = ?").get(runId, step)
    .n;

// Rows that actually ran an agent or script (they get a log path); gate rows held before a run do not count.
const executedRounds = (db, runId, step) =>
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM flow_steps WHERE run_id = ? AND step = ? AND log_path IS NOT NULL"
    )
    .get(runId, step).n;

function addCost(db, runId, rowId, usd) {
  db.prepare("UPDATE flow_steps SET cost_usd = cost_usd + ? WHERE id = ?").run(usd, rowId);
  db.prepare("UPDATE flow_runs SET cost_usd = cost_usd + ? WHERE id = ?").run(usd, runId);
}

function markInterrupted(db) {
  return db.transaction(() => {
    const ids = db
      .prepare("SELECT DISTINCT run_id FROM flow_steps WHERE status = 'running'")
      .all()
      .map((r) => r.run_id);
    db.prepare(
      `UPDATE flow_steps SET status = 'interrupted', ended_at = ${NOW} WHERE status = 'running'`
    ).run();
    const upd = db.prepare("UPDATE flow_runs SET status = 'interrupted' WHERE id = ?");
    ids.forEach((id) => upd.run(id));
    return ids;
  })();
}

const isFlowApproved = (db, repo, flow, hash) =>
  !!db
    .prepare("SELECT 1 FROM flow_approvals WHERE repo = ? AND flow = ? AND hash = ?")
    .get(repo, flow, hash);

const approveFlow = (db, repo, flow, hash) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO flow_approvals (repo, flow, hash, approved_at) VALUES (?, ?, ?, ${NOW})`
    )
    .run(repo, flow, hash);

module.exports = {
  createRun,
  getRun,
  listRuns,
  activeRunForCwd,
  setRun,
  startStep,
  finishStep,
  lastStep,
  roundsOf,
  executedRounds,
  addCost,
  markInterrupted,
  isFlowApproved,
  approveFlow,
};
