import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import type { CloudJobCreateRequest } from './types.js'
import type { ChatMessage } from './llm.js'

function secretsDir(): string {
  return join(config.dataDir, 'job-secrets')
}

function seedPath(jobId: string): string {
  return join(secretsDir(), `${jobId}.seed.json`)
}

function tokenPath(jobId: string): string {
  return join(secretsDir(), `${jobId}.token`)
}

function checkpointPath(jobId: string): string {
  return join(secretsDir(), `${jobId}.checkpoint.json`)
}

export function saveJobSeed(jobId: string, files: CloudJobCreateRequest['files']): void {
  if (!files?.length) return
  mkdirSync(secretsDir(), { recursive: true })
  writeFileSync(seedPath(jobId), JSON.stringify({ files }, null, 2), 'utf8')
}

export function loadJobSeed(jobId: string): CloudJobCreateRequest['files'] | undefined {
  try {
    if (!existsSync(seedPath(jobId))) return undefined
    const raw = JSON.parse(readFileSync(seedPath(jobId), 'utf8')) as {
      files?: CloudJobCreateRequest['files']
    }
    return raw.files
  } catch {
    return undefined
  }
}

export function saveJobGithubToken(jobId: string, token: string | null | undefined): void {
  if (!token?.trim()) return
  mkdirSync(secretsDir(), { recursive: true })
  writeFileSync(tokenPath(jobId), token.trim(), { mode: 0o600 })
}

export function loadJobGithubToken(jobId: string): string | null {
  try {
    if (!existsSync(tokenPath(jobId))) return null
    return readFileSync(tokenPath(jobId), 'utf8').trim() || null
  } catch {
    return null
  }
}

export function saveCheckpoint(
  jobId: string,
  payload: { step: number; messages: ChatMessage[]; workspaceReady: boolean }
): void {
  mkdirSync(secretsDir(), { recursive: true })
  writeFileSync(checkpointPath(jobId), JSON.stringify(payload), 'utf8')
}

export function loadCheckpoint(
  jobId: string
): { step: number; messages: ChatMessage[]; workspaceReady: boolean } | null {
  try {
    if (!existsSync(checkpointPath(jobId))) return null
    return JSON.parse(readFileSync(checkpointPath(jobId), 'utf8')) as {
      step: number
      messages: ChatMessage[]
      workspaceReady: boolean
    }
  } catch {
    return null
  }
}

export function clearJobSecrets(jobId: string): void {
  for (const p of [seedPath(jobId), tokenPath(jobId), checkpointPath(jobId)]) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      // ignore
    }
  }
}
