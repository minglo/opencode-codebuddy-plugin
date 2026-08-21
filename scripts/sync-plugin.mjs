/**
 * Sync dist/index.js -> .opencode/plugins/codebuddy.js
 * Keeps the self-contained plugin in sync with src/index.ts build output.
 * Uses header + dist content, injects legacy exports.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const dist = fs.readFileSync(path.join(root, "dist/index.js"), "utf8")
let out = dist
if (!out.includes("export const CodeBuddyPlugin")) {
  out = out.replace(
    'export default {',
    'export const CodeBuddyPlugin = CodeBuddyAuthPlugin;\nexport const CodebuddyPlugin = CodeBuddyAuthPlugin;\nexport default {'
  )
}
const header = `/**
 * CodeBuddy plugin for OpenCode — self-contained ESM plugin (superpowers pattern)
 * - Zero build dependency: this file is the plugin entrypoint (package.json main points here)
 * - Works via both npm: "plugin": ["opencode-codebuddy-plugin@git+https://..."] and local file: cp to ~/.config/opencode/plugins/
 * - Source of truth is src/index.ts; this file is kept in sync (npm run build && node scripts/sync-plugin.mjs)
 * - Exports both V1 default {id, server} and legacy named exports for opencode loader compatibility
 */
`
out = header + out
fs.writeFileSync(path.join(root, ".opencode/plugins/codebuddy.js"), out)
console.log("[sync] .opencode/plugins/codebuddy.js updated", out.length, "bytes")
// also fix .opencode/package.json type
const opPkg = path.join(root, ".opencode/package.json")
if (fs.existsSync(opPkg)) {
  const j = JSON.parse(fs.readFileSync(opPkg, "utf8"))
  if (j.type !== "module") { j.type = "module"; fs.writeFileSync(opPkg, JSON.stringify(j, null, 2)+"\n"); console.log("[sync] .opencode/package.json set type:module") }
}
