/**
 * @file Express router for the decision log: questions and answers from agent transcripts, design files, export.
 * @author Caglar Ulkuderner
 */

const { Router } = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../db");
const { listDecisions, listDesigns, listProjects, toAgUi } = require("../lib/decisions");

const router = Router();

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    // Unexpected errors may carry local paths: only deliberate failures show their message.
    res.status(err.status || 500).json({ error: err.status ? err.message : "Sunucu hatası" });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v) => (typeof v === "string" && v ? v : undefined);
const needProject = (req) => str(req.query.project) || Promise.reject(fail(400, "project gerekli"));

router.get(
  "/",
  wrap(async (req, res) => {
    const project = str(req.query.project);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const decisions = await listDecisions(db, {
      project,
      status: str(req.query.status),
      q: str(req.query.q),
      limit,
    });
    const pending = (await listDecisions(db, { project, status: "pending", limit: 10000 })).length;
    res.json({ decisions, pending });
  })
);

router.get("/projects", (req, res) => res.json({ projects: listProjects(db) }));

router.get(
  "/designs",
  wrap(async (req, res) => {
    res.json({ designs: await listDesigns(db, { project: await needProject(req) }) });
  })
);

router.get(
  "/designs/file",
  wrap(async (req, res) => {
    const project = await needProject(req);
    const rel = str(req.query.path);
    // Only paths listDesigns itself returned: no "..", no arbitrary files.
    const known = rel && (await listDesigns(db, { project })).some((d) => d.path === rel);
    let real = null;
    if (known) {
      try {
        real = fs.realpathSync(path.join(project, rel));
        if (!real.startsWith(fs.realpathSync(project) + path.sep)) real = null; // symlink leaves project
      } catch {
        real = null; // missing file
      }
    }
    if (!real) throw fail(404, "Tasarım dosyası bulunamadı");
    // Agent-written HTML must not run with the cockpit's origin (its API and token).
    res.set("Content-Security-Policy", "sandbox allow-scripts");
    res.set("X-Content-Type-Options", "nosniff");
    res.sendFile(real);
  })
);

router.get(
  "/export",
  wrap(async (req, res) => {
    const project = await needProject(req);
    const format = req.query.format || "ag-ui";
    if (format !== "ag-ui" && format !== "json") throw fail(400, "Bilinmeyen biçim");
    const decisions = await listDecisions(db, { project, limit: 10000 });
    const name = path.basename(project).replace(/[^A-Za-z0-9._-]/g, "_");
    res.set("Content-Disposition", `attachment; filename="kararlar-${name}.json"`);
    res.json(
      format === "json"
        ? { decisions }
        : {
            interrupts: decisions.map((d) => toAgUi(d).interrupt),
            resume: decisions.map((d) => toAgUi(d).resume).filter(Boolean),
          }
    );
  })
);

module.exports = router;
