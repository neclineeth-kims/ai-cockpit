/**
 * @file Tests for the /api/flows routes and gate answers, using a fake agent layer.
 * @author Caglar Ulkuderner
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-flows-route-"));
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.DASHBOARD_CODEX_HOME = path.join(root, "codex");
process.env.DASHBOARD_DATA_DIR = path.join(root, "data");
process.env.DASHBOARD_DB_PATH = path.join(root, "test.db");
process.env.DASHBOARD_REMOTE_SYNC_MS = "0";
const { createApp, startServer } = require("../index");
const { db } = require("../db");
const { createRunner } = require("../lib/flows/runner");
const router = require("../routes/flows");

const FLOW = `
ad: demo
adimlar:
  - id: uygula
    tur: agent
    rol: roller/r.md
    ajan: claude
    cikti: u.md
  - id: kabul
    tur: gate
    mesaj: Onaylar misin
    gosterilen: [u.md]
    geri_gonderilebilir: [uygula]
`;

let server,
  base,
  n = 0;
before(async () => {
  server = await startServer(createApp(), 0);
  base = `http://127.0.0.1:${server.address().port}/api/flows`;
});
after(async () => {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeAgents(script = () => ({})) {
  const calls = [];
  const killed = [];
  return {
    calls,
    killed,
    runAgent(opts) {
      const call = { ...opts, n: calls.length };
      calls.push(call);
      const r = script(call);
      if (r.hang) return { promise: new Promise(() => {}), kill: () => killed.push(call.n) };
      for (const [f, text] of Object.entries(r.files || {}))
        fs.writeFileSync(path.join(call.cwd, ".ai-cockpit", "run", f), text);
      return { promise: Promise.resolve({ exitCode: 0 }), kill() {} };
    },
    runScript: () => ({ promise: Promise.resolve({ exitCode: 0 }), kill() {} }),
    sessionCostUsd: () => 0,
  };
}
const writeU = (call) => ({ files: { "u.md": `cikti ${call.n}` } });

function mkRepo(flow = FLOW) {
  const cwd = path.join(root, `repo${++n}`);
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".ai-cockpit", "run"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".ai-cockpit", "akislar"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "roller"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "roller", "r.md"), "ROL");
  fs.writeFileSync(path.join(cwd, ".ai-cockpit", "akislar", "demo.yaml"), flow);
  return cwd;
}
const call = (p, method = "GET", body) =>
  fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
const getRun = async (id) => (await (await call(`/${id}`)).json()).run;
async function settle(id) {
  for (const t0 = Date.now(); Date.now() - t0 < 2000; ) {
    const run = await getRun(id);
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("akış 2 sn içinde durmadı");
}
async function begin(script = writeU, flow) {
  const ag = fakeAgents(script);
  router.__setRunner(createRunner({ db, agents: ag }));
  const cwd = mkRepo(flow);
  const r = await call("", "POST", { cwd, flow: "demo", task: "t" });
  assert.equal(r.status, 201);
  const { run } = await r.json();
  return { ag, cwd, id: run.id, run: await settle(run.id) };
}
const gate = (id, body) => call(`/${id}/gate`, "POST", body);

test("second start is 409", async () => {
  const { cwd } = await begin();
  const r = await call("", "POST", { cwd, flow: "demo" });
  assert.equal(r.status, 409);
});

test("bad flow name and non-git cwd are 400", async () => {
  const cwd = mkRepo();
  assert.equal((await call("", "POST", { cwd, flow: "../x" })).status, 400);
  assert.equal((await call("", "POST", { cwd: root, flow: "demo" })).status, 400);
});

test("gate appears in decisions pending", async () => {
  const { cwd, run } = await begin();
  assert.equal(run.status, "gate");
  const d = `http://127.0.0.1:${server.address().port}/api/decisions`;
  const b = await (await fetch(`${d}?project=${encodeURIComponent(cwd)}&status=pending`)).json();
  assert.equal(b.pending, 1);
  const g = b.decisions[0];
  assert.equal(g.metadata.kind, "gate");
  assert.equal(g.message, "Onaylar misin");
  assert.deepEqual(g.metadata.shown, ["u.md"]);
  assert.deepEqual(g.metadata.sendBack, ["uygula"]);
});

test("approve finishes run and decision resolves with original message", async () => {
  const { cwd, id } = await begin();
  const r = await gate(id, { action: "approve" });
  assert.equal(r.status, 200);
  assert.equal((await settle(id)).status, "done");
  const d = `http://127.0.0.1:${server.address().port}/api/decisions`;
  const b = await (await fetch(`${d}?project=${encodeURIComponent(cwd)}`)).json();
  assert.equal(b.pending, 0);
  assert.equal(b.decisions[0].status, "resolved");
  assert.equal(b.decisions[0].message, "Onaylar misin");
  assert.equal(b.decisions[0].payload.answer, "approve");
  assert.equal((await gate(id, { action: "approve" })).status, 409);
});

test("send back keeps previous output", async () => {
  const { ag, cwd, id } = await begin();
  const r = await gate(id, { action: "send_back", step: "uygula", note: "daha kısa yaz" });
  assert.equal(r.status, 200);
  const run = await settle(id);
  assert.equal(run.status, "gate");
  const rows = run.steps.map((s) => `${s.step}#${s.round}:${s.status}`);
  assert.deepEqual(rows, ["uygula#1:done", "kabul#1:done", "uygula#2:done", "kabul#2:gate"]);
  const kept = path.join(cwd, ".ai-cockpit", "run", "u.tur1.md");
  assert.equal(fs.readFileSync(kept, "utf8"), "cikti 0");
  assert.match(ag.calls[1].prompt, /daha kısa yaz/);
});

test("send back to non-allowed step is 400", async () => {
  const { id } = await begin();
  assert.equal((await gate(id, { action: "send_back", step: "kabul" })).status, 400);
  assert.equal((await gate(id, { action: "send_back", step: "yok" })).status, 400);
  assert.equal((await gate(id, { action: "wat" })).status, 400);
  assert.equal((await getRun(id)).status, "gate");
});

test("cost cap gate: approve raises cap and reruns step, send_back is 400", async () => {
  const flow = FLOW.replace("adimlar:", "maliyet_tavani: 1\nadimlar:");
  const { ag, id } = await begin(writeU, flow);
  db.prepare("UPDATE flow_runs SET cost_usd = 1.5 WHERE id = ?").run(id);
  // force the cost gate on the agent step
  db.prepare("UPDATE flow_runs SET status='gate', current_step='uygula' WHERE id = ?").run(id);
  db.prepare("UPDATE flow_steps SET status='done' WHERE run_id = ? AND status='gate'").run(id);
  db.prepare(
    "INSERT INTO flow_steps (run_id, step, round, status, note) VALUES (?, 'uygula', 9, 'gate', 'Maliyet tavanı aşıldı')"
  ).run(id);
  assert.equal((await gate(id, { action: "send_back", step: "uygula" })).status, 400);
  assert.equal((await gate(id, { action: "approve" })).status, 200);
  const run = await settle(id);
  assert.equal(run.cost_cap_usd, 2);
  assert.equal(ag.calls.length, 2);
});

test("stop marks stopped", async () => {
  const { id } = await (async () => {
    router.__setRunner(createRunner({ db, agents: fakeAgents(() => ({ hang: true })) }));
    const cwd = mkRepo();
    return (await (await call("", "POST", { cwd, flow: "demo" })).json()).run;
  })();
  const r = await call(`/${id}/stop`, "POST");
  assert.equal(r.status, 200);
  const run = await getRun(id);
  assert.equal(run.status, "stopped");
  assert.equal(run.steps[0].status, "stopped");
});

test("retry restarts from the failed step", async () => {
  let fail = true;
  const { ag, id, run } = await begin((c) => (fail ? { files: {} } : writeU(c)));
  assert.equal(run.status, "failed");
  fail = false;
  const r = await call(`/${id}/retry`, "POST");
  assert.equal(r.status, 202);
  assert.equal((await settle(id)).status, "gate");
  assert.equal(ag.calls.length, 2);
});

test("restart from a step reruns later steps", async () => {
  const { ag, id } = await begin();
  await gate(id, { action: "approve" });
  await settle(id);
  const r = await call(`/${id}/restart`, "POST", { step: "uygula" });
  assert.equal(r.status, 202);
  assert.equal((await settle(id)).status, "gate");
  assert.equal(ag.calls.length, 2);
  assert.equal((await call(`/${id}/restart`, "POST", { step: "yok" })).status, 400);
});

test("file endpoint serves run files and rejects outside paths", async () => {
  const { cwd, id } = await begin();
  const f = (p) => call(`/${id}/file?path=${encodeURIComponent(p)}`);
  const ok = await f("u.md");
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "cikti 0");
  fs.writeFileSync(path.join(cwd, "secret.txt"), "SECRET");
  assert.equal((await f("../../secret.txt")).status, 400);
  assert.equal((await f(path.join(cwd, "secret.txt"))).status, 400);
  fs.symlinkSync(path.join(cwd, "secret.txt"), path.join(cwd, ".ai-cockpit", "run", "l.md"));
  assert.equal((await f("l.md")).status, 400);
  assert.equal((await f("yok.md")).status, 404);
});
