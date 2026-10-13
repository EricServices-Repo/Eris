import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { IncomingMessage } from 'http'
import { config } from './config.js'
import { getLocalModelStatus } from './local-model.js'
import { getMetrics, audit } from './observe.js'
import {
  getConfigRevision,
  getRemoteConfig,
  loadRemoteConfigFromDisk,
  persistRemoteConfig,
  publicRemoteConfig,
  sanitizeRemoteSettings,
  type RemoteAgentSettings
} from './runtime-config.js'
import type { JobStore } from './job-store.js'

export type FleetIdentity = {
  agentId: string
  agentSecret: string
  enrollToken?: string
  displayName?: string
  enrolledAt?: string
}

type FleetStateFile = FleetIdentity & {
  lastHeartbeatAt?: string
  lastConfigPullAt?: string
  platformAgentUrl?: string
}

function fleetPath(): string {
  return join(config.dataDir, 'fleet.json')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

let identity: FleetStateFile | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let syncing = false

function erisCloudAgentsBase(): string {
  return `${config.erisApiBase.replace(/\/+$/, '')}/cloud-agents`
}

export function loadFleetIdentity(): FleetStateFile | null {
  try {
    const fromEnvId = (process.env.ERIS_CLOUD_FLEET_AGENT_ID || '').trim()
    const fromEnvSecret = (process.env.ERIS_CLOUD_FLEET_AGENT_SECRET || '').trim()
    if (fromEnvId && fromEnvSecret) {
      identity = {
        agentId: fromEnvId,
        agentSecret: fromEnvSecret,
        displayName: (process.env.ERIS_CLOUD_FLEET_NAME || '').trim() || undefined
      }
      return identity
    }
    if (!existsSync(fleetPath())) return null
    const raw = JSON.parse(readFileSync(fleetPath(), 'utf8')) as FleetStateFile
    if (!raw?.agentId || !raw?.agentSecret) return null
    identity = raw
    return identity
  } catch {
    return null
  }
}

function saveFleetIdentity(next: FleetStateFile): void {
  identity = next
  try {
    mkdirSync(config.dataDir, { recursive: true })
    writeFileSync(fleetPath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // ignore
  }
}

export function getFleetIdentity(): FleetStateFile | null {
  return identity || loadFleetIdentity()
}

export function fleetConfigured(): boolean {
  const id = getFleetIdentity()
  return Boolean(id?.agentId && id?.agentSecret)
}

export function verifyAgentSecret(req: IncomingMessage): boolean {
  const id = getFleetIdentity()
  if (!id?.agentSecret) return false
  const header =
    (req.headers['x-eris-agent-secret'] || '').toString().trim() ||
    (() => {
      const auth = (req.headers.authorization || '').trim()
      const m = /^Bearer\s+(.+)$/i.exec(auth)
      return m?.[1]?.trim() || ''
    })()
  if (!header) return false
  const agentIdHeader = (req.headers['x-eris-agent-id'] || '').toString().trim()
  if (agentIdHeader && agentIdHeader !== id.agentId) return false
  return safeEqual(header, id.agentSecret)
}

function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}

export function buildHeartbeatPayload(store: JobStore): Record<string, unknown> {
  const local = getLocalModelStatus()
  const counts = store.counts()
  const metrics = getMetrics()
  const id = getFleetIdentity()
  return {
    agentId: id?.agentId || null,
    displayName: id?.displayName || getRemoteConfig()?.settings.displayName || null,
    version: config.version,
    publicBaseUrl: config.publicBaseUrl,
    ready: config.llmBase ? true : local.status === 'ready',
    gpuMode: config.gpu,
    inference: config.llmBase ? 'remote' : 'local',
    localModel: {
      status: local.status,
      modelId: local.modelId,
      modelName: local.modelName,
      cached: local.cached,
      gpu: local.gpu ?? null
    },
    jobs: { running: counts.running, queued: counts.queued },
    limits: {
      maxParallel: config.maxParallel,
      maxThreads: config.maxThreads,
      contextSize: config.contextSize,
      warmOnStart: config.warmOnStart,
      freeJobsPerDay: config.freeJobsPerDay,
      maxConcurrentFree: config.maxConcurrentFree,
      maxConcurrentPro: config.maxConcurrentPro
    },
    metrics: {
      uptimeSec: metrics.uptimeSec,
      enqueues: metrics.enqueues,
      jobsDone: metrics.jobsDone,
      jobsFailed: metrics.jobsFailed,
      successRate: metrics.successRate
    },
    configRevision: getConfigRevision(),
    secretFingerprint: id ? fingerprintSecret(id.agentSecret) : null,
    at: new Date().toISOString()
  }
}

export function fleetStatusPublic(store: JobStore): Record<string, unknown> {
  const id = getFleetIdentity()
  return {
    ok: true,
    linked: fleetConfigured(),
    agentId: id?.agentId || null,
    displayName: id?.displayName || getRemoteConfig()?.settings.displayName || null,
    enrolledAt: id?.enrolledAt || null,
    lastHeartbeatAt: id?.lastHeartbeatAt || null,
    lastConfigPullAt: id?.lastConfigPullAt || null,
    config: publicRemoteConfig(),
    heartbeat: buildHeartbeatPayload(store)
  }
}

/**
 * One-time enroll with a token created on EricServic.es Admin → Cloud Agents.
 * Saves agentId + agentSecret under dataDir/fleet.json.
 */
export async function enrollWithPlatform(enrollToken?: string): Promise<{
  ok: boolean
  error?: string
  agentId?: string
}> {
  const token =
    (enrollToken || process.env.ERIS_CLOUD_FLEET_ENROLL_TOKEN || '').trim() ||
    getFleetIdentity()?.enrollToken ||
    ''
  if (!token) {
    return { ok: false, error: 'No enroll token (ERIS_CLOUD_FLEET_ENROLL_TOKEN)' }
  }
  if (fleetConfigured() && !enrollToken) {
    return { ok: true, agentId: getFleetIdentity()!.agentId }
  }

  const url = `${erisCloudAgentsBase()}/enroll.php`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'eris-cloud-agent'
      },
      body: JSON.stringify({
        enrollToken: token,
        version: config.version,
        publicBaseUrl: config.publicBaseUrl,
        gpuMode: config.gpu,
        name: (process.env.ERIS_CLOUD_FLEET_NAME || '').trim() || undefined
      }),
      signal: AbortSignal.timeout(15_000)
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      const error =
        typeof data.error === 'string' ? data.error : `Enroll failed (${res.status})`
      audit('fleet_enroll_failed', { error: error.slice(0, 200) })
      return { ok: false, error }
    }
    const agentId = String(data.agentId || '').trim()
    const agentSecret = String(data.agentSecret || '').trim()
    if (!agentId || !agentSecret) {
      return { ok: false, error: 'Enroll response missing agentId/agentSecret' }
    }
    saveFleetIdentity({
      agentId,
      agentSecret,
      enrollToken: token,
      displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
      enrolledAt: new Date().toISOString()
    })
    if (data.config && typeof data.config === 'object') {
      const revision = Number((data as { configRevision?: number }).configRevision) || 1
      persistRemoteConfig(
        revision,
        sanitizeRemoteSettings((data.config as { settings?: unknown }).settings ?? data.config),
        'enroll'
      )
    }
    audit('fleet_enrolled', { agentId })
    return { ok: true, agentId }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    audit('fleet_enroll_error', { error: error.slice(0, 200) })
    return { ok: false, error }
  }
}

async function pullOrHeartbeat(store: JobStore): Promise<void> {
  const id = getFleetIdentity()
  if (!id?.agentId || !id.agentSecret) return
  if (syncing) return
  syncing = true
  try {
    const url = `${erisCloudAgentsBase()}/heartbeat.php`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'eris-cloud-agent',
        'X-Eris-Agent-Id': id.agentId,
        'X-Eris-Agent-Secret': id.agentSecret
      },
      body: JSON.stringify(buildHeartbeatPayload(store)),
      signal: AbortSignal.timeout(12_000)
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      audit('fleet_heartbeat_failed', {
        status: res.status,
        error: typeof data.error === 'string' ? data.error.slice(0, 160) : undefined
      })
      return
    }

    const now = new Date().toISOString()
    saveFleetIdentity({ ...id, lastHeartbeatAt: now })

    const remoteRev = Number(data.configRevision)
    const localRev = getConfigRevision()
    if (
      Number.isFinite(remoteRev) &&
      remoteRev > localRev &&
      data.config &&
      typeof data.config === 'object'
    ) {
      const settings = sanitizeRemoteSettings(
        (data.config as { settings?: unknown }).settings ?? data.config
      )
      persistRemoteConfig(remoteRev, settings, 'pull')
      saveFleetIdentity({ ...getFleetIdentity()!, lastHeartbeatAt: now, lastConfigPullAt: now })
      audit('fleet_config_pulled', { revision: remoteRev })
    }
  } catch (err) {
    audit('fleet_heartbeat_error', {
      error: err instanceof Error ? err.message.slice(0, 200) : String(err)
    })
  } finally {
    syncing = false
  }
}

/** Apply config pushed from EricServic.es (or admin) onto this agent. */
export function acceptPushedConfig(body: {
  revision?: number
  settings?: RemoteAgentSettings
  config?: RemoteAgentSettings
}): { ok: true; revision: number; changed: string[] } | { ok: false; error: string } {
  const settings = sanitizeRemoteSettings(body.settings ?? body.config ?? {})
  const revision =
    body.revision != null && Number.isFinite(Number(body.revision))
      ? Math.floor(Number(body.revision))
      : getConfigRevision() + 1
  if (revision < getConfigRevision()) {
    return { ok: false, error: `Stale revision ${revision} (local ${getConfigRevision()})` }
  }
  persistRemoteConfig(revision, settings, 'push')
  return { ok: true, revision, changed: Object.keys(settings) }
}

/**
 * Boot: load disk overrides, optional enroll, start heartbeat loop.
 * Safe if EricServic.es endpoints are not deployed yet (logs + continues).
 */
export function startFleetSync(store: JobStore): void {
  loadRemoteConfigFromDisk()
  loadFleetIdentity()

  const intervalMs = Math.max(
    30_000,
    Math.min(600_000, Number(process.env.ERIS_CLOUD_FLEET_SYNC_MS || 60_000) || 60_000)
  )

  void (async () => {
    if (!fleetConfigured()) {
      const enroll = (process.env.ERIS_CLOUD_FLEET_ENROLL_TOKEN || '').trim()
      if (enroll) {
        const r = await enrollWithPlatform(enroll)
        if (!r.ok) {
          console.warn(`[eris-cloud-agent] fleet enroll deferred: ${r.error}`)
        } else {
          console.log(`[eris-cloud-agent] fleet enrolled · agentId=${r.agentId}`)
        }
      } else {
        console.log(
          '[eris-cloud-agent] fleet sync idle — set ERIS_CLOUD_FLEET_ENROLL_TOKEN or AGENT_ID/SECRET'
        )
      }
    }
    if (fleetConfigured()) {
      await pullOrHeartbeat(store)
      if (syncTimer) clearInterval(syncTimer)
      syncTimer = setInterval(() => void pullOrHeartbeat(store), intervalMs)
      if (typeof syncTimer === 'object' && 'unref' in syncTimer) syncTimer.unref()
      console.log(
        `[eris-cloud-agent] fleet sync every ${Math.round(intervalMs / 1000)}s · agentId=${getFleetIdentity()?.agentId}`
      )
    }
  })()
}

/** Generate a local agent identity for lab use (not platform-linked). */
export function ensureLocalFleetIdentity(displayName?: string): FleetStateFile {
  const existing = getFleetIdentity()
  if (existing) return existing
  const next: FleetStateFile = {
    agentId: `local_${randomBytes(8).toString('hex')}`,
    agentSecret: randomBytes(24).toString('base64url'),
    displayName: displayName || 'local-agent',
    enrolledAt: new Date().toISOString()
  }
  saveFleetIdentity(next)
  return next
}
