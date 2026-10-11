import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync
} from 'fs'
import { dirname, join, normalize, relative, resolve, sep } from 'path'
import { config } from './config.js'
import type { CloudJobFile } from './types.js'

const execFileAsync = promisify(execFile)

export function jobWorkspace(jobId: string): string {
  return join(config.dataDir, 'workspaces', jobId)
}

export function assertInWorkspace(workspace: string, relPath: string): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..')) {
    throw new Error('Invalid path')
  }
  const abs = resolve(workspace, cleaned)
  const root = resolve(workspace) + sep
  if (abs !== resolve(workspace) && !abs.startsWith(root)) {
    throw new Error('Path escapes workspace')
  }
  return abs
}

export async function prepareWorkspace(options: {
  jobId: string
  repoUrl?: string | null
  branch?: string | null
  files?: CloudJobFile[]
}): Promise<string> {
  const root = jobWorkspace(options.jobId)
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true })
  }
  mkdirSync(root, { recursive: true })

  if (options.repoUrl?.trim()) {
    const args = ['clone', '--depth', '1']
    if (options.branch?.trim()) args.push('--branch', options.branch.trim())
    args.push(options.repoUrl.trim(), root)
    await execFileAsync('git', args, { timeout: 120_000 })
  }

  const files = options.files || []
  let written = 0
  for (const f of files) {
    if (written >= config.maxFiles) break
    const path = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path.includes('..')) continue
    const content = String(f.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > config.maxFileBytes) continue
    const abs = assertInWorkspace(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    written++
  }

  if (!options.repoUrl && files.length === 0) {
    writeFileSync(
      join(root, 'README.md'),
      '# Eris Cloud Agent workspace\n\nNo repo or files were provided. Create the project here.\n',
      'utf8'
    )
  }

  return root
}

export function listTree(workspace: string, rel = '.', maxDepth = 3): string {
  const start = assertInWorkspace(workspace, rel === '.' ? '.' : rel)
  const lines: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (name === '.git' || name === 'node_modules' || name === '.eris-cloud') continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      const relPath = relative(workspace, abs) || name
      lines.push(`${st.isDirectory() ? 'dir ' : 'file'} ${relPath}`)
      if (st.isDirectory() && depth < maxDepth) walk(abs, depth + 1)
      if (lines.length > 400) return
    }
  }
  walk(start, 1)
  return lines.join('\n') || '(empty)'
}

export function readText(workspace: string, relPath: string): string {
  const abs = assertInWorkspace(workspace, relPath)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('Not a file')
  if (st.size > config.maxFileBytes) {
    const buf = readFileSync(abs, 'utf8')
    return `${buf.slice(0, config.maxFileBytes)}\n\n[truncated]`
  }
  return readFileSync(abs, 'utf8')
}

export function writeText(workspace: string, relPath: string, content: string): string {
  const abs = assertInWorkspace(workspace, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return relative(workspace, abs) || relPath
}

export async function runShell(
  workspace: string,
  command: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, detail: 'command is required' }
  try {
    const { stdout, stderr } = await execFileAsync(
      'bash',
      ['-lc', trimmed],
      {
        cwd: workspace,
        timeout: 180_000,
        maxBuffer: 2_000_000,
        signal
      }
    )
    const detail = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim() || '(no output)'
    return { ok: true, detail: detail.slice(0, 12_000) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const detail = `${e.stdout || ''}${e.stderr || e.message || String(err)}`.trim()
    return { ok: false, detail: detail.slice(0, 12_000) }
  }
}

export function normalizeRel(path: string): string {
  return normalize(path).replace(/\\/g, '/')
}
