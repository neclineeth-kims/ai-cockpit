/**
 * @file Extracts agent questions, the user's answers and plan approvals from Claude Code transcripts as AG-UI shaped decisions.
 * @author Caglar Ulkuderner
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { workRepo, checkoutRoot } = require("./plan");
const { areasOverlap } = require("./task-fields");

// shortcut: unbounded per-process cache, add LRU if memory grows past a few hundred transcripts
const cache = new Map();

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

async function readScan(file) {
  const scan = { asks: [], plans: [], writes: [], lastAt: null };
  const open = new Map(); // tool_use_id -> Ask | PlanAsk still waiting for its result
  let lineNo = 0;
  let lastLine = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    lineNo++;
    lastLine = lineNo;
    const interesting =
      line.includes('"AskUserQuestion"') ||
      line.includes('"ExitPlanMode"') ||
      line.includes('"file_path"') ||
      (line.includes('"tool_result"') && [...open.keys()].some((id) => line.includes(id)));
    if (!interesting) {
      const i = line.indexOf('"timestamp":"');
      if (i >= 0) scan.lastAt = line.slice(i + 13, line.indexOf('"', i + 13));
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // api-request-blob lines replay earlier messages without a timestamp: only real turns count.
    if (obj.type !== "assistant" && obj.type !== "user") continue;
    const at = obj.timestamp || null;
    if (at) scan.lastAt = at;
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "tool_use") {
        const input = c.input || {};
        if (c.name === "AskUserQuestion" && Array.isArray(input.questions)) {
          const a = {
            toolUseId: c.id,
            at,
            questions: input.questions,
            result: null,
            rejected: false,
            line: lineNo,
          };
          scan.asks.push(a);
          open.set(c.id, a);
        } else if (c.name === "ExitPlanMode") {
          const p = {
            toolUseId: c.id,
            at,
            plan: String(input.plan || ""),
            result: null,
            line: lineNo,
          };
          scan.plans.push(p);
          open.set(c.id, p);
        } else if (WRITE_TOOLS.has(c.name) && input.file_path) {
          scan.writes.push({ file: input.file_path, at });
        }
      } else if (c.type === "tool_result" && open.has(c.tool_use_id)) {
        const x = open.get(c.tool_use_id);
        open.delete(c.tool_use_id);
        x.resultAt = at;
        if ("questions" in x) {
          x.rejected = !!c.is_error;
          const r = obj.toolUseResult;
          x.result =
            !c.is_error && r && typeof r === "object"
              ? { answers: r.answers || {}, annotations: r.annotations || {} }
              : null;
        } else {
          x.result = c.is_error ? "rejected" : "approved";
          if (c.is_error) {
            const text =
              typeof c.content === "string" ? c.content : JSON.stringify(c.content || "");
            const m = /the user said:\s*([\s\S]*)/i.exec(text);
            x.note = m ? m[1].trim() : "";
          }
        }
      }
    }
  }
  for (const x of open.values()) x.tail = x.line === lastLine;
  return scan;
}

async function scanTranscript(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.scan;
  const scan = await readScan(file);
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, scan });
  return scan;
}

/** Match an answer to option labels: whole answer first, else comma parts joined left to right, longest label wins. */
function matchLabels(answer, labels) {
  if (labels.includes(answer)) return { selected: [answer], other: false };
  const parts = answer.split(", ");
  const selected = [];
  let other = false;
  for (let i = 0; i < parts.length; ) {
    let j = parts.length;
    while (j > i && !labels.includes(parts.slice(i, j).join(", "))) j--;
    if (j > i) {
      selected.push(parts.slice(i, j).join(", "));
      i = j;
    } else {
      other = true;
      i++;
    }
  }
  return { selected, other: other || selected.length === 0 };
}

function decisionsFromScan(scan, { sessionId, project, live }) {
  const out = [];
  const base = { sessionId, project, agent: "claude" };
  const pendingStatus = (x) => (!x.result && x.tail && live ? "pending" : "cancelled");
  for (const a of scan.asks) {
    a.questions.forEach((qn, index) => {
      const opts = (qn.options || []).map((o) => ({ label: o.label, description: o.description }));
      const answer = a.result && a.result.answers[qn.question];
      const d = {
        ...base,
        id: `${sessionId}:${a.toolUseId}:${index}`,
        reason: "input_required",
        header: qn.header,
        message: qn.question,
        options: opts,
        multiSelect: !!qn.multiSelect,
        askedAt: a.at,
        status:
          typeof answer === "string"
            ? "resolved"
            : a.rejected || a.result
              ? "cancelled"
              : pendingStatus(a),
        selected: [],
        other: false,
      };
      if (typeof answer === "string") {
        Object.assign(
          d,
          matchLabels(
            answer,
            opts.map((o) => o.label)
          )
        );
        d.payload = { answer: d.multiSelect && !d.other ? d.selected : answer };
        const note = a.result.annotations[qn.question] && a.result.annotations[qn.question].notes;
        if (note) d.payload.note = note;
      }
      if (a.resultAt) d.resolvedAt = a.resultAt;
      out.push(d);
    });
  }
  for (const p of scan.plans) {
    const d = {
      ...base,
      id: `${sessionId}:${p.toolUseId}:0`,
      reason: "plan_approval",
      message: p.plan.slice(0, 300),
      status: p.result === "approved" ? "resolved" : p.result ? "cancelled" : pendingStatus(p),
      payload: { plan: p.plan },
      selected: [],
      other: false,
      askedAt: p.at,
    };
    const h = /^# (.+)$/m.exec(p.plan);
    if (h) d.header = h[1];
    if (p.note) d.payload.note = p.note;
    if (p.resultAt) d.resolvedAt = p.resultAt;
    out.push(d);
  }
  return out;
}

async function listDecisions(db, { project, status, q, limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT s.id, s.cwd, s.transcript_path, s.status FROM sessions s
       WHERE s.id IN (SELECT DISTINCT session_id FROM events
                      WHERE tool_name IN ('AskUserQuestion','ExitPlanMode'))
         AND s.transcript_path IS NOT NULL`
    )
    .all();
  const repoOf = new Map();
  const needle = q && q.toLowerCase();
  let all = [];
  for (const r of rows) {
    if (!repoOf.has(r.cwd)) repoOf.set(r.cwd, r.cwd ? workRepo(r.cwd) : null);
    if (project && repoOf.get(r.cwd) !== project) continue;
    let scan;
    try {
      scan = await scanTranscript(r.transcript_path);
    } catch {
      continue; // transcript missing or unreadable
    }
    all.push(
      ...decisionsFromScan(scan, {
        sessionId: r.id,
        project: repoOf.get(r.cwd) || r.cwd,
        live: r.status === "active",
      })
    );
  }
  if (status) all = all.filter((d) => d.status === status);
  if (needle) {
    all = all.filter((d) =>
      [d.header, d.message, d.payload && d.payload.answer, d.payload && d.payload.note]
        .flat()
        .some((v) => typeof v === "string" && v.toLowerCase().includes(needle))
    );
  }
  all.sort((a, b) => (a.askedAt < b.askedAt ? 1 : a.askedAt > b.askedAt ? -1 : 0));
  return all.slice(0, limit);
}

function toAgUi(d) {
  const labels = (d.options || []).map((o) => o.label);
  const interrupt = {
    id: d.id,
    reason: d.reason === "plan_approval" ? "confirmation" : d.reason,
    message: d.message,
    toolCallId: d.id.split(":")[1],
  };
  if (d.reason === "plan_approval") interrupt.metadata = { kind: "plan" };
  else
    interrupt.responseSchema = d.multiSelect
      ? { type: "array", items: { type: "string", enum: labels } }
      : { type: "string", enum: labels };
  const out = { interrupt };
  if (d.status !== "pending")
    out.resume = { interruptId: d.id, status: d.status, payload: d.payload };
  return out;
}

/** Kind of design file a repo-relative POSIX path is, or null. */
function isDesignPath(rel) {
  if (/(^|\/)(node_modules|\.[^/]+)\//.test(rel)) return null;
  const inDir = rel.startsWith("docs/superpowers/specs/") || rel.startsWith("design/");
  if (inDir && rel.endsWith(".dc.html")) return "kanvas";
  if (inDir && rel.endsWith(".md")) return "spec";
  if (inDir && rel.endsWith(".html")) return "taslak";
  return /\.(png|jpe?g|svg|webp)$/i.test(rel) ? "gorsel" : null;
}

/** Path of file relative to the first root containing it, POSIX separators; null if under none. */
function repoRelative(file, roots) {
  const root = roots.find((r) => file.startsWith(r + path.sep));
  return root ? path.relative(root, file).split(path.sep).join("/") : null;
}

/** Resolver for a written file: its repo and checkout root come from the file's own dir, not the session cwd. */
function writeResolver() {
  const where = new Map(); // dir -> { repo, root }
  return (file) => {
    const dir = path.dirname(file);
    if (!where.has(dir)) where.set(dir, { repo: workRepo(dir), root: checkoutRoot(dir) });
    return where.get(dir);
  };
}

/** Design files agents wrote in a project (its worktrees included), newest write first. */
async function listDesigns(db, { project }) {
  const rows = db
    .prepare(
      `SELECT s.id, s.cwd, s.transcript_path FROM sessions s
       WHERE s.id IN (SELECT DISTINCT session_id FROM events
                      WHERE tool_name IN ('Write','Edit','MultiEdit'))
         AND s.transcript_path IS NOT NULL`
    )
    .all();
  const latest = new Map();
  const resolve = writeResolver(); // a session may write into another repo than its cwd
  for (const r of rows) {
    let scan;
    try {
      scan = await scanTranscript(r.transcript_path);
    } catch {
      continue; // transcript missing or unreadable
    }
    for (const w of scan.writes) {
      const { repo, root } = resolve(w.file);
      if (repo !== project || !root) continue;
      const rel = repoRelative(w.file, [root]);
      const kind = rel && isDesignPath(rel);
      const cur = latest.get(rel);
      if (kind && (!cur || w.at > cur.writtenAt))
        latest.set(rel, { path: rel, kind, sessionId: r.id, writtenAt: w.at });
    }
  }
  return [...latest.values()]
    .map((d) => ({ ...d, missing: !fs.existsSync(path.join(project, d.path)) }))
    .sort((a, b) => (a.writtenAt < b.writtenAt ? 1 : a.writtenAt > b.writtenAt ? -1 : 0));
}

/** Repos with sessions that asked questions or wrote files, newest activity first. */
function listProjects(db) {
  const rows = db
    .prepare(
      `SELECT s.cwd, COALESCE(s.ended_at, s.started_at) AS at FROM sessions s
       WHERE s.cwd IS NOT NULL
         AND s.id IN (SELECT DISTINCT session_id FROM events
                      WHERE tool_name IN ('AskUserQuestion','ExitPlanMode','Write','Edit','MultiEdit'))`
    )
    .all();
  const last = new Map();
  for (const r of rows) {
    const root = workRepo(r.cwd);
    if (!root || root === os.homedir()) continue;
    if (!last.has(root) || (r.at || "") > last.get(root)) last.set(root, r.at || "");
  }
  return [...last]
    .map(([root, lastAt]) => ({ root, name: path.basename(root), lastAt: lastAt || null }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

const BRIEF_BYTES = 4096;
const NEAR_MS = 3 * 3_600_000;
const oneLine = (v) => String(v).replace(/\s*\n\s*/g, " ");

/** Answered questions and approved plans earlier sessions made in a task's area, as brief lines (newest first, <= 4 KB). */
async function decisionsForBrief(db, { project, area }) {
  let all;
  if (!area.length) all = await listDecisions(db, { project, status: "resolved", limit: 20 });
  else {
    const rows = db
      .prepare(
        `SELECT s.id, s.status, s.transcript_path FROM sessions s
         WHERE s.id IN (SELECT DISTINCT session_id FROM events
                        WHERE tool_name IN ('Write','Edit','MultiEdit'))
           AND s.transcript_path IS NOT NULL`
      )
      .all();
    const resolve = writeResolver();
    all = [];
    for (const r of rows) {
      let scan;
      try {
        scan = await scanTranscript(r.transcript_path);
      } catch {
        continue; // transcript missing or unreadable
      }
      const times = scan.writes
        .filter((w) => {
          const { repo, root } = resolve(w.file);
          const rel = repo === project && root && repoRelative(w.file, [root]);
          return rel && areasOverlap(area, [rel]);
        })
        .map((w) => Date.parse(w.at));
      if (!times.length) continue;
      // A long session may work in several repos: keep only questions asked near its writes in the area.
      const near = (d) => times.some((t) => Math.abs(t - Date.parse(d.askedAt)) <= NEAR_MS);
      all.push(
        ...decisionsFromScan(scan, {
          sessionId: r.id,
          project,
          live: r.status === "active",
        }).filter(near)
      );
    }
    all = all.filter((d) => d.status === "resolved");
    all.sort((a, b) => (a.askedAt < b.askedAt ? 1 : a.askedAt > b.askedAt ? -1 : 0));
  }
  const lines = [];
  for (const d of all) {
    const day = d.askedAt.slice(0, 10);
    let line;
    if (d.reason === "plan_approval")
      line = `- ${day} Plan onaylandı: ${oneLine(d.header || "başlıksız")}`;
    else {
      const a = d.payload.answer;
      line = `- ${day} ${d.header ? `[${oneLine(d.header)}] ` : ""}${oneLine(d.message)} -> ${oneLine(Array.isArray(a) ? a.join(", ") : a)}`;
      if (d.payload.note) line += ` (not: ${oneLine(d.payload.note)})`;
    }
    if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > BRIEF_BYTES) break;
    lines.push(line);
  }
  return lines;
}

module.exports = {
  decisionsForBrief,
  scanTranscript,
  decisionsFromScan,
  listDecisions,
  toAgUi,
  isDesignPath,
  repoRelative,
  listDesigns,
  listProjects,
};
