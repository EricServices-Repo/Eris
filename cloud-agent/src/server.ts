import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { config, llmConfigured, PUBLIC_BASE_URL } from './config.js'
import { JobStore } from './job-store.js'
import { WorkerPool } from './worker.js'
import { getLocalModelStatus, warmLocalModel } from './local-model.js'
import type { CloudJobCreateRequest, CloudHealth } from './types.js'
import { readJobArtifacts } from './artifacts.js'
import { authenticateRequest, jobVisibleTo, type AuthContext } from './auth.js'
import { jobEvents } from './events.js'
import {
  audit,
  bumpMetric,
  getMetrics,
  loadMetricsSnapshot,
  newRequestId,
  persistMetricsSnapshot,
  readRecentAudit
} from './observe.js'
import { startStatusServer } from './status-server.js'
import { buildPublicStatus, statusPageHtml } from './status-page.js'
import {
  adminKillConfigured,
  adminTokenFilePath,
  ensureAdminToken,
  getAdminTokenSource,
  verifyAdminToken
} from './admin.js'
import {
  acceptPushedConfig,
  enrollWithPlatform,
  fleetStatusPublic,
  startFleetSync,
  verifyAgentSecret
} from './fleet.js'

const store = new JobStore()
const workers = new WorkerPool(store)

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Eris-Client, X-Request-Id, X-Eris-Agent-Id, X-Eris-Agent-Secret, X-Eris-Admin-Token',
    'Cache-Control': 'no-store',
    ...extraHeaders
  })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 25 * 1024 * 1024) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { requireAuth?: boolean }
): Promise<AuthContext | null> {
  const result = await authenticateRequest(
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    opts
  )
  if (!result.ok) {
    bumpMetric('authFailures')
    send(res, result.status, { ok: false, error: result.error })
    return null
  }
  return result.auth
}

function healthBody(): Record<string, unknown> {
  const counts = store.counts()
  const local = getLocalModelStatus()
  const inference = config.llmBase ? 'remote' : 'local'
  const ready = inference === 'remote' || local.status === 'ready'
  const health: CloudHealth = {
    ok: true,
    service: 'eris-cloud-agent',
    taskContractVersion: 1, // v2 enforcement is under conformance qualification; never advertise ahead of validation.
    version: config.version,
    llmConfigured: llmConfigured(),
    ready,
    localModel: {
      status: local.status,
      modelId: local.modelId,
      modelName: local.modelName,
      error: local.error,
      gpu: local.gpu
    },
    gpuMode: config.gpu,
    inference,
    maxParallel: config.maxParallel,
    running: counts.running,
    queued: counts.queued,
    authRequired: !config.allowAnonymous
  }
  return {
    ...health,
    publicBaseUrl: config.publicBaseUrl,
    defaultClientUrl: PUBLIC_BASE_URL,
    endpoints: {
      health: '/v1/health',
      jobs: '/v1/jobs',
      job: '/v1/jobs/:id',
      events: '/v1/jobs/:id/events',
      continue: '/v1/jobs/:id/continue',
      stop: '/v1/jobs/:id/stop',
      stopAll: '/v1/jobs/stop-all',
      adminKillAll: '/v1/admin/kill-all',
      artifacts: '/v1/jobs/:id/artifacts',
      metrics: '/v1/metrics',
      fleet: '/v1/fleet',
      fleetConfig: '/v1/fleet/config',
      fleetEnroll: '/v1/fleet/enroll',
      statusPage: `http://0.0.0.0:${config.statusPort}/`
    },
    adminKillAllConfigured: adminKillConfigured(),
    statusPage: {
      enabled: config.statusEnabled,
      port: config.statusPort,
      publicHint: 'http://agents.ericservic.es/ (host :80 → container status port)'
    }
  }
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = newRequestId()
  bumpMetric('requests')
  res.setHeader('X-Request-Id', requestId)

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }

  // Health is public (for status bar / probes)
  if (req.method === 'GET' && (path === '/' || path === '/v1' || path === '/v1/health')) {
    send(res, 200, healthBody(), { 'X-Request-Id': requestId })
    return
  }

  // Public status dashboard also on the API port (no auth) — useful when host :80 is not mapped yet
  if (req.method === 'GET' && (path === '/status' || path === '/status.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId
    })
    res.end(statusPageHtml())
    return
  }
  if (req.method === 'GET' && (path === '/status.json' || path === '/v1/status')) {
    send(res, 200, buildPublicStatus(store), { 'X-Request-Id': requestId })
    return
  }

  // Fleet / EricServic.es management — status is public; mutate needs agent secret or admin
  if (req.method === 'GET' && (path === '/v1/fleet' || path === '/v1/fleet/status')) {
    send(res, 200, fleetStatusPublic(store), { 'X-Request-Id': requestId })
    return
  }

  if (req.method === 'POST' && path === '/v1/fleet/enroll') {
    // enrollToken in body (or ERIS_CLOUD_FLEET_ENROLL_TOKEN) is the credential
    try {
      const raw = await readBody(req)
      const body = (raw ? JSON.parse(raw) : {}) as { enrollToken?: string }
      const result = await enrollWithPlatform(body.enrollToken)
      send(res, result.ok ? 200 : 502, result, { 'X-Request-Id': requestId })
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if ((req.method === 'PUT' || req.method === 'POST') && path === '/v1/fleet/config') {
    if (!verifyAgentSecret(req) && !verifyAdminToken(req)) {
      bumpMetric('authFailures')
      send(res, 401, {
        ok: false,
        error: 'X-Eris-Agent-Secret or admin token required'
      })
      return
    }
    try {
      const raw = await readBody(req)
      const body = (raw ? JSON.parse(raw) : {}) as {
        revision?: number
        settings?: Record<string, unknown>
        config?: Record<string, unknown>
      }
      const result = acceptPushedConfig(body)
      send(res, result.ok ? 200 : 409, result, { 'X-Request-Id': requestId })
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (req.method === 'GET' && path === '/v1/metrics') {
    const auth = await requireAuth(req, res)
    if (!auth) return
    send(res, 200, {
      ok: true,
      metrics: getMetrics(),
      recentAudit: readRecentAudit(30)
    })
    return
  }

  if (req.method === 'GET' && path === '/v1/jobs') {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const ownerFilter = auth.owner === 'anonymous' && config.allowAnonymous ? null : auth.owner
    send(res, 200, {
      ok: true,
      jobs: store.list(Number(url.searchParams.get('limit') || 50), ownerFilter)
    })
    return
  }

  const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/)
  if (req.method === 'GET' && jobMatch) {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const job = store.get(jobMatch[1]!)
    if (!job || !jobVisibleTo(job.ownerId, auth)) {
      send(res, 404, { ok: false, error: 'Job not found' })
      return
    }
    send(res, 200, { ok: true, job })
    return
  }

  const eventsMatch = path.match(/^\/v1\/jobs\/([^/]+)\/events$/)
  if (req.method === 'GET' && eventsMatch) {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const jobId = eventsMatch[1]!
    const job = store.get(jobId)
    if (!job || !jobVisibleTo(job.ownerId, auth)) {
      send(res, 404, { ok: false, error: 'Job not found' })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Request-Id': requestId
    })
    writeSse(res, 'job', job)

    const unsub = jobEvents.onJob(jobId, (updated) => {
      writeSse(res, 'job', updated)
      if (
        updated.status === 'done' ||
        updated.status === 'failed' ||
        updated.status === 'stopped'
      ) {
        writeSse(res, 'end', { status: updated.status })
        unsub()
        res.end()
      }
    })

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`)
      } catch {
        clearInterval(heartbeat)
      }
    }, 15_000)

    req.on('close', () => {
      clearInterval(heartbeat)
      unsub()
    })
    return
  }

  const artifactsMatch = path.match(/^\/v1\/jobs\/([^/]+)\/artifacts$/)
  if (req.method === 'GET' && artifactsMatch) {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const jobId = artifactsMatch[1]!
    const job = store.get(jobId)
    if (!job || !jobVisibleTo(job.ownerId, auth)) {
      send(res, 404, { ok: false, error: 'Job not found' })
      return
    }
    const pack = readJobArtifacts(jobId)
    if (!pack || pack.files.length === 0) {
      send(res, 404, {
        ok: false,
        error: 'No artifacts for this job yet (finish a job that writes files)',
        jobId,
        filesTouched: job.filesTouched
      })
      return
    }
    send(res, 200, { ok: true, ...pack })
    return
  }

  // Must be registered before /v1/jobs/:id/stop so "stop-all" is not treated as an id
  if (req.method === 'POST' && path === '/v1/jobs/stop-all') {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = workers.stopAll({ owner: auth.owner })
    send(res, 200, {
      ok: true,
      scope: 'owner',
      owner: auth.owner,
      count: result.count,
      stopped: result.stopped
    })
    return
  }

  if (req.method === 'POST' && (path === '/v1/admin/kill-all' || path === '/admin/kill-all')) {
    if (!adminKillConfigured()) {
      send(res, 503, {
        ok: false,
        error: 'Admin kill-all unavailable — could not create admin.token under data dir'
      })
      return
    }
    if (!verifyAdminToken(req)) {
      bumpMetric('authFailures')
      send(res, 401, { ok: false, error: 'Invalid or missing admin token' })
      return
    }
    const result = workers.stopAll()
    send(res, 200, {
      ok: true,
      scope: 'all',
      count: result.count,
      stopped: result.stopped
    })
    return
  }

  const stopMatch = path.match(/^\/v1\/jobs\/([^/]+)\/stop$/)
  if (req.method === 'POST' && stopMatch) {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const id = stopMatch[1]!
    const ok = workers.stop(id, auth)
    send(res, ok ? 200 : 404, { ok, job: store.get(id) })
    return
  }

  const continueMatch = path.match(/^\/v1\/jobs\/([^/]+)\/continue$/)
  if (req.method === 'POST' && continueMatch) {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const prevId = continueMatch[1]!
    const prev = store.get(prevId)
    if (!prev || !jobVisibleTo(prev.ownerId, auth)) {
      send(res, 404, { ok: false, error: 'Job not found' })
      return
    }
    try {
      const raw = await readBody(req)
      const body = (raw ? JSON.parse(raw) : {}) as Partial<CloudJobCreateRequest>
      const job = await workers.enqueue(
        {
          goal: body.goal || prev.goal,
          task: body.task ?? prev.task,
          agentId: body.agentId || prev.agentId,
          model: body.model || prev.model,
          repoUrl: body.repoUrl ?? prev.repoUrl,
          branch: body.branch ?? prev.branch,
          openPr: body.openPr ?? prev.openPr,
          githubToken: body.githubToken,
          files: body.files,
          claim: body.claim || `continue: ${prev.claim}`,
          resumeFromJobId: prevId,
          source: 'eris'
        },
        auth
      )
      send(res, 201, { ok: true, job })
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/jobs') {
    const auth = await requireAuth(req, res, { requireAuth: !config.allowAnonymous })
    if (!auth) return
    try {
      const raw = await readBody(req)
      const body = (raw ? JSON.parse(raw) : {}) as CloudJobCreateRequest
      const job = await workers.enqueue(body, auth)
      send(res, 201, { ok: true, job, requestId })
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        requestId
      })
    }
    return
  }

  send(res, 404, { ok: false, error: 'Not found' })
}

const admin = ensureAdminToken()
loadMetricsSnapshot()
warmLocalModel()
startFleetSync(store)
startStatusServer(store, {
  killAll: () => workers.stopAll()
})

const server = createServer((req, res) => {
  void handler(req, res).catch((err) => {
    audit('handler_error', {
      error: err instanceof Error ? err.message : String(err)
    })
    send(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  })
})

let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    workers.stopAll()
  } catch {
    /* ignore */
  }
  try {
    store.flush()
  } catch {
    /* ignore */
  }
  persistMetricsSnapshot()
  process.stdout.write(`${JSON.stringify({ msg: 'eris-cloud-agent shutting down', signal })}\n`)
  server.close(() => {
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 15_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(config.port, config.host, () => {
  const local = getLocalModelStatus()
  process.stdout.write(
    `${JSON.stringify({
      msg: 'eris-cloud-agent listening',
      host: config.host,
      port: config.port,
      warmOnStart: config.warmOnStart,
      maxThreads: config.maxThreads,
      contextSize: config.contextSize,
      statusPort: config.statusPort,
      statusEnabled: config.statusEnabled,
      publicBaseUrl: config.publicBaseUrl,
      clientDefault: PUBLIC_BASE_URL,
      inference: config.llmBase ? 'remote' : 'local',
      localModel: local.status,
      model: local.modelName,
      authRequired: !config.allowAnonymous,
      version: config.version,
      adminKillAll: adminKillConfigured(),
      adminTokenSource: getAdminTokenSource(),
      adminTokenFile: getAdminTokenSource() === 'file' ? adminTokenFilePath() : undefined,
      statusUrls: [
        `http://0.0.0.0:${config.port}/status`,
        config.statusEnabled ? `http://0.0.0.0:${config.statusPort}/` : null
      ].filter(Boolean)
    })}\n`
  )
  if (admin.source === 'file') {
    process.stdout.write(
      `${JSON.stringify({
        msg: 'eris-cloud-agent admin token for Force kill all (status page)',
        hint: 'Read token from data volume, then paste into status page Force kill all',
        path: adminTokenFilePath(),
        example: `podman exec eris-cloud-agent cat ${adminTokenFilePath()}`
      })}\n`
    )
  }
})
