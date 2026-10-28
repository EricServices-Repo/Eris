#!/usr/bin/env node
/** Explicit development-only model matrix. npm run build:dev-app first. */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log(
    'npm run quality:scenarios -- --config config.json --output private-report.json\nConfig: {"live":true,"models":["model ID from Eris-Dev"],"maxCalls":120,"maxOutputTokens":200000,"repeats":2,"split":"heldout","seed":"comparison-1"}. Requires the REC-27 bounded transport changes for inference; older builds report not-exercised. No claims are made from request captures.'
  )
} else {
  const value = (flag) => args[args.indexOf(flag) + 1]
  if (!args.includes('--config') || !args.includes('--output'))
    throw new Error('Explicit --config and --output required; use --help')
  const config = resolve(value('--config')),
    output = resolve(value('--output')),
    entry = resolve('out-dev/main/quality-scenarios.js')
  if (statSync(config).size > 1_000_000) throw new Error('Config exceeds 1 MB')
  const input = readFileSync(config, 'utf8')
  if (JSON.parse(input).live !== true)
    throw new Error('Config must explicitly authorize live inference')
  if (!existsSync(entry)) throw new Error('Build Eris-Dev first: npm run build:dev-app')
  const require = createRequire(import.meta.url),
    child = spawn(require('electron'), [entry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
    })
  let body = '',
    overflow = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    body += chunk
    if (Buffer.byteLength(body) > 64_000_000) {
      overflow = true
      child.kill()
    }
  })
  const cancel = () => child.kill('SIGTERM')
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  child.stdin.end(input)
  const code = await new Promise((res, rej) => {
    child.once('error', rej)
    child.once('close', res)
  })
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
  if (code !== 0 || overflow) throw new Error('Scenario process failed or exceeded output bounds')
  const line = body.split(/\r?\n/).find((x) => x.startsWith('ERIS_SCENARIO_RESULT '))
  if (!line) throw new Error('Scenario process returned no report')
  const report = JSON.parse(line.slice('ERIS_SCENARIO_RESULT '.length))
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(
    `Saved private scenario report: ${output}\n${report.coverage.completedTurns} completed turns; ${report.coverage.unresolved} unresolved independent reviews. General quality pass rate: unavailable.`
  )
}
