/** Verify downloaded, source-bound platform evidence; never infer qualification from a CI test count. */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const target = process.argv[2] ?? 'out/qualification/release-evidence'
const output = 'out/qualification/context-release-verification.json'
try {
  const { evaluateContextReleaseEvidence } = require(
    path.resolve('.eris/cache/performance/context-gate.cjs')
  )
  const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const budgets = JSON.parse(fs.readFileSync('checks/performance/context-budgets.json', 'utf8'))
  const files = fs.readdirSync(target).filter((file) => file.endsWith('.json'))
  if (files.length !== 2) throw new Error('Provide exactly two packaged platform reports')
  const reports = files.map((file) => {
    const input = path.join(target, file)
    if (fs.statSync(input).size > 16_000_000) throw new Error('Report exceeds 16 MB')
    return JSON.parse(fs.readFileSync(input, 'utf8'))
  })
  const result = evaluateContextReleaseEvidence(reports, budgets, expectedSha)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify({ expectedSha, files, ...result }, null, 2))
  if (!result.pass) throw new Error(result.failures.join('\n'))
  console.log('RAM-context release evidence verified for macOS and Windows')
} catch (error) {
  console.error(`RAM-context release NOT qualified: ${error.message}`)
  process.exitCode = 1
}
