import { app } from 'electron'
import { existsSync, readFileSync, statSync } from 'fs'
import { createRequire } from 'module'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'

export function languageServerFilePath(uri: string): string {
  // fileURLToPath handles Windows drive letters, UNC hosts, escaped spaces and Unicode.
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function languageServerLaunch(command: string, args: string[], root: string) {
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.COM;.CMD;.BAT').split(';')]
      : ['']
  const names = extname(command)
    ? [command]
    : extensions.map((extension) => command + extension.toLowerCase())
  const directories = [
    join(root, 'node_modules', '.bin'),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  ]
  const candidates =
    isAbsolute(command) || /[\\/]/.test(command)
      ? names.map((name) => resolve(root, name))
      : directories.flatMap((dir) => names.map((name) => join(dir, name)))
  const found = candidates.find(isFile)
  if (!found) throw new Error(`Language server executable not found: ${command}`)
  let script = /\.(?:mjs|cjs|js)$/i.test(found) ? found : null
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(found)) {
    // Standard npm Windows shims contain a constant script path. Launch that JS entry
    // directly, never interpolate configured arguments into cmd.exe /c.
    const shim = readFileSync(found, 'utf8')
    const relative =
      shim.match(/"%dp0%[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"/i)?.[1] ??
      shim.match(/"%~dp0[\\/]?([^"\r\n]+\.(?:mjs|cjs|js))"/i)?.[1]
    if (!relative)
      throw new Error(
        `Configure the JavaScript entry point or a native executable instead of the batch launcher: ${found}`
      )
    script = resolve(dirname(found), relative)
    if (!isFile(script)) throw new Error(`Language server script not found: ${script}`)
  }
  return script
    ? {
        command: process.execPath,
        args: [script, ...args],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    : { command: found, args, env: { ...process.env } }
}

export function typescriptLanguageServerLaunch(root: string) {
  for (const directory of [root, app.getAppPath()]) {
    try {
      const require = createRequire(join(directory, 'package.json'))
      const manifest = require.resolve('typescript-language-server/package.json')
      const entry = join(dirname(manifest), 'lib', 'cli.mjs')
      if (existsSync(entry)) return languageServerLaunch(entry, ['--stdio'], root)
    } catch {
      /* Try the packaged dependency before falling back to PATH. */
    }
  }
  return languageServerLaunch('typescript-language-server', ['--stdio'], root)
}
