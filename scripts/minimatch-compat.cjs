/** Keep old callable CommonJS consumers compatible with the patched 11.0.1 engine.
 * Only exports are adapted; upstream parsing/matching/security checks are unchanged. */
const fs = require('node:fs')
const path = require('node:path')
const marker = '// Eris legacy callable minimatch export compatibility'
let found = 0
function packageDirectory(dir, name) {
  if (name === 'minimatch') {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (pkg.version !== '11.0.1') throw new Error(`Unexpected minimatch engine ${pkg.version}`)
    const file = path.join(dir, 'dist/commonjs/index.js')
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes(marker))
      fs.appendFileSync(
        file,
        `\n${marker}\nmodule.exports = Object.assign(exports.minimatch, exports);\n`
      )
    const protocolMarker = '// Eris glob7 Matcher protocol compatibility'
    if (!fs.readFileSync(file, 'utf8').includes(protocolMarker))
      fs.appendFileSync(
        file,
        `\n${protocolMarker}\nconst LegacyMatcher = require('@isaacs/nonrecursive-glob-match').Matcher;\nObject.defineProperty(LegacyMatcher.prototype, '_glob', { get() { return this.pattern; }, configurable: true });\nObject.defineProperty(LegacyMatcher.prototype, Symbol.match, { value(input) { const text = String(input); return this.test(text) ? [text] : null; }, configurable: true });\n`
      )
    found++
  }
  visit(path.join(dir, 'node_modules'))
}
function visit(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const target = path.join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of fs.readdirSync(target, { withFileTypes: true }))
        if (child.isDirectory()) packageDirectory(path.join(target, child.name), child.name)
    } else packageDirectory(target, entry.name)
  }
}
visit(path.resolve(__dirname, '../node_modules'))
if (!found) throw new Error('Patched minimatch engine was not installed')
console.log(`Validated patched minimatch compatibility: ${found} installation(s)`)
