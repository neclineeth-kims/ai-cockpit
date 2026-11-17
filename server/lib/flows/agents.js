/**
 * @file agents.js
 * @description Agent and script adapters for the flow (akislar) executor.
 * @author Caglar Ulkuderner
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const POLL_MS = 2000;
const TIMEOUT_EXIT = 124;

// Spawns a command, streams stdout+stderr into logPath, resolves with its exit code.
function spawnLogged(cmd, args, opts, logPath, timeoutMs) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath);
  const child = spawn(cmd, args, opts);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: TIMEOUT_EXIT });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      log.end();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end(() => resolve({ exitCode: code ?? 1 }));
    });
  });
  return { promise, kill: () => child.kill("SIGTERM") };
}

function runClaude({ prompt, cwd, model, timeoutMs }) {
  const spawner = require("../run-spawner");
  let handle;
  let timer;
  let poll;
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    try {
      handle = spawner.spawnRun({
        prompt,
        mode: "headless",
        cwd,
        model,
        permissionMode: "acceptEdits",
      });
    } catch (err) {
      return reject(err);
    }
    const finish = (exitCode) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ exitCode, sessionId: spawner.getRun(handle.id)?.sessionId ?? null });
    };
    poll = setInterval(() => {
      const h = spawner.getRun(handle.id);
      // handle is reaped 5 min after exit; a missing handle means it already ended
      if (!h) return finish(1);
      if (["completed", "error", "killed"].includes(h.status)) finish(h.exitCode ?? 1);
    }, POLL_MS);
    timer = setTimeout(() => {
      spawner.killRun(handle.id);
      finish(TIMEOUT_EXIT);
    }, timeoutMs);
  });
  const kill = () => {
    if (!handle) return;
    clearInterval(poll);
    clearTimeout(timer);
    spawner.killRun(handle.id);
    settle({ exitCode: 1, sessionId: spawner.getRun(handle.id)?.sessionId ?? null });
  };
  return { promise, kill };
}

function runAgent({ ajan, model, prompt, cwd, logPath, timeoutMs }) {
  if (ajan === "claude") return runClaude({ prompt, cwd, model, timeoutMs });
  if (ajan !== "opencode") throw new Error(`Desteklenmeyen ajan: ${ajan}`);
  const args = [
    "run",
    "--dir",
    cwd,
    "-m",
    model,
    "--agent",
    "build",
    "--dangerously-skip-permissions",
    prompt,
  ];
  const { promise, kill } = spawnLogged("opencode", args, { cwd }, logPath, timeoutMs);
  return { promise: promise.then((r) => ({ ...r, sessionId: null })), kill };
}

function runScript({ komut, cwd, logPath, timeoutMs }) {
  return spawnLogged(komut, [], { shell: true, cwd }, logPath, timeoutMs);
}

// Prices a session's token rows with the same rules and row shape the pricing route uses.
function sessionCostUsd(db, sessionId) {
  if (!sessionId) return 0;
  const { calculateCost } = require("../../routes/pricing");
  const rows = db
    .prepare(
      `SELECT model, speed, inference_geo, service_tier, context_size,
        SUM(input_tokens + baseline_input) AS input_tokens,
        SUM(output_tokens + baseline_output) AS output_tokens,
        SUM(cache_read_tokens + baseline_cache_read) AS cache_read_tokens,
        SUM(cache_write_tokens + baseline_cache_write) AS cache_write_tokens,
        SUM(cache_write_1h_tokens + baseline_cache_write_1h) AS cache_write_1h_tokens,
        SUM(web_search_requests + baseline_web_search) AS web_search_requests,
        SUM(web_fetch_requests + baseline_web_fetch) AS web_fetch_requests,
        SUM(code_execution_requests + baseline_code_execution) AS code_execution_requests
       FROM token_usage WHERE session_id = ?
       GROUP BY model, speed, inference_geo, service_tier, context_size`
    )
    .all(sessionId);
  if (!rows.length) return 0;
  const rules = db.prepare("SELECT * FROM model_pricing").all();
  return calculateCost(rows, rules).total_cost || 0;
}

module.exports = { runAgent, runScript, sessionCostUsd };
