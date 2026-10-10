import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SkillInput, SkillRecord, SkillScope } from '../../../src/shared/settings-schema'
import { userSkillsDir, workspaceSkillsDir } from './paths'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function slugifySkillId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || `skill-${Date.now().toString(36)}`
}

function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) {
    return { name: '', description: '', body: raw.trim() }
  }
  const yaml = match[1]
  const body = match[2].trim()
  let name = ''
  let description = ''

  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')

  const descFolded = yaml.match(/^description:\s*>\s*\n((?:[ \t]+.+\n?)*)/m)
  if (descFolded) {
    description = descFolded[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]+/, ''))
      .filter(Boolean)
      .join(' ')
      .trim()
  } else {
    const descMatch = yaml.match(/^description:\s*(.+)$/m)
    if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, '')
  }

  return { name, description, body }
}

function buildSkillMarkdown(name: string, description: string, body: string): string {
  const safeDesc = description.trim() || 'Agent skill for Eris'
  const needsFold = safeDesc.includes('\n') || safeDesc.length > 80
  const descBlock = needsFold
    ? `description: >\n  ${safeDesc.replace(/\n/g, '\n  ')}`
    : `description: ${safeDesc}`
  const contentBody = body.trim() || `# ${name}\n\nDescribe how the agent should use this skill.\n`
  return `---\nname: ${name}\n${descBlock}\n---\n\n${contentBody}\n`
}

function skillDir(workspacePath: string | null, scope: SkillScope, id: string): string {
  if (scope === 'user') return join(userSkillsDir(), id)
  if (!workspacePath) throw new Error('Open a workspace to manage project skills')
  return join(workspaceSkillsDir(workspacePath), id)
}

function readSkillAt(dir: string, id: string, scope: SkillScope): SkillRecord | null {
  const path = join(dir, 'SKILL.md')
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf8')
    const parsed = parseFrontmatter(content)
    const st = statSync(path)
    return {
      id,
      name: parsed.name || id,
      description: parsed.description,
      body: parsed.body,
      content,
      scope,
      path,
      updatedAt: st.mtimeMs
    }
  } catch {
    return null
  }
}

function listScope(dir: string, scope: SkillScope): SkillRecord[] {
  if (!existsSync(dir)) return []
  const out: SkillRecord[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    const skill = readSkillAt(full, name, scope)
    if (skill) out.push(skill)
  }
  return out
}

export function listSkills(workspacePath: string | null): SkillRecord[] {
  const user = listScope(userSkillsDir(), 'user')
  const workspace = workspacePath ? listScope(workspaceSkillsDir(workspacePath), 'workspace') : []
  // Workspace skills override user skills with the same id
  const byId = new Map<string, SkillRecord>()
  for (const s of user) byId.set(s.id, s)
  for (const s of workspace) byId.set(s.id, s)
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getSkill(
  workspacePath: string | null,
  id: string,
  scope?: SkillScope
): SkillRecord | null {
  if (scope) {
    try {
      return readSkillAt(skillDir(workspacePath, scope, id), id, scope)
    } catch {
      return null
    }
  }
  if (workspacePath) {
    const ws = readSkillAt(join(workspaceSkillsDir(workspacePath), id), id, 'workspace')
    if (ws) return ws
  }
  return readSkillAt(join(userSkillsDir(), id), id, 'user')
}

export function createSkill(workspacePath: string | null, input: SkillInput): SkillRecord {
  const id = slugifySkillId(input.id || input.name)
  const scope = input.scope
  if (scope === 'workspace' && !workspacePath) {
    throw new Error('Open a workspace to create a project skill')
  }
  const dir = skillDir(workspacePath, scope, id)
  if (existsSync(join(dir, 'SKILL.md'))) {
    throw new Error(`Skill “${id}” already exists in ${scope} scope`)
  }
  ensureDir(dir)
  const name = input.name.trim() || id
  const content = buildSkillMarkdown(name, input.description, input.body)
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
  const skill = getSkill(workspacePath, id, scope)
  if (!skill) throw new Error('Failed to create skill')
  return skill
}

/** Create or overwrite a skill. Defaults to user scope (outside any project). */
export function upsertSkill(
  workspacePath: string | null,
  input: Omit<SkillInput, 'scope'> & { scope?: SkillScope }
): SkillRecord {
  const scope: SkillScope = input.scope === 'workspace' ? 'workspace' : 'user'
  const id = slugifySkillId(input.id || input.name)
  if (scope === 'workspace' && !workspacePath) {
    throw new Error('Open a workspace to create a project skill')
  }
  ensureDir(userSkillsDir())
  if (workspacePath) ensureSkillsDirs(workspacePath)
  const existing = getSkill(workspacePath, id, scope)
  if (existing) {
    return updateSkill(workspacePath, id, scope, {
      name: input.name,
      description: input.description,
      body: input.body
    })
  }
  return createSkill(workspacePath, {
    id,
    name: input.name,
    description: input.description,
    body: input.body,
    scope
  })
}

export function formatSkillsListForAgent(workspacePath: string | null): string {
  const all = listSkills(workspacePath)
  if (all.length === 0) {
    return (
      'No skills yet.\n' +
      `User skills path: ${userSkillsDir()}\n` +
      'Use write_skill with scope "user" (default) to save outside the project.'
    )
  }
  return (
    `User skills dir: ${userSkillsDir()}\n` +
    (workspacePath ? `Project skills dir: ${workspaceSkillsDir(workspacePath)}\n` : '') +
    all
      .map(
        (s) =>
          `- ${s.id} [${s.scope}] ${s.name}` +
          (s.description ? ` — ${s.description.slice(0, 120)}` : '') +
          `\n  path: ${s.path}`
      )
      .join('\n')
  )
}

export function updateSkill(
  workspacePath: string | null,
  id: string,
  scope: SkillScope,
  patch: Partial<Pick<SkillInput, 'name' | 'description' | 'body'>>
): SkillRecord {
  const existing = getSkill(workspacePath, id, scope)
  if (!existing) throw new Error(`Skill “${id}” not found`)
  const name = (patch.name ?? existing.name).trim() || id
  const description = patch.description ?? existing.description
  const body = patch.body ?? existing.body
  const content = buildSkillMarkdown(name, description, body)
  writeFileSync(existing.path, content, 'utf8')
  const updated = getSkill(workspacePath, id, scope)
  if (!updated) throw new Error('Failed to update skill')
  return updated
}

export function deleteSkill(workspacePath: string | null, id: string, scope: SkillScope): boolean {
  const dir = skillDir(workspacePath, scope, id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

export function ensureSkillsDirs(workspacePath: string | null): void {
  ensureDir(userSkillsDir())
  if (workspacePath) {
    const dir = workspaceSkillsDir(workspacePath)
    ensureDir(dir)
    const readme = join(dir, 'README.md')
    if (!existsSync(readme)) {
      writeFileSync(
        readme,
        '# Workspace skills\n\nEach skill lives in a folder with a `SKILL.md` file.\nUse `/create-skill` in chat or Settings → Skills to manage them.\n',
        'utf8'
      )
    }
  }
}

/** Load skill bodies for injection into the agent prompt. */
export function loadSkillsPrompt(workspacePath: string | null, ids?: string[]): string {
  const all = listSkills(workspacePath)
  const selected = ids?.length ? all.filter((s) => ids.includes(s.id)) : []
  if (selected.length === 0) return ''
  return selected
    .map(
      (s) =>
        `# Skill: ${s.name} (${s.id})\n${s.description ? `${s.description}\n\n` : ''}${s.body}`
    )
    .join('\n\n')
}

export function skillTemplate(name = 'my-skill'): { name: string; description: string; body: string } {
  return {
    name,
    description: 'Brief description of what this skill does and when to use it',
    body: `# ${name}\n\n## Instructions\n\nTell the agent how to perform this task step by step.\n\n## Examples\n\nProvide a short example of expected input and output.\n`
  }
}

export type SyncableSkill = {
  id: string
  name: string
  description: string
  body: string
}

/** User-scope skills only (safe for EricServic.es profile sync). */
export function exportUserSkillsForSync(): SyncableSkill[] {
  return listScope(userSkillsDir(), 'user').map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    body: s.body
  }))
}

/** Upsert user skills from a remote profile bundle (does not delete local-only skills). */
export function importUserSkillsFromSync(skills: SyncableSkill[]): { imported: number } {
  ensureDir(userSkillsDir())
  let imported = 0
  for (const skill of skills) {
    if (!skill?.id || typeof skill.id !== 'string') continue
    const id = slugifySkillId(skill.id)
    const dir = join(userSkillsDir(), id)
    ensureDir(dir)
    const name = (skill.name || id).trim() || id
    const content = buildSkillMarkdown(name, skill.description || '', skill.body || '')
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
    imported++
  }
  return { imported }
}
