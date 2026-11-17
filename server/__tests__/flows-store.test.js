/**
 * @file Verifies the flow (akislar) SQLite state store against a temporary database.
 * @author Caglar Ulkuderner
 */
const { it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-flows-store-"));
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.DASHBOARD_CODEX_HOME = path.join(root, "codex");
process.env.DASHBOARD_DATA_DIR = path.join(root, "data");
process.env.DASHBOARD_DB_PATH = path.join(root, "test.db");
const { db } = require("../db");
const store = require("../lib/flows/store");
after(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const FLOW = {
  ad: "f",
  aciklama: "",
  maliyet_tavani: 3,
  adimlar: [{ id: "a", tur: "script", komut: "x" }],
};
const mk = (cwd) => store.createRun(db, { repo: "/r", cwd, task: "t", flow: FLOW });

it("creates and reads a run", () => {
  const run = mk("/w/read");
  assert.equal(run.flow, "f");
  assert.equal(run.cost_cap_usd, 3);
  const got = store.getRun(db, run.id);
  assert.deepEqual(got.flow, FLOW);
  assert.deepEqual(got.steps, []);
  assert.equal(store.getRun(db, "yok"), null);
  assert.ok(store.listRuns(db, { cwd: "/w/read" }).some((r) => r.id === run.id));
});

it("round number increases per step", () => {
  const run = mk("/w/round");
  const r1 = store.startStep(db, run.id, "a");
  store.finishStep(db, r1.id, { status: "done", exit_code: 0 });
  const r2 = store.startStep(db, run.id, "a");
  assert.equal(r1.round, 1);
  assert.equal(r2.round, 2);
  assert.equal(store.roundsOf(db, run.id, "a"), 2);
  assert.equal(store.lastStep(db, run.id, "a").id, r2.id);
  assert.equal(store.lastStep(db, run.id, "yok"), null);
});

it("activeRunForCwd returns only running and gate", () => {
  const run = mk("/w/active");
  assert.equal(store.activeRunForCwd(db, "/w/active").id, run.id);
  store.setRun(db, run.id, { status: "gate" });
  assert.equal(store.activeRunForCwd(db, "/w/active").id, run.id);
  for (const s of ["done", "failed", "stopped", "interrupted"]) {
    store.setRun(db, run.id, { status: s });
    assert.equal(store.activeRunForCwd(db, "/w/active"), null);
  }
});

it("markInterrupted touches only running steps and their runs", () => {
  const a = mk("/w/int-a");
  const b = mk("/w/int-b");
  const done = store.startStep(db, a.id, "a");
  store.finishStep(db, done.id, { status: "done" });
  const live = store.startStep(db, a.id, "b");
  const other = store.startStep(db, b.id, "a");
  store.finishStep(db, other.id, { status: "done" });
  store.setRun(db, b.id, { status: "gate" });
  const ids = store.markInterrupted(db);
  assert.ok(ids.includes(a.id));
  assert.ok(!ids.includes(b.id));
  const got = store.getRun(db, a.id);
  assert.equal(got.status, "interrupted");
  assert.equal(got.steps.find((s) => s.id === live.id).status, "interrupted");
  assert.equal(got.steps.find((s) => s.id === done.id).status, "done");
  assert.equal(store.getRun(db, b.id).status, "gate");
});

it("sums cost on step and run", () => {
  const run = mk("/w/cost");
  const s = store.startStep(db, run.id, "a");
  store.addCost(db, run.id, s.id, 0.25);
  store.addCost(db, run.id, s.id, 0.5);
  const got = store.getRun(db, run.id);
  assert.equal(got.cost_usd, 0.75);
  assert.equal(got.steps[0].cost_usd, 0.75);
});

it("flow approval is per repo, flow and hash", () => {
  assert.equal(store.isFlowApproved(db, "/r", "f", "h1"), false);
  store.approveFlow(db, "/r", "f", "h1");
  store.approveFlow(db, "/r", "f", "h1");
  assert.equal(store.isFlowApproved(db, "/r", "f", "h1"), true);
  assert.equal(store.isFlowApproved(db, "/r2", "f", "h1"), false);
  assert.equal(store.isFlowApproved(db, "/r", "g", "h1"), false);
  assert.equal(store.isFlowApproved(db, "/r", "f", "h2"), false);
});
