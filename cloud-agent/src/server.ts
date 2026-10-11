import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { config, llmConfigured, PUBLIC_BASE_URL } from './config.js'
import { JobStore } from './job-store.js'
import { WorkerPool } from './worker.js'
import { getLocalModelStatus, warmLocalModel } from './local-model.js'
import type { CloudJobCreateRequest, CloudHealth } from './types.js'

const store = new JobStore()
const workers = new WorkerPool(store)

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Eris-Client',
    'Cache-Control': 'no-store'
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

function healthBody(): Record<string, unknown> {
  const counts = store.counts()
  const local = getLocalModelStatus()
  const health: CloudHealth = {
    ok: true,
    service: 'eris-cloud-agent',
    version: config.version,
    llmConfigured: llmConfigured(),
    localModel: {
      status: local.status,
      modelId: local.modelId,
      modelName: local.modelName,
      error: local.error
    },
    inference: config.llmBase ? 'remote' : 'local',
    maxParallel: config.maxParallel,
    running: counts.running,
    queued: counts.queued
  }
  return {
    ...health,
    publicBaseUrl: config.publicBaseUrl,
    defaultClientUrl: PUBLIC_BASE_URL,
    endpoints: {
      health: '/v1/health',
      jobs: '/v1/jobs',
      job: '/v1/jobs/:id',
      stop: '/v1/jobs/:id/stop'
    }
  }
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }

  if (req.method === 'GET' && (path === '/' || path === '/v1' || path === '/v1/health')) {
    send(res, 200, healthBody())
    return
  }

  if (req.method === 'GET' && path === '/v1/jobs') {
    send(res, 200, { ok: true, jobs: store.list(Number(url.searchParams.get('limit') || 50)) })
    return
  }

  const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/)
  if (req.method === 'GET' && jobMatch) {
    const job = store.get(jobMatch[1]!)
    if (!job) {
      send(res, 404, { ok: false, error: 'Job not found' })
      return
    }
    send(res, 200, { ok: true, job })
    return
  }

  const stopMatch = path.match(/^\/v1\/jobs\/([^/]+)\/stop$/)
  if (req.method === 'POST' && stopMatch) {
    const ok = workers.stop(stopMatch[1]!)
    send(res, ok ? 200 : 404, { ok, job: store.get(stopMatch[1]!) })
    return
  }

  if (req.method === 'POST' && path === '/v1/jobs') {
    try {
      const raw = await readBody(req)
      const body = (raw ? JSON.parse(raw) : {}) as CloudJobCreateRequest
      const job = workers.enqueue(body)
      send(res, 201, { ok: true, job })
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  send(res, 404, { ok: false, error: 'Not found' })
}

warmLocalModel()

const server = createServer((req, res) => {
  void handler(req, res).catch((err) => {
    send(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  })
})

server.listen(config.port, config.host, () => {
  const local = getLocalModelStatus()
  process.stdout.write(
    `${JSON.stringify({
      msg: 'eris-cloud-agent listening',
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      clientDefault: PUBLIC_BASE_URL,
      inference: config.llmBase ? 'remote' : 'local',
      localModel: local.status,
      model: local.modelName
    })}\n`
  )
})
