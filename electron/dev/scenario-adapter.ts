import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync
} from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname, isAbsolute } from 'path'
import { randomUUID, createHash } from 'crypto'
import * as capture from './capture'
import { prepareLiveModel } from './models'
import { CaptureSanitizer } from './sanitize'
import { completeChatTurnTask } from '../main/services/chat-turn'
import type { ScenarioAdapter, ScenarioResult } from '../../src/shared/quality-scenarios'
/** A session owns one disposable workspace across all turns. It never accepts a user's writable project. */
export function productionScenarioAdapter(
  context: number,
  dependencies = {
    capture: capture.captureQuestion,
    prepare: prepareLiveModel,
    boundedOutput: 'CAPTURE_OUTPUT_LIMIT_VERSION' in capture
  }
): ScenarioAdapter {
  return {
    kind: 'live',
    callsPerTurn: 6,
    async start({ family, model, signal }) {
      if (signal.aborted) throw new Error('Cancelled before scenario setup')
      const directory = mkdtempSync(join(tmpdir(), 'eris-scenario-'))
      const workspace = family.fixture ? join(directory, 'fixture') : null
      const threadId = `scenario-${randomUUID()}`
      const sanitizer = new CaptureSanitizer({
        homeDir: homedir(),
        workspaceRoots: workspace ? [workspace] : [],
        tmpRoots: [directory]
      })
      try {
        if (workspace) {
          mkdirSync(workspace)
          let bytes = 0
          for (const [path, value] of Object.entries(family.fixture!)) {
            if (
              isAbsolute(path) ||
              /^[a-z]:/i.test(path) ||
              !path
                .split(/[\\/]/)
                .every(
                  (p) => p && !['..', '.', '.git', '.eris', '.ericservices-ide'].includes(p)
                ) ||
              typeof value !== 'string'
            )
              throw new Error('Invalid scenario fixture')
            bytes += Buffer.byteLength(value)
            if (bytes > 2_000_000) throw new Error('Scenario fixture exceeds 2 MB')
            const destination = join(workspace, path)
            mkdirSync(dirname(destination), { recursive: true })
            writeFileSync(destination, value, { flag: 'wx' })
          }
        }
      } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
      }
      let inFlight: Promise<import('../../src/shared/eris-dev').DevResult> | undefined
      let live: Awaited<ReturnType<typeof prepareLiveModel>> | undefined
      let previousTask: import('../../src/shared/task-contract').TaskContract | null = null
      function files(): Record<string, string> {
        const output: Record<string, string> = {}
        let bytes = 0,
          count = 0
        function visit(path: string, relative: string) {
          for (const item of readdirSync(path, { withFileTypes: true })) {
            if (['.eris', '.ericservices-ide', '.git', 'node_modules'].includes(item.name)) continue
            if (++count > 200 || item.isSymbolicLink())
              throw new Error('Scenario artifact inventory exceeds bounds or contains links')
            const target = join(path, item.name),
              name = relative ? `${relative}/${item.name}` : item.name
            if (item.isDirectory()) visit(target, name)
            else if (item.isFile()) {
              bytes += lstatSync(target).size
              if (bytes > 2_000_000) throw new Error('Scenario artifacts exceed 2 MB')
              output[name] = readFileSync(target, 'utf8')
            }
          }
        }
        if (workspace) visit(workspace, '')
        return output
      }
      return {
        async turn({
          turn,
          index,
          history,
          maxCalls,
          maxOutputTokens,
          signal
        }): Promise<ScenarioResult> {
          const baseline = files()
          // REC-27 provides the native/API enforced output cap. Refuse unbounded inference on older builds.
          if (!dependencies.boundedOutput || family.fault === 'cold-load')
            return {
              answer: '',
              completion: 'not-exercised',
              calls: 0,
              files: baseline,
              execution: { state: 'none' },
              faultEvidence: {
                injected: false,
                reason: !dependencies.boundedOutput
                  ? 'Requires REC-27 bounded transport adapter'
                  : 'Cold model eviction is not supported; no cold-load claim'
              }
            }
          if (signal.aborted) throw new Error('Cancelled before provider setup')
          live ??= await dependencies.prepare(model, context)
          const cap = Math.floor(maxOutputTokens / maxCalls)
          if (cap < 1) throw new Error('Insufficient reserved output')
          const options = {
            live,
            maxCalls,
            maxOutputTokens: cap,
            threadId,
            priorTask: previousTask,
            ...(family.fault === 'provider-error' || family.fault === 'cancelled'
              ? { fault: family.fault as 'provider-error' | 'cancelled' }
              : {}),
            question: { id: `${family.id}:${turn.id}`, history }
          }
          inFlight = dependencies.capture(
            index,
            turn.prompt,
            workspace,
            context,
            'agent',
            signal,
            options
          )
          const result = await inFlight.finally(() => {
            inFlight = undefined
          })
          const after = files(),
            changed = [...new Set([...Object.keys(baseline), ...Object.keys(after)])].filter(
              (p) => baseline[p] !== after[p]
            )
          const capturedTask = result.task as
            import('../../src/shared/task-contract').TaskContract | undefined
          const task = capturedTask
            ? completeChatTurnTask(capturedTask, {
                answer: result.response ?? '',
                changedFiles: changed,
                terminal: result.completion?.status === 'completed' ? 'complete' : 'incomplete'
              })
            : undefined
          previousTask = task ?? null
          const output: ScenarioResult = {
            answer: result.response ?? '',
            completion:
              result.completion?.status === 'completed'
                ? 'complete'
                : (result.termination?.cause ?? 'incomplete'),
            files: after,
            task,
            calls: result.inference?.calls ?? 0,
            route: result.routeDecision,
            applicability: capturedTask?.scope.applicability,
            execution: {
              state: 'blocked',
              reason: 'Diagnostic host-command boundary; no generated commands executed'
            },
            elapsedMs: result.durationMs,
            firstTokenMs: result.inference?.firstTokenMs ?? null,
            coldLoadMs: null,
            outputTokens: null,
            faultEvidence: {
              requested: family.fault ?? null,
              injected: result.events.some((e) => e.startsWith('Injected ')),
              termination: result.termination
            },
            effectiveSettings: {
              settingsDigest: live.digest,
              fixtureDigest: createHash('sha256')
                .update(JSON.stringify(family.fixture))
                .digest('hex'),
              context,
              model,
              perCallOutputTokens: cap
            },
            requests: result.requests,
            events: result.events
          }
          let encoded = JSON.stringify(sanitizer.value(output))
          for (const connection of live.settings.models.connections) {
            const secret = connection.apiKeyRef ? live.getSecret(connection.apiKeyRef) : null
            if (secret && secret.length > 3)
              encoded = encoded.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]')
          }
          return JSON.parse(encoded) as ScenarioResult
        },
        async close() {
          if (inFlight) {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                inFlight.catch(() => undefined),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new Error(
                          'Cancelled capture did not settle; isolated fixture retained for recovery'
                        )
                      ),
                    5000
                  )
                })
              ])
            } finally {
              clearTimeout(timer)
            }
          }
          rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
      }
    }
  }
}
