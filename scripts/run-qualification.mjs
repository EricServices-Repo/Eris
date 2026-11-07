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
import { qualifyResults } from './qualification-evidence.mjs'

const REPORT_VERSION = 2
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
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() }
  catch { return null }
}
const sha256 = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const untrackedDigest = () => {
  const files = (git('ls-files', '--others', '--exclude-standard') ?? '').split('\n').filter(Boolean).sort()
  return createHash('sha256').update(JSON.stringify(files.map(file => [file, sha256(join(root, file))]))).digest('hex')
}
const source = {
  commit: git('rev-parse', 'HEAD'),
  diffDigest: createHash('sha256').update(git('diff', 'HEAD', '--', '.') ?? 'unknown').digest('hex'),
  lockfile: sha256(join(root, 'package-lock.json')),
  profiles: sha256(join(root, 'tests/qualification-profiles.json')),
  untrackedDigest: untrackedDigest()
}

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

const results = existsSync(raw) ? JSON.parse(readFileSync(raw, 'utf8')) : null
const qualification = qualifyResults(root, profile.files, results, vitest.status)
if (source.commit !== git('rev-parse', 'HEAD') || source.lockfile !== sha256(join(root, 'package-lock.json')) ||
    source.untrackedDigest !== untrackedDigest() ||
    source.diffDigest !== createHash('sha256').update(git('diff', 'HEAD', '--', '.') ?? 'unknown').digest('hex') ||
    source.profiles !== sha256(join(root, 'tests/qualification-profiles.json'))) {
  qualification.pass = false
  qualification.failures.push('Source inputs changed during qualification')
}
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
  source,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  ci: { runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
  dirty: status === null ? null : status.length > 0,
  corpus: {
    path: 'tests/fixtures/10000-natural-diverse-coding-questions.txt',
    sha256: sha256(join(root, 'tests/fixtures/10000-natural-diverse-coding-questions.txt'))
  },
  files: profile.files,
  counts: qualification.counts,
  qualificationFailures: qualification.failures,
  failed,
  // What a green run of this profile does not show. Stated in every report.
  notRun: profile.notRun ?? [],
  outcome: qualification.pass ? 'passed' : 'failed'
}
const path = join(outDir, `${name}.json`)
writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
console.log(
  `\nQualification ${name}: ${report.outcome} · ${report.counts?.passed ?? 0}/${report.counts?.tests ?? 0} tests · commit ${report.commit.slice(0, 8)}${report.dirty ? ' (dirty)' : ''}\nNot exercised: ${report.notRun.join(', ') || 'nothing listed'}\nReport: ${path}`
)
process.exit(report.outcome === 'passed' ? 0 : 1)
