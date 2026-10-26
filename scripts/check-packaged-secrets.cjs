const fs = require('node:fs')
const path = require('node:path')

/** Scan unpacked payloads (including ASAR's uncompressed content), never log secret bytes. */
function scan(root) {
  const token = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/
  function visit(file) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) return
    if (/eris-feedback-token/i.test(path.basename(file))) {
      throw new Error(
        'Packaged shared feedback credential detected; remove it before distribution.'
      )
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry))
      return
    }
    if (!stat.isFile()) return
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(65536)
      let tail = ''
      let bytes
      while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        const text = tail + buffer.subarray(0, bytes).toString('latin1')
        if (token.test(text))
          throw new Error(
            'Credential-shaped data detected in packaged payload; distribution blocked.'
          )
        tail = text.slice(-256)
      }
    } finally {
      fs.closeSync(fd)
    }
  }
  visit(root)
}
module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    const helper = path.join(
      context.appOutDir,
      'resources',
      'resources',
      'native',
      'eris-owned-command.exe'
    )
    if (!fs.existsSync(helper) || fs.statSync(helper).size < 512)
      throw new Error(
        'Windows owned-command helper missing; prepare it on Windows before packaging'
      )
  }
  scan(context.appOutDir)
}
module.exports.scan = scan
if (require.main === module) {
  for (const root of process.argv.slice(2)) scan(root)
}
