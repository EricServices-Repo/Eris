/** Dedicated development Electron entry, no renderer or production IPC surface. */
import { app } from 'electron'
import { z } from 'zod'
import pack from '../../checks/quality/scenarios.json'
import { runScenarios } from '../../checks/quality/scenarios.mjs'
import { productionScenarioAdapter } from './scenario-adapter'
import { disposeRuntime } from '../main/services/builtin-model'
import { disposeWorkspaceWorkers } from '../main/services/workspace-worker-client'
const Input = z
  .object({
    live: z.literal(true),
    models: z.array(z.string().min(1).max(2048)).min(1).max(8),
    context: z.number().int().min(1024).max(131072).default(8192),
    repeats: z.number().int().min(1).max(10).default(2),
    maxCalls: z.number().int().min(1).max(10000),
    maxOutputTokens: z.number().int().min(128).max(10_000_000),
    seed: z.string().max(128).default('eris-1'),
    split: z.enum(['development', 'heldout']).default('heldout'),
    timeoutMs: z.number().int().min(100).max(180000).default(90000),
    adjudications: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
declare const __ERIS_DEV_BUILD__:
  { gitSha: string; dirty: boolean | null; dirtyDigest: string | null; buildId: string } | undefined
app.setName('Eris-Dev')
void app.whenReady().then(async () => {
  let input = ''
  try {
    for await (const part of process.stdin) {
      input += String(part)
      if (Buffer.byteLength(input) > 1_000_000) throw new Error('Scenario request exceeds 1 MB')
    }
    const options = Input.parse(JSON.parse(input)),
      controller = new AbortController()
    process.once('SIGTERM', () => controller.abort('shutdown'))
    process.once('SIGINT', () => controller.abort('cancelled'))
    const report = await runScenarios({
      ...options,
      pack: pack as import('../../src/shared/quality-scenarios').ScenarioOptions['pack'],
      adapter: productionScenarioAdapter(options.context),
      signal: controller.signal
    })
    process.stdout.write(
      'ERIS_SCENARIO_RESULT ' +
        JSON.stringify({
          ...report,
          createdAt: new Date().toISOString(),
          provenance: {
            ...(typeof __ERIS_DEV_BUILD__ !== 'undefined'
              ? __ERIS_DEV_BUILD__
              : { gitSha: 'unknown' }),
            platform: process.platform,
            arch: process.arch,
            appVersion: app.getVersion()
          }
        }) +
        '\n'
    )
  } catch {
    process.stdout.write(
      'ERIS_SCENARIO_ERROR Invalid scenario request or runtime failure; inspect model availability and bounded input.\n'
    )
    process.exitCode = 1
  } finally {
    await disposeRuntime()
    await disposeWorkspaceWorkers()
    app.exit(Number(process.exitCode ?? 0))
  }
})
