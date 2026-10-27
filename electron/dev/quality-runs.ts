import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { runQuality, adjudicateReport, digest } from '../../checks/quality/runtime.mjs'
import suite from '../../checks/quality/cases.json'
import type {
  QualityInput,
  QualityPack,
  QualityReport,
  QualitySummary
} from '../../src/shared/quality'
import { productionQualityAdapter } from './quality-adapter'
export const QualityInputSchema = z
  .object({
    models: z.array(z.string().min(1).max(2048)).min(1).max(8),
    context: z.number().int().min(512).max(128000),
    repeats: z.number().int().min(1).max(10),
    maxCalls: z.number().int().min(1).max(2000),
    maxOutputTokens: z.number().int().min(128).max(2000000),
    live: z.literal(true)
  })
  .strict()
interface Bundle {
  version: 1
  pack: QualityPack
  report: QualityReport
}
function save(directory: string, bundle: Bundle): QualitySummary {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, randomUUID() + '.json'),
    temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify(bundle, null, 2), { flag: 'wx', mode: 0o600 })
  renameSync(temp, path)
  return qualitySummary(path, bundle.report)
}
export function qualitySummary(path: string, report: QualityReport): QualitySummary {
  return {
    path,
    observed: report.rows.filter((r) => r.status === 'observed').length,
    unresolved: report.rows.filter((r) => r.correctness?.state === 'unresolved').length,
    skipped: report.rows.filter((r) => r.status === 'budget-skipped').length
  }
}
export async function runProductionQuality(
  raw: QualityInput,
  directory: string,
  signal: AbortSignal
): Promise<QualitySummary> {
  const input = QualityInputSchema.parse(raw)
  const adapter = productionQualityAdapter(input.context)
  const report = await runQuality({
    ...input,
    pack: suite as QualityPack,
    adapter: {
      ...adapter,
      run: async (request) => {
        if (signal.aborted) throw new Error('Quality suite cancelled')
        const controller = new AbortController()
        const cancel = () => controller.abort()
        signal.addEventListener('abort', cancel, { once: true })
        request.signal.addEventListener('abort', cancel, { once: true })
        try {
          if (signal.aborted || request.signal.aborted) controller.abort()
          return await adapter.run({ ...request, signal: controller.signal })
        } finally {
          signal.removeEventListener('abort', cancel)
          request.signal.removeEventListener('abort', cancel)
        }
      }
    }
  })
  return save(directory, { version: 1, pack: suite as QualityPack, report })
}
export function readQualityBundle(path: string): Bundle {
  if (statSync(path).size > 32_000_000) throw new Error('Quality report exceeds 32 MB')
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as Bundle
  if (
    bundle.version !== 1 ||
    !bundle.pack?.cases ||
    !Array.isArray(bundle.report?.rows) ||
    bundle.report.packDigest !== digest(bundle.pack)
  )
    throw new Error('Invalid or modified quality report')
  for (const row of bundle.report.rows)
    if (row.status === 'observed' && row.resultDigest !== digest(row.result))
      throw new Error('Quality result digest mismatch')
  return bundle
}
export function reviewQualityBundle(
  path: string,
  decisionsPath: string,
  directory: string
): QualitySummary {
  const bundle = readQualityBundle(path)
  if (statSync(decisionsPath).size > 2_000_000) throw new Error('Adjudications exceed 2 MB')
  const decisions = z
    .record(
      z.string().max(4096),
      z
        .object({
          state: z.enum(['correct', 'incorrect']),
          reviewer: z.string().min(1).max(512),
          rationale: z.string().min(1).max(8000),
          resultDigest: z.string().regex(/^[a-f0-9]{64}$/)
        })
        .strict()
    )
    .parse(JSON.parse(readFileSync(decisionsPath, 'utf8')))
  return save(directory, {
    ...bundle,
    report: adjudicateReport(bundle.report, bundle.pack, decisions)
  })
}
