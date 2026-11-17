/**
 * @file Tests for the decision extractor: questions, answers and plan approvals read from Claude Code transcripts.
 * @author Caglar Ulkuderner
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-decisions-"));
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.DASHBOARD_CODEX_HOME = path.join(root, "codex");
process.env.DASHBOARD_DATA_DIR = path.join(root, "data");
process.env.DASHBOARD_DB_PATH = path.join(root, "test.db");
const { db } = require("../db");
const {
  scanTranscript,
  decisionsFromScan,
  listDecisions,
  toAgUi,
  isDesignPath,
  repoRelative,
  listDesigns,
  decisionsForBrief,
} = require("../lib/decisions");
after(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const use = (id, name, input, ts) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id, toolUseResult, ts, isError = false, content = "") =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    toolUseResult,
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });
const chat = (ts) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "text", text: "hi" }] },
  });
let n = 0;
const writeJsonl = (lines) => {
  const p = path.join(root, `t${n++}.jsonl`);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
};
const q = (question, labels, multiSelect = false) => ({
  question,
  header: "H",
  multiSelect,
  options: labels.map((label) => ({ label, description: `d-${label}` })),
});
const ctx = { sessionId: "S", project: "/p", live: false };
const decide = async (lines, c = ctx) =>
  decisionsFromScan(await scanTranscript(writeJsonl(lines)), c);

test("single answer", async () => {
  const Q = q("Which?", ["one", "two"]);
  const [d] = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result("t1", { questions: [Q], answers: { "Which?": "two" } }, "2026-01-01T00:00:05Z"),
  ]);
  assert.equal(d.id, "S:t1:0");
  assert.equal(d.status, "resolved");
  assert.equal(d.reason, "input_required");
  assert.equal(d.agent, "claude");
  assert.equal(d.message, "Which?");
  assert.equal(d.header, "H");
  assert.deepEqual(d.selected, ["two"]);
  assert.equal(d.other, false);
  assert.equal(d.askedAt, "2026-01-01T00:00:01Z");
  assert.equal(d.resolvedAt, "2026-01-01T00:00:05Z");
});

test("multiSelect answer with comma in label", async () => {
  const Q = q("Pick", ["A, B", "C", "D"], true);
  const [d] = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result("t1", { answers: { Pick: "A, B, D" } }, "2026-01-01T00:00:02Z"),
  ]);
  assert.deepEqual(d.selected, ["A, B", "D"]);
  assert.equal(d.other, false);
});

test("free text answer", async () => {
  const Q = q("Which?", ["one", "two"]);
  const [d] = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result("t1", { answers: { "Which?": "something else" } }, "2026-01-01T00:00:02Z"),
  ]);
  assert.equal(d.payload.answer, "something else");
  assert.deepEqual(d.selected, []);
  assert.equal(d.other, true);
});

test("note from annotations", async () => {
  const Q = q("Which?", ["one", "two"]);
  const [d] = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result(
      "t1",
      { answers: { "Which?": "one" }, annotations: { "Which?": { notes: "kısa not" } } },
      "2026-01-01T00:00:02Z"
    ),
  ]);
  assert.equal(d.payload.note, "kısa not");
});

test("two questions in one call", async () => {
  const Q1 = q("First?", ["a", "b"]);
  const Q2 = q("Second?", ["x", "y"]);
  const ds = await decide([
    use("t1", "AskUserQuestion", { questions: [Q1, Q2] }, "2026-01-01T00:00:01Z"),
    result("t1", { answers: { "First?": "b", "Second?": "x" } }, "2026-01-01T00:00:02Z"),
  ]);
  assert.equal(ds.length, 2);
  assert.ok(ds[0].id.endsWith(":0") && ds[1].id.endsWith(":1"));
  assert.deepEqual(ds[0].selected, ["b"]);
  assert.deepEqual(ds[1].selected, ["x"]);
});

test("same text asked twice", async () => {
  const Q = q("Same?", ["a", "b"]);
  const ds = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result("t1", { answers: { "Same?": "a" } }, "2026-01-01T00:00:02Z"),
    use("t2", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:03Z"),
    result("t2", { answers: { "Same?": "b" } }, "2026-01-01T00:00:04Z"),
  ]);
  const by = Object.fromEntries(ds.map((d) => [d.id, d.selected[0]]));
  assert.equal(by["S:t1:0"], "a");
  assert.equal(by["S:t2:0"], "b");
});

test("unanswered question", async () => {
  const Q = q("Which?", ["a"]);
  const ask = use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z");
  const [a] = await decide([ask], { ...ctx, live: true });
  assert.equal(a.status, "pending");
  const [b] = await decide([ask, chat("2026-01-01T00:00:09Z")], { ...ctx, live: true });
  assert.equal(b.status, "cancelled");
  const [c] = await decide([ask], { ...ctx, live: false });
  assert.equal(c.status, "cancelled");
});

test("rejected question", async () => {
  const Q = q("Which?", ["a"]);
  const [d] = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result("t1", "rejected", "2026-01-01T00:00:02Z", true, "nope"),
  ]);
  assert.equal(d.status, "cancelled");
});

test("plan approved", async () => {
  const plan = "intro\n# Big Plan\nbody " + "x".repeat(400);
  const [d] = await decide([
    use("p1", "ExitPlanMode", { plan }, "2026-01-01T00:00:01Z"),
    result("p1", { plan, filePath: "/x", isAgent: false }, "2026-01-01T00:00:02Z"),
  ]);
  assert.equal(d.reason, "plan_approval");
  assert.equal(d.status, "resolved");
  assert.equal(d.payload.plan, plan);
  assert.equal(d.header, "Big Plan");
  assert.equal(d.message, plan.slice(0, 300));
});

test("plan rejected", async () => {
  const [d] = await decide([
    use("p1", "ExitPlanMode", { plan: "# P" }, "2026-01-01T00:00:01Z"),
    result(
      "p1",
      "x",
      "2026-01-01T00:00:02Z",
      true,
      "The user doesn't want to proceed with this tool use. STOP. the user said:\nuse sqlite instead"
    ),
  ]);
  assert.equal(d.status, "cancelled");
  assert.equal(d.payload.note, "use sqlite instead");
});

test("writes collected", async () => {
  const s = await scanTranscript(
    writeJsonl([
      use("w1", "Write", { file_path: "/a.js" }, "2026-01-01T00:00:01Z"),
      use("w2", "Edit", { file_path: "/b.js" }, "2026-01-01T00:00:02Z"),
      use("w3", "MultiEdit", { file_path: "/c.js" }, "2026-01-01T00:00:03Z"),
      use("r1", "Read", { file_path: "/d.js" }, "2026-01-01T00:00:04Z"),
    ])
  );
  assert.deepEqual(s.writes, [
    { file: "/a.js", at: "2026-01-01T00:00:01Z" },
    { file: "/b.js", at: "2026-01-01T00:00:02Z" },
    { file: "/c.js", at: "2026-01-01T00:00:03Z" },
  ]);
  assert.equal(s.lastAt, "2026-01-01T00:00:04Z");
});

test("broken line skipped", async () => {
  const Q = q("Which?", ["a"]);
  const ds = await decide([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    '{"AskUserQuestion": broken',
    result("t1", { answers: { "Which?": "a" } }, "2026-01-01T00:00:02Z"),
  ]);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, "resolved");
});

test("scan is cached by size and mtime", async () => {
  const p = writeJsonl([chat("2026-01-01T00:00:01Z")]);
  const a = await scanTranscript(p);
  assert.equal(await scanTranscript(p), a);
  fs.appendFileSync(p, chat("2026-01-01T00:00:09Z") + "\n");
  const b = await scanTranscript(p);
  assert.notEqual(b, a);
  assert.equal(b.lastAt, "2026-01-01T00:00:09Z");
});

test("toAgUi", async () => {
  const Q = q("Which?", ["a", "b"]);
  const Qm = q("Many?", ["a", "b"], true);
  const plan = "# P";
  const ds = await decide(
    [
      use("t1", "AskUserQuestion", { questions: [Q, Qm] }, "2026-01-01T00:00:01Z"),
      result("t1", { answers: { "Which?": "b", "Many?": "a, b" } }, "2026-01-01T00:00:02Z"),
      use("p1", "ExitPlanMode", { plan }, "2026-01-01T00:00:03Z"),
    ],
    { ...ctx, live: true }
  );
  const one = toAgUi(ds.find((d) => d.id === "S:t1:0"));
  assert.equal(one.interrupt.reason, "input_required");
  assert.equal(one.interrupt.toolCallId, "t1");
  assert.deepEqual(one.interrupt.responseSchema, { type: "string", enum: ["a", "b"] });
  assert.equal(one.resume.status, "resolved");
  assert.equal(one.resume.payload.answer, "b");
  const many = toAgUi(ds.find((d) => d.id === "S:t1:1"));
  assert.deepEqual(many.interrupt.responseSchema, {
    type: "array",
    items: { type: "string", enum: ["a", "b"] },
  });
  const p = toAgUi(ds.find((d) => d.reason === "plan_approval"));
  assert.equal(p.interrupt.reason, "confirmation");
  assert.equal(p.interrupt.metadata.kind, "plan");
  assert.equal(p.resume, undefined);
});

test("listDecisions filters, orders and skips missing files", async () => {
  const Q = q("Pick a colour?", ["red", "blue"]);
  const f1 = writeJsonl([
    use("t1", "AskUserQuestion", { questions: [Q] }, "2026-01-01T00:00:01Z"),
    result("t1", { answers: { "Pick a colour?": "red" } }, "2026-01-01T00:00:02Z"),
  ]);
  const f2 = writeJsonl([
    use("t2", "AskUserQuestion", { questions: [q("Other?", ["x"])] }, "2026-01-02T00:00:01Z"),
    result("t2", { answers: { "Other?": "x" } }, "2026-01-02T00:00:02Z"),
  ]);
  const proj = path.join(root, "proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const ins = db.prepare(
    "INSERT INTO sessions (id, cwd, transcript_path, status) VALUES (?, ?, ?, ?)"
  );
  ins.run("s1", proj, f1, "completed");
  ins.run("s2", root, f2, "completed");
  ins.run("s3", root, path.join(root, "missing.jsonl"), "completed");
  const ev = db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES (?, 'PostToolUse', 'AskUserQuestion')"
  );
  for (const s of ["s1", "s2", "s3"]) ev.run(s);
  const all = await listDecisions(db, {});
  assert.deepEqual(
    all.map((d) => d.sessionId),
    ["s2", "s1"]
  );
  const only = await listDecisions(db, { project: proj });
  assert.deepEqual(
    only.map((d) => d.sessionId),
    ["s1"]
  );
  assert.deepEqual(
    (await listDecisions(db, { q: "COLOUR" })).map((d) => d.sessionId),
    ["s1"]
  );
  assert.equal((await listDecisions(db, { status: "pending" })).length, 0);
  assert.equal((await listDecisions(db, { limit: 1 })).length, 1);
});

test("isDesignPath classifies repo-relative paths", () => {
  const k = isDesignPath;
  assert.equal(k("docs/superpowers/specs/x.md"), "spec");
  assert.equal(k("docs/superpowers/specs/x.html"), "taslak");
  assert.equal(k("design/canvas/a.dc.html"), "kanvas");
  assert.equal(k("docs/superpowers/specs/a.dc.html"), "kanvas");
  assert.equal(k("design/n.md"), "spec");
  assert.equal(k("design/n.html"), "taslak");
  assert.equal(k("docs/x.dc.html"), null);
  assert.equal(k("client/logo.svg"), "gorsel");
  assert.equal(k("a/B.PNG"), "gorsel");
  assert.equal(k("server/a.js"), null);
  assert.equal(k("node_modules/p/logo.svg"), null);
  assert.equal(k("design/.cache/a.md"), null);
});

test("repoRelative maps project and worktree paths to one relative path", () => {
  const roots = ["/r/main", "/r/wt"];
  assert.equal(repoRelative("/r/main/design/a.md", roots), "design/a.md");
  assert.equal(repoRelative("/r/wt/design/a.md", roots), "design/a.md");
  assert.equal(repoRelative("/r/other/design/a.md", roots), null);
  assert.equal(repoRelative("/r/mainx/design/a.md", roots), null);
});

test("listDesigns keeps the latest write, flags missing files, skips other projects", async () => {
  const proj = path.join(root, "dproj");
  const wt = path.join(root, "dwt");
  fs.mkdirSync(path.join(proj, ".git", "worktrees", "x"), { recursive: true });
  fs.mkdirSync(path.join(proj, "design"), { recursive: true });
  fs.writeFileSync(path.join(proj, "design", "here.md"), "x");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(proj, ".git", "worktrees", "x")}\n`);
  const w = (file, ts) => use("w" + n++, "Write", { file_path: file }, ts);
  const f1 = writeJsonl([
    w(path.join(proj, "design", "here.md"), "2026-02-01T00:00:01Z"),
    w(path.join(proj, "design", "gone.md"), "2026-02-01T00:00:02Z"),
    w(path.join(proj, "server", "a.js"), "2026-02-01T00:00:03Z"),
  ]);
  const f2 = writeJsonl([w(path.join(wt, "design", "here.md"), "2026-02-02T00:00:01Z")]);
  const f3 = writeJsonl([
    w(path.join(root, "elsewhere", "design", "o.md"), "2026-02-03T00:00:01Z"),
  ]);
  const ins = db.prepare(
    "INSERT INTO sessions (id, cwd, transcript_path, status) VALUES (?, ?, ?, 'completed')"
  );
  ins.run("d1", proj, f1);
  ins.run("d2", wt, f2);
  ins.run("d3", path.join(root, "elsewhere"), f3);
  const ev = db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES (?, 'PostToolUse', 'Write')"
  );
  for (const s of ["d1", "d2", "d3"]) ev.run(s);
  const out = await listDesigns(db, { project: proj });
  assert.deepEqual(out, [
    {
      path: "design/here.md",
      kind: "spec",
      sessionId: "d2",
      writtenAt: "2026-02-02T00:00:01Z",
      missing: false,
    },
    {
      path: "design/gone.md",
      kind: "spec",
      sessionId: "d1",
      writtenAt: "2026-02-01T00:00:02Z",
      missing: true,
    },
  ]);
});

test("listDesigns takes the project from the written file, not the session cwd", async () => {
  const proj = path.join(root, "xproj");
  const other = path.join(root, "xother");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "worktrees", "w"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".claude", "worktrees", "w", ".git"),
    `gitdir: ${path.join(proj, ".git", "worktrees", "w")}\n`
  );
  fs.mkdirSync(path.join(other, ".git"), { recursive: true });
  const f = writeJsonl([
    use(
      "x1",
      "Write",
      { file_path: path.join(proj, "design", "cross.md") },
      "2026-03-01T00:00:01Z"
    ),
    use(
      "x2",
      "Write",
      { file_path: path.join(proj, ".claude", "worktrees", "w", "design", "inner.html") },
      "2026-03-01T00:00:02Z"
    ),
  ]);
  db.prepare(
    "INSERT INTO sessions (id, cwd, transcript_path, status) VALUES ('x', ?, ?, 'completed')"
  ).run(other, f);
  db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES ('x', 'PostToolUse', 'Write')"
  ).run();
  const out = await listDesigns(db, { project: proj });
  assert.deepEqual(
    out.map((d) => [d.path, d.kind, d.sessionId]),
    [
      ["design/inner.html", "taslak", "x"],
      ["design/cross.md", "spec", "x"],
    ]
  );
  assert.deepEqual(await listDesigns(db, { project: other }), []);
});

// decisionsForBrief: sessions are found by what they wrote; each carries its answered questions.
let bn = 0;
function briefSession(proj, written, qs, cwd = proj) {
  const id = "bs" + bn++;
  const lines = [];
  for (const f of written)
    lines.push(use("w" + n++, "Write", { file_path: path.join(proj, f) }, "2026-03-01T00:00:00Z"));
  qs.forEach(({ ts, header = "H", question, answer, note }, i) => {
    const Q = { question, header, multiSelect: false, options: [{ label: "x", description: "d" }] };
    const tid = `q${bn}_${i}`;
    lines.push(use(tid, "AskUserQuestion", { questions: [Q] }, ts));
    const res = { answers: { [question]: answer } };
    if (note) res.annotations = { [question]: { notes: note } };
    lines.push(result(tid, res, ts));
  });
  db.prepare(
    "INSERT INTO sessions (id, cwd, transcript_path, status) VALUES (?, ?, ?, 'completed')"
  ).run(id, cwd, writeJsonl(lines));
  const ev = db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES (?, 'PostToolUse', ?)"
  );
  if (written.length) ev.run(id, "Write");
  if (qs.length) ev.run(id, "AskUserQuestion");
  return id;
}

test("brief decisions follow the task area", async () => {
  const proj = path.join(root, "bproj1");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  briefSession(
    proj,
    ["server/lib/a.js"],
    [{ ts: "2026-03-02T00:00:00Z", question: "Sunucu?", answer: "Evet", note: "acil" }]
  );
  briefSession(
    proj,
    ["client/x.tsx"],
    [{ ts: "2026-03-03T00:00:00Z", question: "Istemci?", answer: "Hayir" }]
  );
  const out = await decisionsForBrief(db, { project: proj, area: ["server/**"] });
  assert.deepEqual(out, ["- 2026-03-02 [H] Sunucu? -> Evet (not: acil)"]);
});

test("brief decisions without area take last 20, newest first", async () => {
  const proj = path.join(root, "bproj2");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const qs = Array.from({ length: 25 }, (_, i) => ({
    ts: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    question: `Q${i}\nsatir`,
    answer: `A${i}`,
  }));
  briefSession(proj, [], qs);
  const out = await decisionsForBrief(db, { project: proj, area: [] });
  assert.equal(out.length, 20);
  assert.equal(out[0], "- 2026-04-25 [H] Q24 satir -> A24");
  assert.equal(out[19], "- 2026-04-06 [H] Q5 satir -> A5");
});

test("brief decisions capped at 4096 bytes, oldest dropped", async () => {
  const proj = path.join(root, "bproj3");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const qs = Array.from({ length: 10 }, (_, i) => ({
    ts: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    question: `Q${i}`,
    answer: "ş".repeat(300),
  }));
  briefSession(proj, [], qs);
  const out = await decisionsForBrief(db, { project: proj, area: [] });
  assert.ok(out.length > 0 && out.length < 10);
  assert.ok(Buffer.byteLength(out.join("\n"), "utf8") <= 4096);
  assert.ok(out[0].startsWith("- 2026-05-10"));
});

test("brief decisions skip pending and cancelled, and list plan approvals", async () => {
  const proj = path.join(root, "bproj4");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const id = "bs" + bn++;
  const Q = { question: "Acik?", header: "H", multiSelect: false, options: [] };
  const lines = [
    use("c1", "AskUserQuestion", { questions: [Q] }, "2026-06-01T00:00:00Z"),
    result("c1", {}, "2026-06-01T00:00:01Z", true),
    use("p1", "ExitPlanMode", { plan: "# Buyuk plan\nx" }, "2026-06-02T00:00:00Z"),
    result("p1", { plan: "# Buyuk plan\nx" }, "2026-06-02T00:00:01Z"),
    use("o1", "AskUserQuestion", { questions: [Q] }, "2026-06-03T00:00:00Z"),
  ];
  db.prepare(
    "INSERT INTO sessions (id, cwd, transcript_path, status) VALUES (?, ?, ?, 'completed')"
  ).run(id, proj, writeJsonl(lines));
  db.prepare(
    "INSERT INTO events (session_id, event_type, tool_name) VALUES (?, 'PostToolUse', 'ExitPlanMode')"
  ).run(id);
  assert.deepEqual(await decisionsForBrief(db, { project: proj, area: [] }), [
    "- 2026-06-02 Plan onaylandı: Buyuk plan",
  ]);
});
