#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { assessQuality, digest, runQuality, adjudicateReport } from '../checks/quality/runtime.mjs'
export { assessQuality, digest, runQuality, adjudicateReport }
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
