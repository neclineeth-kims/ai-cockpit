/**
 * @file Tests for the /api/decisions routes: listing, export and safe design file serving.
 * @author Caglar Ulkuderner
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-decisions-route-"));
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.DASHBOARD_CODEX_HOME = path.join(root, "codex");
process.env.DASHBOARD_DATA_DIR = path.join(root, "data");
process.env.DASHBOARD_DB_PATH = path.join(root, "test.db");
process.env.DASHBOARD_REMOTE_SYNC_MS = "0";
const { createApp, startServer } = require("../index");
const { db } = require("../db");

const use = (id, name, input, ts) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id, toolUseResult, ts) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    toolUseResult,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
  });
const Q = {
  question: "Which?",
  header: "H",
  multiSelect: false,
  options: [
    { label: "one", description: "d" },
    { label: "two", description: "d" },
  ],
};

const proj = path.join(root, "my proj!");
const outside = path.join(root, "outside.md");
let server, base;

before(async () => {
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  fs.mkdirSync(path.join(proj, "design"), { recursive: true });
  fs.mkdirSync(path.join(proj, "server"), { recursive: true });
  fs.writeFileSync(path.join(proj, "design", "a.md"), "DESIGN-A");
  fs.writeFileSync(path.join(proj, "server", "a.js"), "CODE-SECRET");
  fs.writeFileSync(path.join(root, "x.md"), "OUTSIDE-SECRET");
  fs.writeFileSync(outside, "LINK-SECRET");
  fs.symlinkSync(outside, path.join(proj, "design", "link.md"));
  const t = path.join(root, "t.jsonl");
  fs.writeFileSync(
    t,
    [
      use("q1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
      result("q1", { questions: [Q], answers: { "Which?": "two" } }, "2026-01-01T00:00:05Z"),
      use("w1", "Write", { file_path: path.join(proj, "design", "a.md") }, "2026-01-01T00:02:00Z"),
      use(
        "w2",
        "Write",
        { file_path: path.join(proj, "design", "link.md") },
        "2026-01-01T00:02:01Z"
      ),
      use("w3", "Write", { file_path: path.join(proj, "server", "a.js") }, "2026-01-01T00:02:02Z"),
      use(
        "q2",
        "AskUserQuestion",
        { questions: [{ ...Q, question: "Pending?" }] },
        "2026-01-01T00:01:00Z"
      ),
    ].join("\n") + "\n"
  );
  db.prepare(
    "INSERT INTO sessions (id, cwd, transcript_path, status) VALUES ('s1', ?, ?, 'active')"
  ).run(proj, t);
  const ev = db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES ('s1', 'PostToolUse', ?)"
  );
  ev.run("AskUserQuestion");
  ev.run("Write");
  server = await startServer(createApp(), 0);
  base = `http://127.0.0.1:${server.address().port}/api/decisions`;
});
after(async () => {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (p) => fetch(base + p);
const P = () => `project=${encodeURIComponent(proj)}`;

test("lists decisions for project", async () => {
  const b = await (await get(`?${P()}`)).json();
  assert.equal(b.decisions.length, 2);
  assert.equal(b.pending, 1);
});

test("status filter and pending count", async () => {
  const b = await (await get(`?${P()}&status=pending`)).json();
  assert.equal(b.decisions.length, 1);
  assert.equal(b.pending, 1);
  assert.equal((await (await get(`?${P()}&limit=1`)).json()).decisions.length, 1);
});

test("export ag-ui is an attachment", async () => {
  const r = await get(`/export?${P()}&format=ag-ui`);
  assert.equal(r.status, 200);
  assert.equal(
    r.headers.get("content-disposition"),
    'attachment; filename="kararlar-my_proj_.json"'
  );
  const b = await r.json();
  assert.equal(b.interrupts.length, 2);
  assert.equal(b.resume.length, 1);
  const j = await (await get(`/export?${P()}&format=json`)).json();
  assert.equal(j.decisions.length, 2);
});

test("bad format and missing project are 400", async () => {
  assert.equal((await get(`/export?${P()}&format=xml`)).status, 400);
  assert.equal((await get(`/export?format=json`)).status, 400);
  assert.equal((await get(`/designs`)).status, 400);
});

test("design file served", async () => {
  const d = await (await get(`/designs?${P()}`)).json();
  assert.ok(d.designs.some((x) => x.path === "design/a.md"));
  const r = await get(`/designs/file?${P()}&path=${encodeURIComponent("design/a.md")}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "DESIGN-A");
  assert.equal(r.headers.get("content-security-policy"), "sandbox allow-scripts");
});

test("design file outside project is 404", async () => {
  for (const p of ["../x.md", "design/link.md", "server/a.js"]) {
    const r = await get(`/designs/file?${P()}&path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /SECRET/);
  }
});

test("projects: grouped by repo, newest first", async () => {
  const other = path.join(root, "other-repo");
  fs.mkdirSync(path.join(other, ".git"), { recursive: true });
  const ins = db.prepare(
    "INSERT INTO sessions (id, cwd, ended_at, status) VALUES (?, ?, ?, 'completed')"
  );
  ins.run("s2", path.join(proj, "server"), "2020-01-01T00:00:00Z");
  ins.run("s3", other, "2099-01-01T00:00:00Z");
  const ev = db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES (?, 'PostToolUse', 'Write')"
  );
  ev.run("s2");
  ev.run("s3");
  const { projects } = await (await get("/projects")).json();
  assert.deepEqual(
    projects.map((p) => p.name),
    ["other-repo", "my proj!"]
  );
  assert.equal(projects[0].lastAt, "2099-01-01T00:00:00Z");
  assert.ok(projects[1].lastAt > "2020-01-01T00:00:00Z");
});

test("projects: a repo with only a flow run is listed", async () => {
  const flowOnly = path.join(root, "flow-only");
  fs.mkdirSync(path.join(flowOnly, ".git"), { recursive: true });
  db.prepare(
    `INSERT INTO flow_runs (id, repo, cwd, flow, flow_json, status, started_at)
     VALUES ('fr1', ?, ?, 'f', '{"ad":"f","adimlar":[]}', 'gate', '2098-01-01T00:00:00Z')`
  ).run(flowOnly, flowOnly);
  const { projects } = await (await get("/projects")).json();
  assert.ok(projects.some((p) => p.name === "flow-only"));
});
