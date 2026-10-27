import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { captureQuestion } from './capture'
import { prepareLiveModel } from './models'
import { CaptureSanitizer } from './sanitize'
import type { QualityAdapter, QualityResult } from '../../src/shared/quality'
export const QUALITY_ADAPTER_VERSION = 'eris-production-diagnostics-1'
/** Maintained adapter: fixture files and production intake/transport/tool path, never a separate prompt implementation. */
export function productionQualityAdapter(
  context: number,
  dependencies = { capture: captureQuestion, prepare: prepareLiveModel }
): QualityAdapter {
  return {
    kind: 'live',
    callsPerInvocation: 6,
    async run({ test, model, maxCalls, maxOutputTokens, signal }): Promise<QualityResult> {
      if (signal.aborted) throw new Error('Quality case cancelled before setup')
      if (
        !Number.isSafeInteger(maxCalls) ||
        maxCalls < 1 ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 128
      )
        throw new Error('Explicit quality reservation required')
      if (test.fault)
        return {
          answer: '',
          completion: 'not-exercised',
          calls: 0,
          effectiveSettings: { adapter: QUALITY_ADAPTER_VERSION, context, model },
          observed: {
            reason: 'This adapter does not inject ' + test.fault,
            execution: 'not-exercised'
          }
        }
      const directory = mkdtempSync(join(tmpdir(), 'eris-quality-'))
      const workspace = test.project ? join(directory, 'fixture') : null
      try {
        if (workspace) {
          mkdirSync(workspace)
          let bytes = 0
          for (const [path, content] of Object.entries(test.project!)) {
            if (
              !path ||
              isAbsolute(path) ||
              /^[a-z]:/i.test(path) ||
              path.split(/[\\/]/).some((p) => p === '..' || p === '.git' || p === '.eris') ||
              typeof content !== 'string'
            )
              throw new Error('Invalid quality fixture path/content')
            bytes += Buffer.byteLength(content)
            if (bytes > 2_000_000) throw new Error('Quality fixture exceeds 2 MB')
            const target = join(workspace, path)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, content, { flag: 'wx' })
          }
        }
        const live = await dependencies.prepare(model, context)
        const cap = Math.max(1, Math.floor(maxOutputTokens / maxCalls))
        const result = await dependencies.capture(
          0,
          test.prompt,
          workspace,
          context,
          'agent',
          signal,
          { live, maxCalls, maxOutputTokens: cap, question: { id: test.id, history: test.history } }
        )
        const sanitizer = new CaptureSanitizer({
          homeDir: homedir(),
          workspaceRoots: workspace ? [workspace] : [],
          tmpRoots: [directory]
        })
        const knownSecrets = live.settings.models.connections.flatMap((c) => {
          const value = c.apiKeyRef ? live.getSecret(c.apiKeyRef) : null
          return value ? [value] : []
        })
        const files: Record<string, string> = {}
        if (workspace)
          for (const path of Object.keys(test.project!)) {
            try {
              files[path] = readFileSync(join(workspace, path), 'utf8')
            } catch {
              /* missing files remain absent evidence */
            }
          }
        const output: QualityResult = {
          answer: result.response ?? '',
          completion:
            result.completion?.status === 'completed'
              ? 'complete'
              : (result.completion?.status ?? 'incomplete'),
          calls: result.inference?.calls ?? 0,
          effectiveSettings: {
            adapter: QUALITY_ADAPTER_VERSION,
            model,
            context,
            temperature: live.settings.models.temperature,
            settingsDigest: live.digest,
            fixtureDigest: createHash('sha256').update(JSON.stringify(test.project)).digest('hex'),
            maxCalls,
            perCallOutputTokens: cap
          },
          observed: {
            task: result.task,
            route: result.routeDecision,
            requests: result.requests,
            events: result.events,
            termination: result.termination?.cause,
            files,
            execution: 'diagnostics; host effects remain blocked',
            deliverable: result.deliverable
          }
        }
        // No settings/credential object is exported. Scrub exact active secret values as well as field/pattern redaction.
        let encoded = JSON.stringify(sanitizer.value(output))
        for (const secret of knownSecrets)
          if (secret.length > 3)
            encoded = encoded.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]')
        return JSON.parse(encoded) as QualityResult
      } catch (error) {
        throw new Error(
          signal.aborted
            ? 'Quality case cancelled'
            : 'Quality adapter setup/runtime failed; inspect model availability and diagnostic evidence',
          { cause: error }
        )
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  }
}
