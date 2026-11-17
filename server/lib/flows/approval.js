/**
 * @file approval.js
 * @description Content hash a flow approval is bound to: the flow YAML plus every role prompt it uses.
 * @author Caglar Ulkuderner
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const flowPath = (cwd, name) => path.join(cwd, ".ai-cockpit", "akislar", `${name}.yaml`);

function flowHash(cwd, yamlText, flow) {
  const hash = crypto.createHash("sha256").update(yamlText);
  const roles = [...new Set(flow.adimlar.map((s) => s.rol).filter(Boolean))].sort();
  for (const rol of roles) {
    let text;
    try {
      text = fs.readFileSync(path.join(cwd, rol));
    } catch {
      throw Object.assign(new Error(`Rol dosyası bulunamadı: ${rol}`), { status: 400 });
    }
    hash.update(`\0${rol}\0`).update(text);
  }
  return hash.digest("hex");
}

module.exports = { flowHash, flowPath };
