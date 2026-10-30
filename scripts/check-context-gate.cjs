const { execFileSync } = require('node:child_process')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')

async function main() {
  const { runContextGate, evaluateContextGate } = require(
    path.resolve('.eris/cache/performance/context-gate.cjs')
  )
  const sizes = process.argv.includes('--quick') ? [1000, 10000] : undefined
  const report = await runContextGate({
    sizes,
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      totalMemoryBytes: os.totalmem()
    },
    runtime: { node: process.versions.node }
  })
  const budgets = JSON.parse(fs.readFileSync('checks/performance/context-budgets.json', 'utf8'))
  const result = evaluateContextGate(report, budgets)
  const file = path.resolve('out/qualification/context-gate-performance.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...report, result }, null, 2))
  for (const corpus of report.corpora)
    console.log(
      `${corpus.size}: retained ${corpus.denominators.retained}, cold ${corpus.measured.coldInstallMs.toFixed(0)} ms, ` +
        `worst query p95 ${Math.max(...Object.values(corpus.measured.latencyMs).map((q) => q.p95)).toFixed(1)} ms`
    )
  console.log(`Recall: ${report.recall.passed}/${report.recall.cases} labeled (synthetic)`)
  for (const note of result.notEvaluated) console.log(`Not evaluated: ${note}`)
  console.log(`Report: ${file}`)
  if (!result.pass) throw new Error(`Context gate failed:\n${result.failures.join('\n')}`)
  console.log('Context release gate passed')
}
main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
