import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { config } from './config.js'
import type { JobStore } from './job-store.js'
import { buildPublicStatus, statusPageHtml } from './status-page.js'
import { getMetrics } from './observe.js'
import { adminKillConfigured, verifyAdminToken } from './admin.js'

export type StatusServerHooks = {
  killAll: () => { stopped: string[]; count: number }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  })
  res.end(json)
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(html)
}

/**
 * Status UI + JSON on ERIS_CLOUD_STATUS_PORT (host maps 80 → this port).
 * GET is public. POST /admin/kill-all requires ERIS_CLOUD_ADMIN_TOKEN.
 */
export function startStatusServer(store: JobStore, hooks: StatusServerHooks): void {
  if (!config.statusEnabled) {
    process.stdout.write(
      `${JSON.stringify({ msg: 'eris-cloud-agent status page disabled', statusEnabled: false })}\n`
    )
    return
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Authorization, X-Eris-Admin-Token, Content-Type'
      })
      res.end()
      return
    }

    if (req.method === 'POST' && (path === '/admin/kill-all' || path === '/v1/admin/kill-all')) {
      if (!adminKillConfigured()) {
        sendJson(res, 503, {
          ok: false,
          error: 'Admin kill-all disabled — set ERIS_CLOUD_ADMIN_TOKEN on the worker'
        })
        return
      }
      if (!verifyAdminToken(req)) {
        sendJson(res, 401, { ok: false, error: 'Invalid or missing admin token' })
        return
      }
      const result = hooks.killAll()
      sendJson(res, 200, {
        ok: true,
        scope: 'all',
        count: result.count,
        stopped: result.stopped
      })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' })
      return
    }

    if (path === '/' || path === '/status' || path === '/index.html') {
      sendHtml(res, statusPageHtml())
      return
    }

    if (path === '/status.json' || path === '/api/status' || path === '/v1/status') {
      sendJson(res, 200, buildPublicStatus(store))
      return
    }

    if (path === '/metrics' || path === '/v1/metrics-public') {
      sendJson(res, 200, {
        ok: true,
        metrics: getMetrics(),
        jobs: store.counts(),
        generatedAt: new Date().toISOString()
      })
      return
    }

    if (path === '/health' || path === '/v1/health') {
      const status = buildPublicStatus(store)
      sendJson(res, 200, {
        ok: true,
        ready: status.ready,
        version: status.version,
        gpuMode: status.gpuMode,
        localModel: status.localModel,
        jobs: status.jobs,
        adminKillAllConfigured: adminKillConfigured()
      })
      return
    }

    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      endpoints: ['/', '/status.json', '/metrics', '/health', 'POST /admin/kill-all']
    })
  })

  server.listen(config.statusPort, config.host, () => {
    process.stdout.write(
      `${JSON.stringify({
        msg: 'eris-cloud-agent status page listening',
        host: config.host,
        port: config.statusPort,
        paths: ['/', '/status.json', '/metrics', '/health', 'POST /admin/kill-all'],
        adminKillAll: adminKillConfigured()
      })}\n`
    )
  })

  server.on('error', (err) => {
    process.stdout.write(
      `${JSON.stringify({
        msg: 'eris-cloud-agent status page failed to bind',
        port: config.statusPort,
        error: err instanceof Error ? err.message : String(err)
      })}\n`
    )
  })
}
