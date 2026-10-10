import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { dirname } from 'path'
import {
  AgentDefinitionSchema,
  ProjectAgentsSchema,
  type AgentDefinition,
  type AppSettings,
  type ProjectAgentsConfig,
  type ResolvedAgent
} from '../../../src/shared/settings-schema'
import { builtinAgentsPath, workspaceAgentsPath, workspaceConfigDir } from './paths'

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

function normalizeAgent(raw: unknown, fallbackBuiltin = false): AgentDefinition {
  const input = (raw ?? {}) as Record<string, unknown>
  const builtin = typeof input.builtin === 'boolean' ? input.builtin : fallbackBuiltin
  let model = String(input.model ?? '')
  // Built-in agents inherit the app default (Lite/Full) instead of pinning Full.
  if (builtin && (model === 'builtin:composer' || model === 'builtin:composer-lite')) {
    model = ''
  }
  const toolsRaw = String(input.tools ?? '')
  const tools =
    toolsRaw === 'none' || toolsRaw === 'read' || toolsRaw === 'edit' || toolsRaw === 'full'
      ? toolsRaw
      : builtin
        ? input.id === 'fast'
          ? 'none'
          : input.id === 'explainer' || input.id === 'reviewer'
            ? 'read'
            : input.id === 'composer'
              ? 'full'
              : 'edit'
        : 'edit'
  return AgentDefinitionSchema.parse({
    id: String(input.id ?? ''),
    name: String(input.name ?? input.id ?? 'Agent'),
    description: String(input.description ?? ''),
    model,
    temperature: (input.temperature as number | null | undefined) ?? null,
    enabled: input.enabled !== false,
    builtin,
    systemPrompt: String(input.systemPrompt ?? ''),
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((k) => String(k))
      : [],
    tools,
    preferEscalate:
      typeof input.preferEscalate === 'boolean'
        ? input.preferEscalate
        : tools === 'edit' || tools === 'full'
  })
}

export function loadBuiltinAgents(): ProjectAgentsConfig {
  const raw = readJson<unknown>(builtinAgentsPath())
  if (!raw) {
    throw new Error(`Missing builtin agents at ${builtinAgentsPath()}`)
  }
  const parsed = ProjectAgentsSchema.parse({
    version: (raw as ProjectAgentsConfig).version ?? 1,
    orchestrator: normalizeAgent((raw as ProjectAgentsConfig).orchestrator, true),
    subagents: ((raw as ProjectAgentsConfig).subagents ?? []).map((a) => normalizeAgent(a, true))
  })
  return parsed
}

/** Merge project agents over builtin by id; keep project-only custom agents. */
export function mergeAgentConfigs(
  builtin: ProjectAgentsConfig,
  project: ProjectAgentsConfig | null
): ProjectAgentsConfig {
  if (!project) return builtin

  const byId = new Map<string, AgentDefinition>()
  byId.set(builtin.orchestrator.id, { ...builtin.orchestrator, builtin: true })
  for (const agent of builtin.subagents) {
    byId.set(agent.id, { ...agent, builtin: true })
  }

  const mergeOne = (incoming: AgentDefinition) => {
    const existing = byId.get(incoming.id)
    const isBuiltin = Boolean(existing?.builtin || incoming.builtin)
    if (!existing) {
      byId.set(incoming.id, { ...incoming, builtin: isBuiltin })
      return
    }
    // Project may override model/temperature/enabled/name; keep shipping prompts/keywords
    // for builtin agents so routing and tool behavior stay current.
    byId.set(incoming.id, {
      ...existing,
      ...incoming,
      builtin: isBuiltin,
      systemPrompt: isBuiltin ? existing.systemPrompt : incoming.systemPrompt,
      keywords: isBuiltin ? existing.keywords : incoming.keywords,
      description: isBuiltin ? existing.description : incoming.description,
      tools: isBuiltin ? existing.tools : incoming.tools,
      preferEscalate: isBuiltin ? existing.preferEscalate : incoming.preferEscalate
    })
  }

  mergeOne(normalizeAgent(project.orchestrator, project.orchestrator.builtin))
  for (const agent of project.subagents ?? []) {
    mergeOne(normalizeAgent(agent, agent.builtin))
  }

  const orchId = project.orchestrator?.id || builtin.orchestrator.id
  const orchestrator = byId.get(orchId) ?? builtin.orchestrator
  byId.delete(orchestrator.id)

  return {
    version: Math.max(builtin.version, project.version ?? 1),
    orchestrator,
    subagents: Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  }
}

export function readProjectAgents(workspacePath: string | null): ProjectAgentsConfig | null {
  if (!workspacePath) return null
  const path = workspaceAgentsPath(workspacePath)
  const raw = readJson<unknown>(path)
  if (!raw) return null
  try {
    return ProjectAgentsSchema.parse({
      version: (raw as ProjectAgentsConfig).version ?? 1,
      orchestrator: normalizeAgent((raw as ProjectAgentsConfig).orchestrator),
      subagents: ((raw as ProjectAgentsConfig).subagents ?? []).map((a) => normalizeAgent(a))
    })
  } catch {
    return null
  }
}

export function getProjectAgents(workspacePath: string | null): ProjectAgentsConfig {
  const builtin = loadBuiltinAgents()
  const project = readProjectAgents(workspacePath)
  return mergeAgentConfigs(builtin, project)
}

export function seedProjectAgents(workspacePath: string, force = false): ProjectAgentsConfig {
  mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
  const target = workspaceAgentsPath(workspacePath)
  const builtin = loadBuiltinAgents()

  if (!existsSync(target) || force) {
    copyFileSync(builtinAgentsPath(), target)
    return builtin
  }

  // Upgrade: add any new builtin agents without wiping project edits
  const project = readProjectAgents(workspacePath)
  const merged = mergeAgentConfigs(builtin, project)
  if (project) {
    const existing = new Set([
      project.orchestrator.id,
      ...project.subagents.map((a) => a.id)
    ])
    const missingBuiltin = [builtin.orchestrator, ...builtin.subagents].some(
      (a) => !existing.has(a.id)
    )
    if (missingBuiltin) writeJson(target, merged)
  }
  return merged
}

export function saveProjectAgents(
  workspacePath: string,
  config: ProjectAgentsConfig
): ProjectAgentsConfig {
  const parsed = ProjectAgentsSchema.parse({
    version: config.version ?? 1,
    orchestrator: normalizeAgent(config.orchestrator),
    subagents: config.subagents.map((a) => normalizeAgent(a))
  })
  writeJson(workspaceAgentsPath(workspacePath), parsed)
  return parsed
}

export function listResolvedAgents(
  workspacePath: string | null,
  settings: AppSettings
): ResolvedAgent[] {
  const config = getProjectAgents(workspacePath)
  const source: ResolvedAgent['source'] = workspacePath && existsSync(workspaceAgentsPath(workspacePath))
    ? 'project'
    : 'builtin'

  const toResolved = (
    agent: AgentDefinition,
    role: ResolvedAgent['role']
  ): ResolvedAgent => ({
    ...agent,
    role,
    source: agent.builtin ? source : 'project',
    resolvedModel: agent.model.trim() || settings.models.defaultModel
  })

  return [
    toResolved(config.orchestrator, 'orchestrator'),
    ...config.subagents.map((a) => toResolved(a, 'specialist'))
  ].filter((a) => a.enabled)
}

export function findAgent(
  workspacePath: string | null,
  id: string
): AgentDefinition | null {
  const config = getProjectAgents(workspacePath)
  if (config.orchestrator.id === id) return config.orchestrator
  return config.subagents.find((a) => a.id === id) ?? null
}

export function allAgentsFlat(workspacePath: string | null): AgentDefinition[] {
  const config = getProjectAgents(workspacePath)
  return [config.orchestrator, ...config.subagents]
}
