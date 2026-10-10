import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { userDataRoot } from './paths'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

interface LoggerState {
  enabled: boolean
  directory: string
  level: LogLevel
}

let state: LoggerState = {
  enabled: true,
  directory: '',
  level: 'info'
}

export function defaultLogsDir(): string {
  return join(userDataRoot(), 'logs')
}

export function resolveLogsDir(directory?: string | null): string {
  const trimmed = (directory ?? '').trim()
  return trimmed || defaultLogsDir()
}

function todayFileName(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `eris-${y}-${m}-${day}.log`
}

export function currentLogFilePath(): string {
  return join(resolveLogsDir(state.directory), todayFileName())
}

export function configureLogger(settings: AppSettings): void {
  state = {
    enabled: settings.general.logging.enabled,
    directory: settings.general.logging.directory,
    level: settings.general.logging.level
  }
  try {
    mkdirSync(resolveLogsDir(state.directory), { recursive: true })
  } catch {
    // ignore
  }
}

function shouldWrite(level: LogLevel): boolean {
  if (!state.enabled) return false
  return LEVEL_ORDER[level] >= LEVEL_ORDER[state.level]
}

export function log(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldWrite(level)) return
  const dir = resolveLogsDir(state.directory)
  try {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString()
    let line = `${stamp} [${level.toUpperCase()}] ${message}`
    if (meta !== undefined) {
      try {
        line += ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`
      } catch {
        line += ' [unserializable meta]'
      }
    }
    appendFileSync(join(dir, todayFileName()), `${line}\n`, 'utf8')
  } catch {
    // never throw from logger
  }
}

export const logInfo = (message: string, meta?: unknown) => log('info', message, meta)
export const logWarn = (message: string, meta?: unknown) => log('warn', message, meta)
export const logError = (message: string, meta?: unknown) => log('error', message, meta)
export const logDebug = (message: string, meta?: unknown) => log('debug', message, meta)

export interface LogsInfo {
  enabled: boolean
  level: LogLevel
  directory: string
  defaultDirectory: string
  currentFile: string
  files: Array<{ name: string; path: string; size: number; mtime: number }>
}

export function getLogsInfo(): LogsInfo {
  const directory = resolveLogsDir(state.directory)
  mkdirSync(directory, { recursive: true })
  const files: LogsInfo['files'] = []
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.log')) continue
      const path = join(directory, name)
      try {
        const st = statSync(path)
        if (!st.isFile()) continue
        files.push({ name, path, size: st.size, mtime: st.mtimeMs })
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return {
    enabled: state.enabled,
    level: state.level,
    directory,
    defaultDirectory: defaultLogsDir(),
    currentFile: currentLogFilePath(),
    files
  }
}

export function readLogFile(options?: {
  fileName?: string
  maxBytes?: number
}): { path: string; content: string; truncated: boolean } {
  const info = getLogsInfo()
  const target =
    (options?.fileName
      ? info.files.find((f) => f.name === options.fileName)?.path
      : null) ||
    info.currentFile ||
    info.files[0]?.path

  if (!target || !existsSync(target)) {
    return { path: target || info.currentFile, content: '', truncated: false }
  }

  const maxBytes = options?.maxBytes ?? 256_000
  const buf = readFileSync(target)
  if (buf.length <= maxBytes) {
    return { path: target, content: buf.toString('utf8'), truncated: false }
  }
  const slice = buf.subarray(buf.length - maxBytes)
  const text = slice.toString('utf8')
  const firstNl = text.indexOf('\n')
  return {
    path: target,
    content: (firstNl >= 0 ? text.slice(firstNl + 1) : text),
    truncated: true
  }
}

export function clearLogs(): { cleared: number } {
  const info = getLogsInfo()
  let cleared = 0
  for (const file of info.files) {
    try {
      unlinkSync(file.path)
      cleared++
    } catch {
      // skip
    }
  }
  // Recreate today's empty file so the path stays valid
  try {
    writeFileSync(currentLogFilePath(), '', 'utf8')
  } catch {
    // ignore
  }
  return { cleared }
}

export async function openLogsDirectory(): Promise<string> {
  const dir = resolveLogsDir(state.directory)
  mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
  return dir
}
