import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { AppSettings } from '../../../src/shared/settings-schema'

export type CommandApprovalKind = 'run' | 'push' | 'mcp'
export type CommandApprovalDecision = 'allow' | 'always' | 'deny'

export interface CommandApprovalRequest {
  requestId: string
  approvalId: string
  kind: CommandApprovalKind
  command: string
  toolName?: string
  canAlwaysAllow?: boolean
}

/** Any of these means the shell may chain, redirect, or substitute — never auto-allow. */
const SHELL_META = /[;&|`$<>\n\r(){}\\]|\bsudo\b/

const SAFE_PATTERNS: RegExp[] = [
  /^(?:ls|pwd|cat|head|tail|wc|which|echo|tree|file|stat|du|df)(?:\s|$)/,
  /^git\s+(?:status|diff|log|show|branch|remote\s+-v|rev-parse|ls-files)(?:\s|$)/,
  /^(?:npm|pnpm|yarn)\s+(?:test|t|ls|list|outdated|why|-v|--version)(?:\s|$)/,
  /^(?:npm|pnpm)\s+run\s+(?:test|lint|typecheck|type-check|check|build|format:check)(?::[\w-]+)?(?:\s|$)/,
  /^yarn\s+(?:lint|typecheck|build)(?:\s|$)/,
  /^npx\s+(?:tsc|vitest\s+run|jest|eslint|prettier\s+--check)(?:\s|$)/,
  /^(?:node|python3?|go|cargo|rustc|tsc)\s+(?:-v|--version)$/,
  /^(?:pytest|python3?\s+-m\s+pytest|go\s+test|go\s+vet|go\s+build|cargo\s+(?:test|check|build|clippy))(?:\s|$)/
]

const VERIFY_PATTERNS: RegExp[] = [
  /^(?:npm|pnpm|yarn)\s+(?:test|t)(?:\s|$)/,
  /^(?:npm|pnpm)\s+run\s+(?:test|lint|typecheck|type-check|check)(?::[\w.-]+)?(?:\s|$)/,
  /^yarn\s+(?:test|lint|typecheck|type-check)(?:\s|$)/,
  /^npx\s+(?:tsc|vitest\s+run|jest|eslint)(?:\s|$)/,
  /^(?:pytest|python3?\s+-m\s+pytest|go\s+test|go\s+vet|cargo\s+(?:test|check|clippy)|tsc)(?:\s|$)/
]

/** Read-only agents may run tests, typecheck, or lint, and nothing else. */
export function isVerifyCommand(command: string): boolean {
  const cmd = command.trim()
  if (!cmd || SHELL_META.test(cmd)) return false
  return VERIFY_PATTERNS.some((re) => re.test(cmd))
}

/** Read-only / test / build commands without shell metacharacters run without a prompt. */
export function isSafeCommand(command: string): boolean {
  const cmd = command.trim()
  if (!cmd || SHELL_META.test(cmd)) return false
  return SAFE_PATTERNS.some((re) => re.test(cmd))
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/** Compact approval preview with values under common credential keys redacted. */
export function formatMcpApprovalPreview(args: Record<string, unknown>): string {
  const sensitiveKey = /token|secret|password|api[-_]?key|authorization|credential/i
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(child)])
    )
  }
  try {
    return JSON.stringify(redact(args), null, 2).slice(0, 6_000)
  } catch {
    return '(arguments could not be rendered)'
  }
}

export function commandNeedsApproval(
  settings: AppSettings | undefined,
  kind: CommandApprovalKind,
  command: string,
  workspaceAllowed: string[] = []
): boolean {
  if (!settings || settings.agent.commandApproval === 'auto') return false
  const norm = normalizeCommand(command)
  const allowed = [...settings.agent.allowedCommands, ...workspaceAllowed]
  if (allowed.some((c) => normalizeCommand(c) === norm)) return false
  if (kind === 'run' && isSafeCommand(norm)) return false
  return true
}

const pending = new Map<
  string,
  { requestId: string; done: (decision: CommandApprovalDecision) => void }
>()

/** Ask the renderer to approve a command; resolves deny on abort. */
export function requestCommandApproval(
  sender: WebContents,
  requestId: string,
  kind: CommandApprovalKind,
  command: string,
  signal?: AbortSignal,
  metadata: { toolName?: string; canAlwaysAllow?: boolean } = {}
): Promise<CommandApprovalDecision> {
  const approvalId = randomUUID()
  return new Promise((resolve) => {
    const done = (decision: CommandApprovalDecision) => {
      if (!pending.has(approvalId)) return
      pending.delete(approvalId)
      signal?.removeEventListener('abort', onAbort)
      if (!sender.isDestroyed()) {
        sender.send('chat:approval-resolved', { requestId, approvalId, decision })
      }
      resolve(decision)
    }
    const onAbort = () => done('deny')
    pending.set(approvalId, { requestId, done })
    if (signal?.aborted) {
      done('deny')
      return
    }
    signal?.addEventListener('abort', onAbort)
    if (sender.isDestroyed()) {
      done('deny')
      return
    }
    const req: CommandApprovalRequest = {
      requestId,
      approvalId,
      kind,
      command,
      ...metadata
    }
    sender.send('chat:approval-request', req)
  })
}

export function resolveCommandApproval(
  approvalId: string,
  decision: CommandApprovalDecision
): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  entry.done(decision)
  return true
}

/** Deny pending prompts — all of them, or only those raised by one chat / background run. */
export function denyAllPendingApprovals(requestId?: string): void {
  for (const entry of [...pending.values()]) {
    if (requestId === undefined || entry.requestId === requestId) entry.done('deny')
  }
}
