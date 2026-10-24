import { CredentialStore, electronVault } from '../main/services/credential-store'
/** Model selection is main-process only. Credentials never cross IPC or enter run manifests. */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { getDefaults } from '../main/services/settings'
import { SettingsSchema, type AppSettings } from '../../src/shared/settings-schema'
import type { DevModelOption } from '../../src/shared/eris-dev'
import { getModelsStatus } from '../main/services/model-catalog'
import { listOpenAIModels } from '../main/services/openai-compatible'

let custom: { baseUrl: string; apiKey: string; models: string[] } | null = null
const erisRoot = () => join(app.getPath('appData'), 'Eris')
const read = (path: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/** Reuse installed GGUF files without copying weights or changing Eris's files. */
function linkInstalledModels() {
  for (const kind of ['builtin', 'local']) {
    const source = join(erisRoot(), 'models', kind)
    const target = join(app.getPath('userData'), 'models', kind)
    if (!existsSync(source)) continue
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !(entry.name.endsWith('.gguf') || entry.name === 'catalog-extra.json'))
        continue
      const destination = join(target, entry.name)
      if (!existsSync(destination)) {
        try {
          symlinkSync(join(source, entry.name), destination, 'file')
        } catch {
          /* API models still work when symlinks are unavailable. */
        }
      }
    }
  }
}

function settings(): AppSettings {
  const defaults = structuredClone(getDefaults())
  const saved = read(join(erisRoot(), 'settings.json'))
  const models = saved.models && typeof saved.models === 'object' ? saved.models : {}
  const parsed = SettingsSchema.parse({ ...defaults, models: { ...defaults.models, ...models } })
  if (custom)
    parsed.models.connections.push({
      id: 'dev-session',
      name: 'Dev endpoint',
      type: 'openai-compatible',
      provider: 'custom',
      enabled: true,
      baseUrl: custom.baseUrl,
      apiKeyRef: 'dev-session-key',
      models: custom.models
    })
  return parsed
}

export async function devModels(): Promise<DevModelOption[]> {
  linkInstalledModels()
  const current = settings()
  const status = await getModelsStatus(current, () => null)
  return status.models
    .filter((m) => m.ready)
    .map((m) => ({
      id: m.source === 'connection' ? JSON.stringify([m.connectionId, m.name]) : m.name,
      label:
        m.source === 'connection'
          ? `${current.models.connections.find((c) => c.id === m.connectionId)?.name ?? 'API'} · ${m.name}`
          : `${m.source} · ${m.name}`
    }))
}

export async function connectDevModel(input: {
  baseUrl: string
  apiKey?: string
}): Promise<DevModelOption[]> {
  const url = new URL(input.baseUrl)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTP(S) model API URL without credentials, query or fragment.')
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const apiKey = input.apiKey ?? ''
  const models = await listOpenAIModels(baseUrl, apiKey)
  if (!models.length) throw new Error('This endpoint returned no models.')
  custom = { baseUrl, apiKey, models }
  return devModels()
}

export async function prepareLiveModel(id: string, context: number) {
  if (!(await devModels()).some((m) => m.id === id))
    throw new Error('Selected model is unavailable. Refresh models or reconnect the endpoint.')
  const selected = settings()
  let model = id
  if (id.startsWith('[')) {
    const [connectionId, name] = JSON.parse(id) as [string, string]
    selected.models.connections = selected.models.connections.filter((c) => c.id === connectionId)
    model = name
  } else
    selected.models.connections = selected.models.connections.filter((c) => c.type === 'builtin')
  selected.models.defaultModel = model
  selected.models.contextWindow = context
  selected.images.enabled = false
  selected.agent.allowedCommands = []
  selected.agent.projectMemory = 'off'
  selected.agent.routing.preferCloudComposer = false
  selected.agent.routing.profile = 'local'
  selected.agent.routing.useLlmRouter = false
  selected.agent.maxStepsPerRun = 10
  selected.evals.useScoresForRouting = false
  const secrets = new CredentialStore(erisRoot, electronVault).readAll()
  // Snapshot credentials for this run; never persist them or return them to the renderer.
  const sessionKey = custom?.apiKey ?? null
  const getSecret = (key: string) =>
    key === 'dev-session-key'
      ? sessionKey
      : typeof secrets[key] === 'string'
        ? (secrets[key] as string)
        : null
  const digest = createHash('sha256').update(JSON.stringify(selected)).digest('hex')
  return { settings: selected, model, getSecret, digest }
}
export type PreparedLiveModel = Awaited<ReturnType<typeof prepareLiveModel>>
