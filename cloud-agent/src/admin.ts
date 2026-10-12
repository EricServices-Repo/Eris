import { randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { IncomingMessage } from 'http'
import { config } from './config.js'

let resolvedAdminToken = ''
let adminTokenSource: 'env' | 'file' | 'none' = 'none'

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

function adminTokenPath(): string {
  return join(config.dataDir, 'admin.token')
}

/**
 * Resolve admin token for force-kill-all:
 * 1) ERIS_CLOUD_ADMIN_TOKEN env
 * 2) else persist/load `$ERIS_CLOUD_DATA/admin.token` (auto-created)
 */
export function ensureAdminToken(): { token: string; source: 'env' | 'file' | 'none' } {
  const fromEnv = config.adminToken
  if (fromEnv) {
    resolvedAdminToken = fromEnv
    adminTokenSource = 'env'
    return { token: resolvedAdminToken, source: 'env' }
  }

  try {
    mkdirSync(config.dataDir, { recursive: true })
    const path = adminTokenPath()
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (existing.length >= 16) {
        resolvedAdminToken = existing
        adminTokenSource = 'file'
        return { token: resolvedAdminToken, source: 'file' }
      }
    }
    const created = randomBytes(24).toString('base64url')
    writeFileSync(path, `${created}\n`, { encoding: 'utf8', mode: 0o600 })
    resolvedAdminToken = created
    adminTokenSource = 'file'
    return { token: resolvedAdminToken, source: 'file' }
  } catch {
    resolvedAdminToken = ''
    adminTokenSource = 'none'
    return { token: '', source: 'none' }
  }
}

export function getAdminTokenSource(): 'env' | 'file' | 'none' {
  return adminTokenSource
}

export function adminTokenFilePath(): string {
  return adminTokenPath()
}

/** Extract admin token from Authorization Bearer or X-Eris-Admin-Token. */
export function extractAdminToken(req: IncomingMessage): string {
  const header = (req.headers['x-eris-admin-token'] || '').toString().trim()
  if (header) return header
  const auth = (req.headers.authorization || '').trim()
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  return m?.[1]?.trim() || ''
}

export function adminKillConfigured(): boolean {
  return Boolean(resolvedAdminToken || config.adminToken)
}

export function verifyAdminToken(req: IncomingMessage): boolean {
  const expected = resolvedAdminToken || config.adminToken
  if (!expected) return false
  const provided = extractAdminToken(req)
  if (!provided) return false
  return safeEqual(provided, expected)
}
