import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { workspaceRulesDir } from './paths'

export interface RuleFile {
  id: string
  name: string
  body: string
}

function safeName(name: string): string {
  const base = name.trim().replace(/\.md$/i, '')
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${cleaned || 'rule'}.md`
}

export function listRules(workspacePath: string | null): RuleFile[] {
  if (!workspacePath) return []
  const dir = workspaceRulesDir(workspacePath)
  if (!existsSync(dir)) return []
  const out: RuleFile[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    try {
      out.push({
        id: name,
        name: name.replace(/\.md$/i, ''),
        body: readFileSync(join(dir, name), 'utf8')
      })
    } catch {
      // skip
    }
  }
  return out
}

export function getRule(workspacePath: string | null, id: string): RuleFile | null {
  if (!workspacePath) return null
  const dir = workspaceRulesDir(workspacePath)
  const file = id.endsWith('.md') ? id : `${id}.md`
  const path = join(dir, file)
  if (!existsSync(path)) return null
  return {
    id: file,
    name: file.replace(/\.md$/i, ''),
    body: readFileSync(path, 'utf8')
  }
}

export function saveRule(
  workspacePath: string,
  name: string,
  body: string,
  previousId?: string
): RuleFile {
  const dir = workspaceRulesDir(workspacePath)
  mkdirSync(dir, { recursive: true })
  const file = safeName(name)
  if (previousId && previousId !== file) {
    const old = join(dir, previousId.endsWith('.md') ? previousId : `${previousId}.md`)
    if (existsSync(old)) unlinkSync(old)
  }
  writeFileSync(join(dir, file), body, 'utf8')
  return { id: file, name: file.replace(/\.md$/i, ''), body }
}

export function deleteRule(workspacePath: string, id: string): boolean {
  const dir = workspaceRulesDir(workspacePath)
  const file = id.endsWith('.md') ? id : `${id}.md`
  const path = join(dir, file)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

export function ensureDefaultRule(workspacePath: string): void {
  const dir = workspaceRulesDir(workspacePath)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'project.md')
  if (existsSync(path)) return
  writeFileSync(
    path,
    `# Project rules\n\n- Prefer small, focused changes.\n- Match existing style in this repo.\n`,
    'utf8'
  )
}
