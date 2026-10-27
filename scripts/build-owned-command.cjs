// Build the trusted Windows launcher once per source revision. No runtime compiler
// or PowerShell descendants can escape command ownership during chat execution.
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { join, resolve } = require('path')
const { createHash } = require('crypto')
const { spawnSync } = require('child_process')
if (process.platform === 'win32') {
  const root = resolve(__dirname, '..'),
    source = join(root, 'electron', 'native', 'OwnedCommand.cs')
  const output = join(root, 'resources', 'native', 'eris-owned-command.exe'),
    stamp = output + '.sha256'
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex')
  if (!existsSync(output) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== digest) {
    const compiler = ['Framework64', 'Framework']
      .map((kind) => join(process.env.SystemRoot, 'Microsoft.NET', kind, 'v4.0.30319', 'csc.exe'))
      .find(existsSync)
    if (!compiler)
      throw new Error(
        'Windows .NET Framework C# compiler unavailable; cannot qualify owned commands'
      )
    mkdirSync(join(root, 'resources', 'native'), { recursive: true })
    const result = spawnSync(
      compiler,
      ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/out:' + output, source],
      { cwd: root, stdio: 'inherit', timeout: 30000, windowsHide: true }
    )
    if (result.error || result.status !== 0)
      throw new Error(
        'Windows command helper compilation failed: ' + (result.error?.message ?? result.status)
      )
    writeFileSync(stamp, digest)
  }
}
