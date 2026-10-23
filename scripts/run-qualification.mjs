#!/usr/bin/env node
/**
 * Run one qualification profile from tests/qualification-profiles.json and write a
 * versioned report beside the build output. The report names the commit, corpus,
 * profile, counts, failures, and the stages this profile does not exercise, so a
 * green build is never read as live-model or desktop-UI qualification.
 *
 * Usage:
 *   node scripts/run-qualification.mjs agents
 *   node scripts/run-qualification.mjs dev-app
 *
 * Exits non-zero when any test fails or the profile is unknown.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPORT_VERSION = 1
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const name = process.argv[2]
const config = JSON.parse(readFileSync(join(root, 'tests/qualification-profiles.json'), 'utf8'))
const profile = config.profiles[name]
if (!profile) {
  console.error(
    `Unknown qualification profile “${name}”. Known: ${Object.keys(config.profiles).join(', ')}`
  )
  process.exit(2)
}

const outDir = join(root, 'out', 'qualification')
mkdirSync(outDir, { recursive: true })
const raw = join(outDir, `${name}.vitest.json`)
rmSync(raw, { force: true })

const vitest = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    ...profile.files,
    '--reporter=verbose',
    '--reporter=json',
    `--outputFile.json=${raw}`,
    '--testTimeout=30000'
  ],
  { cwd: root, stdio: 'inherit' }
)

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const sha256 = (path) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null

const results = existsSync(raw) ? JSON.parse(readFileSync(raw, 'utf8')) : null
const failed = (results?.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? [])
    .filter((test) => test.status === 'failed')
    .map((test) => `${file.name.replace(root + '/', '')} › ${test.fullName}`)
)
const status = git('status', '--porcelain')
const report = {
  version: REPORT_VERSION,
  profile: name,
  description: profile.description,
  created: new Date().toISOString(),
  commit: git('rev-parse', 'HEAD') ?? 'unknown',
  dirty: status === null ? null : status.length > 0,
  corpus: {
    path: 'tests/fixtures/10000-natural-diverse-coding-questions.txt',
    sha256: sha256(join(root, 'tests/fixtures/10000-natural-diverse-coding-questions.txt'))
  },
  files: profile.files,
  counts: results
    ? {
        files: results.numTotalTestSuites,
        tests: results.numTotalTests,
        passed: results.numPassedTests,
        failed: results.numFailedTests,
        skipped: results.numPendingTests + (results.numTodoTests ?? 0)
      }
    : null,
  failed,
  // What a green run of this profile does not show. Stated in every report.
  notRun: profile.notRun ?? [],
  outcome: vitest.status === 0 && results?.success !== false ? 'passed' : 'failed'
}
const path = join(outDir, `${name}.json`)
writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
console.log(
  `\nQualification ${name}: ${report.outcome} · ${report.counts?.passed ?? 0}/${report.counts?.tests ?? 0} tests · commit ${report.commit.slice(0, 8)}${report.dirty ? ' (dirty)' : ''}\nNot exercised: ${report.notRun.join(', ') || 'nothing listed'}\nReport: ${path}`
)
process.exit(report.outcome === 'passed' ? 0 : 1)
