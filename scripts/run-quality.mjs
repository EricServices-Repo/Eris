#!/usr/bin/env node
/** Explicit operator-supplied adapter. Importing this module never reaches a model. */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
export function assessQuality(test, result, adjudication) {
  if (result.completion !== 'complete')
    return { state: 'unresolved', reason: 'Incomplete or interrupted output' }
  if (test.oracle === 'json') {
    try {
      return {
        state: isDeepStrictEqual(JSON.parse(result.answer), test.expected)
          ? 'correct'
          : 'incorrect',
        source: 'independent-json-oracle'
      }
    } catch {
      return { state: 'incorrect', source: 'independent-json-oracle' }
    }
  }
  if (
    adjudication &&
    ['correct', 'incorrect'].includes(adjudication.state) &&
    adjudication.reviewer &&
    adjudication.rationale &&
    adjudication.resultDigest === digest(result)
  )
    return {
      state: adjudication.state,
      source: 'human',
      reviewer: adjudication.reviewer,
      rationale: adjudication.rationale
    }
  return { state: 'unresolved', reason: 'Independent human adjudication required' }
}
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function runQuality({
  pack,
  models,
  repeats = 2,
  maxCalls,
  maxOutputTokens,
  timeoutMs = 90000,
  adapter,
  live = false,
  adjudications = {}
}) {
  if (
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    repeats > 10 ||
    !models.length ||
    models.length > 8
  )
    throw new Error('Invalid model/repeat selection')
  if (
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 128
  )
    throw new Error('Explicit finite call and output-token budgets required')
  if (adapter.kind === 'live' && !live) throw new Error('Live calls require --live')
  if (!['scripted', 'live'].includes(adapter.kind))
    throw new Error('Adapter must identify scripted or live execution')
  const rows = []
  let calls = 0
  let remaining = maxOutputTokens
  for (const model of models)
    for (let repeat = 0; repeat < repeats; repeat++)
      for (const test of pack.cases) {
        const key = `${test.id}:${model}:${repeat}`
        if (calls >= maxCalls || remaining < 128) {
          rows.push({ key, caseId: test.id, model, repeat, status: 'budget-skipped' })
          continue
        }
        const controller = new AbortController()
        const started = Date.now()
        const cap = Math.min(4096, remaining)
        // Reserve the full requested cap before the call; missing provider usage cannot evade the budget.
        remaining -= cap
        calls++
        let timer
        try {
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(
              () => {
                controller.abort()
                reject(new Error('Quality call deadline exceeded'))
              },
              Math.min(180000, Math.max(100, timeoutMs))
            )
          })
          const result = await Promise.race([
            adapter.run({
              test,
              model,
              repeat,
              maxCalls: 1,
              maxOutputTokens: cap,
              signal: controller.signal
            }),
            deadline
          ])
          if (!result || typeof result.answer !== 'string' || !result.effectiveSettings)
            throw new Error('Adapter must return answer and effective runtime settings')
          if (result.usage?.outputTokens > cap) throw new Error('Adapter exceeded output-token cap')
          rows.push({
            key,
            caseId: test.id,
            stratum: test.stratum,
            model,
            repeat,
            status: 'observed',
            latencyMs: Date.now() - started,
            result,
            resultDigest: digest(result),
            correctness: assessQuality(test, result, adjudications[key])
          })
        } catch (error) {
          rows.push({
            key,
            caseId: test.id,
            model,
            repeat,
            status: 'error',
            latencyMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
            correctness: { state: 'unresolved' }
          })
        } finally {
          clearTimeout(timer)
          controller.abort()
        }
      }
  return {
    version: 1,
    packVersion: pack.version,
    packDigest: digest(pack),
    mode: adapter.kind,
    createdAt: new Date().toISOString(),
    models,
    repeats,
    limits: { maxCalls, maxOutputTokens, timeoutMs },
    calls,
    reservedOutputTokens: maxOutputTokens - remaining,
    rows,
    limitations: [
      'Only independent JSON or human adjudication grades correctness.',
      'Adapter must enforce per-call provider and effect limits; this harness never executes returned code.',
      'Scripted runs establish harness behavior, not live-model quality.'
    ]
  }
}
export function adjudicateReport(report, pack, decisions) {
  if (report.packDigest !== digest(pack))
    throw new Error('Adjudication fixture digest differs from the recorded run')
  return {
    ...report,
    adjudicatedAt: new Date().toISOString(),
    rows: report.rows.map((row) => {
      if (row.status !== 'observed') return row
      const test = pack.cases.find((test) => test.id === row.caseId)
      if (!test || row.resultDigest !== digest(row.result))
        throw new Error('Recorded quality result was modified')
      return { ...row, correctness: assessQuality(test, row.result, decisions[row.key]) }
    })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2),
      option = (name) => args[args.indexOf(name) + 1]
    const offline = args.includes('--adjudicate')
    for (const name of offline
      ? ['--adjudicate', '--adjudications', '--output']
      : ['--adapter', '--models', '--max-calls', '--max-output-tokens', '--output'])
      if (!args.includes(name)) throw new Error(`Missing ${name}`)
    const adapter = offline ? null : await import(pathToFileURL(resolve(option('--adapter'))).href)
    const pack = JSON.parse(
      readFileSync(new URL('../checks/quality/cases.json', import.meta.url), 'utf8')
    )
    const report = offline
      ? adjudicateReport(
          JSON.parse(readFileSync(option('--adjudicate'), 'utf8')),
          pack,
          JSON.parse(readFileSync(option('--adjudications'), 'utf8'))
        )
      : await runQuality({
          pack,
          models: option('--models').split(','),
          repeats: args.includes('--repeats') ? Number(option('--repeats')) : 2,
          maxCalls: Number(option('--max-calls')),
          maxOutputTokens: Number(option('--max-output-tokens')),
          live: args.includes('--live'),
          adapter,
          adjudications: args.includes('--adjudications')
            ? JSON.parse(readFileSync(option('--adjudications'), 'utf8'))
            : {}
        })
    writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(
      `Quality report written: ${report.rows.length} cases; ${report.calls} calls; unresolved correctness is retained.`
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
