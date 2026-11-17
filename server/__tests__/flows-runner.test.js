/**
 * @file Verifies the flow (akislar) executor and the script adapter with a fake agent layer.
 * @author Caglar Ulkuderner
 */
const { it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-flows-runner-"));
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.DASHBOARD_CODEX_HOME = path.join(root, "codex");
process.env.DASHBOARD_DATA_DIR = path.join(root, "data");
process.env.DASHBOARD_DB_PATH = path.join(root, "test.db");
const { db } = require("../db");
const store = require("../lib/flows/store");
const { createRunner } = require("../lib/flows/runner");
const realAgents = require("../lib/flows/agents");
after(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let cwd;
let n = 0;
beforeEach(() => {
  cwd = path.join(root, `repo${++n}`);
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".ai-cockpit", "run"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "roller"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "roller", "r.md"), "ROL");
});

const agentStep = (id, extra = {}) => ({
  id,
  tur: "agent",
  rol: "roller/r.md",
  ajan: "claude",
  girdi: [],
  en_cok_tur: 2,
  zaman_asimi_dk: 1,
  ...extra,
});
const mkRun = (adimlar, extra = {}) =>
  store.createRun(db, {
    repo: cwd,
    cwd,
    task: "t",
    flow: { ad: "f", aciklama: "", adimlar, ...extra },
  });
const runDir = (f) => path.join(cwd, ".ai-cockpit", "run", f);

// script: array of per-call behaviours or a function(call) -> {exitCode, files, cost}
function fakeAgents(script = () => ({})) {
  const calls = [];
  const agents = {
    calls,
    cost: 0,
    runAgent(opts) {
      const call = { ...opts, n: calls.length };
      calls.push(call);
      const r = typeof script === "function" ? script(call) : script[call.n] || {};
      if (r.hang) return { promise: new Promise(() => {}), kill() {} };
      for (const [f, text] of Object.entries(r.files || {})) fs.writeFileSync(runDir(f), text);
      return {
        promise: Promise.resolve({ exitCode: r.exitCode ?? 0, sessionId: "sess" }),
        kill() {},
      };
    },
    runScript(opts) {
      const call = { ...opts, script: true, n: calls.length };
      calls.push(call);
      return { promise: Promise.resolve({ exitCode: 0 }), kill() {} };
    },
    sessionCostUsd: () => agents.cost,
  };
  return agents;
}
const stepsOf = (id) => store.getRun(db, id).steps.map((s) => `${s.step}#${s.round}:${s.status}`);

it("runs agent steps in order and finishes", async () => {
  const run = mkRun([agentStep("a", { cikti: "a.md" }), agentStep("b")]);
  const ag = fakeAgents([{ files: { "a.md": "x" } }, {}]);
  await createRunner({ db, agents: ag }).start(run.id);
  const got = store.getRun(db, run.id);
  assert.equal(got.status, "done");
  assert.ok(got.ended_at);
  assert.deepEqual(stepsOf(run.id), ["a#1:done", "b#1:done"]);
  assert.equal(ag.calls.length, 2);
});

it("missing output fails step", async () => {
  const run = mkRun([agentStep("a", { cikti: "a.md" })]);
  await createRunner({ db, agents: fakeAgents() }).start(run.id);
  assert.deepEqual(stepsOf(run.id), ["a#1:failed"]);
  assert.equal(store.getRun(db, run.id).status, "failed");
});

it("nonzero exit fails step", async () => {
  const run = mkRun([agentStep("a")]);
  await createRunner({ db, agents: fakeAgents([{ exitCode: 2 }]) }).start(run.id);
  assert.deepEqual(stepsOf(run.id), ["a#1:failed"]);
  assert.equal(store.getRun(db, run.id).status, "failed");
});

const REVIEW = { cikti: "inceleme.md", basarisizsa: "uygula" };
const fix = { files: { "inceleme.md": "SONUÇ: DÜZELT\nnot" } };
const ok = { files: { "inceleme.md": "SONUÇ: TAMAM\n" } };

it("DÜZELT goes back to basarisizsa then forward again", async () => {
  const run = mkRun([agentStep("uygula"), agentStep("incele", REVIEW)]);
  await createRunner({ db, agents: fakeAgents([{}, fix, {}, ok]) }).start(run.id);
  assert.deepEqual(stepsOf(run.id), [
    "uygula#1:done",
    "incele#1:done",
    "uygula#2:done",
    "incele#2:done",
  ]);
  assert.equal(store.getRun(db, run.id).status, "done");
  assert.equal(fs.readFileSync(runDir("inceleme.tur1.md"), "utf8"), fix.files["inceleme.md"]);
});

it("round limit stops at gate", async () => {
  const run = mkRun([agentStep("uygula"), agentStep("incele", { ...REVIEW, en_cok_tur: 2 })]);
  await createRunner({ db, agents: fakeAgents([{}, fix, {}, fix]) }).start(run.id);
  const got = store.getRun(db, run.id);
  assert.equal(got.status, "gate");
  assert.equal(got.current_step, "incele");
  const last = got.steps.at(-1);
  assert.equal(last.status, "gate");
  assert.equal(last.note, "Tur sınırı aşıldı");
});

it("cost cap stops at gate", async () => {
  const run = mkRun([agentStep("a"), agentStep("b")], { maliyet_tavani: 1 });
  const ag = fakeAgents();
  ag.cost = 2;
  await createRunner({ db, agents: ag }).start(run.id);
  const got = store.getRun(db, run.id);
  assert.equal(got.status, "gate");
  assert.equal(got.current_step, "b");
  assert.equal(ag.calls.length, 1);
  assert.equal(got.steps.at(-1).note, "Maliyet tavanı aşıldı");
  assert.equal(got.cost_usd, 2);
});

it("script needs approval first time", async () => {
  const flow = [{ id: "s", tur: "script", komut: "npm test", zaman_asimi_dk: 1 }];
  const ag = fakeAgents();
  const runner = createRunner({ db, agents: ag });
  const run = mkRun(flow);
  await runner.start(run.id);
  let got = store.getRun(db, run.id);
  assert.equal(got.status, "gate");
  assert.equal(got.steps[0].note, "Script onayı: npm test");
  assert.equal(ag.calls.length, 0);
  store.approveScript(db, cwd, "npm test");
  await runner.onGateAnswered(run.id);
  got = store.getRun(db, run.id);
  assert.equal(got.status, "done");
  assert.equal(ag.calls.length, 1);
  const second = mkRun(flow);
  await runner.start(second.id);
  assert.equal(store.getRun(db, second.id).status, "done");
});

it("gate step ends the loop and onGateAnswered continues", async () => {
  const run = mkRun([
    { id: "g", tur: "gate", gosterilen: [], geri_gonderilebilir: [], mesaj: "bak" },
    agentStep("b"),
  ]);
  const ag = fakeAgents();
  const runner = createRunner({ db, agents: ag });
  await runner.start(run.id);
  assert.equal(store.getRun(db, run.id).status, "gate");
  store.setRun(db, run.id, { current_step: "b" });
  await runner.onGateAnswered(run.id);
  assert.equal(store.getRun(db, run.id).status, "done");
  assert.equal(ag.calls.length, 1);
});

it("prompt contains role, brief, inputs, gate note and output line", async () => {
  fs.writeFileSync(path.join(cwd, ".ai-cockpit", "brief.md"), "BRIEF");
  fs.writeFileSync(runDir("girdi.md"), "GIRDI");
  const run = mkRun([
    agentStep("a", { girdi: ["girdi.md"], cikti: "a.md", basarisizsa: undefined }),
  ]);
  store.setRun(db, run.id, { gate_note: "NOT" });
  const ag = fakeAgents([{ files: { "a.md": "x" } }]);
  await createRunner({ db, agents: ag }).start(run.id);
  const p = ag.calls[0].prompt;
  assert.ok(p.startsWith("ROL"));
  for (const s of [
    "## Görev\nBRIEF",
    "## Girdi: girdi.md\nGIRDI",
    "## Kapı notu\nNOT",
    "Çıktını .ai-cockpit/run/a.md dosyasına yaz.",
  ])
    assert.ok(p.includes(s), s);
  assert.ok(!p.includes("SONUÇ:"));
  assert.equal(store.getRun(db, run.id).gate_note, null);
  assert.ok(ag.calls[0].logPath.endsWith(path.join("log", "a-1.log")));
});

it("review step prompt asks for the SONUÇ line", async () => {
  const run = mkRun([agentStep("uygula"), agentStep("incele", REVIEW)]);
  const ag = fakeAgents([{}, ok]);
  await createRunner({ db, agents: ag }).start(run.id);
  assert.ok(ag.calls[1].prompt.includes('İlk satır "SONUÇ: TAMAM" ya da "SONUÇ: DÜZELT" olsun.'));
});

it("resume after restart", async () => {
  const run = mkRun([agentStep("a")]);
  const first = createRunner({ db, agents: fakeAgents([{ hang: true }]) });
  first.start(run.id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(stepsOf(run.id), ["a#1:running"]);
  const ag = fakeAgents();
  await createRunner({ db, agents: ag }).resumeAll();
  assert.deepEqual(stepsOf(run.id), ["a#1:interrupted", "a#2:done"]);
  assert.equal(store.getRun(db, run.id).status, "done");
  assert.equal(ag.calls.length, 1);
});

it("second start while active is a no-op, stop kills and marks stopped", async () => {
  const run = mkRun([agentStep("a")]);
  const ag = fakeAgents([{ hang: true }]);
  let killed = 0;
  const orig = ag.runAgent;
  ag.runAgent = (o) => ({ ...orig(o), kill: () => killed++ });
  const runner = createRunner({ db, agents: ag });
  runner.start(run.id);
  await runner.start(run.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(ag.calls.length, 1);
  runner.stop(run.id);
  assert.equal(killed, 1);
  assert.equal(store.getRun(db, run.id).status, "stopped");
  assert.deepEqual(stepsOf(run.id), ["a#1:stopped"]);
});

it("runScript runs a real command into the log file", async () => {
  const logPath = path.join(root, "log", "s.log");
  const res = await realAgents.runScript({ komut: "echo hi", cwd: root, logPath, timeoutMs: 5000 })
    .promise;
  assert.equal(res.exitCode, 0);
  assert.match(fs.readFileSync(logPath, "utf8"), /hi/);
});

it("cost cap gate row does not count toward en_cok_tur", async () => {
  const run = mkRun(
    [
      agentStep("uygula"),
      agentStep("incele", { cikti: "inceleme.md", basarisizsa: "uygula", en_cok_tur: 2 }),
    ],
    { maliyet_tavani: 1 }
  );
  store.setRun(db, run.id, { cost_cap_usd: 1 });
  const agents = fakeAgents((c) =>
    c.n === 1 ? { files: { "inceleme.md": "SONUÇ: DÜZELT\n" } } : {}
  );
  agents.cost = 2;
  const runner = createRunner({ db, agents });
  await runner.start(run.id);
  assert.equal(store.getRun(db, run.id).status, "gate");
  // the cap gate held incele before it ran: one row, zero executed rounds
  assert.equal(store.roundsOf(db, run.id, "incele"), 1);
  assert.equal(store.executedRounds(db, run.id, "incele"), 0);
});

it("an unexpected error marks the run failed instead of rejecting", async () => {
  const run = mkRun([agentStep("a", { cikti: "a.md" })]);
  fs.mkdirSync(runDir("a.md")); // a directory where the output file should be
  store.startStep(db, run.id, "a", "done");
  store.finishStep(db, store.lastStep(db, run.id, "a").id, { log_path: "x" });
  const agents = fakeAgents();
  agents.runAgent = () => {
    throw new Error("boom");
  };
  await createRunner({ db, agents }).start(run.id);
  assert.equal(store.getRun(db, run.id).status, "failed");
});
