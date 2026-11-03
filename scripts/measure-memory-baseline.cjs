/**
 * #228 baseline: the RAM tier inside the process that holds it today.
 *
 *   npx vite build --config checks/vite.performance-node.config.ts
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/measure-memory-baseline.cjs [--out file]   # Electron's V8 as Node
 *   electron scripts/measure-memory-baseline.cjs --main [--out file]                    # a real Electron main process
 *
 * --steps 128,256 limits the tier sizes. --install sync times the one-call install instead
 * of the production paged path (default: segments). Writes JSON to stdout and to --out.
 */
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')

const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function measure() {
  const { measureMemoryBaseline } = require(
    path.resolve(__dirname, '../.eris/cache/performance/memory-process-baseline.cjs')
  )
  const steps = flag('--steps')?.split(',').map(Number)
  const install = flag('--install')
  const report = await measureMemoryBaseline({
    ...(steps ? { stepsMiB: steps } : {}),
    ...(install ? { install } : {})
  })
  const out = {
    ...report,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      totalMemoryBytes: os.totalmem()
    }
  }
  const text = JSON.stringify(out, null, 2)
  console.log(text)
  if (flag('--out')) fs.writeFileSync(flag('--out'), text + '\n')
}

if (
  process.argv.includes('--main') &&
  process.versions.electron &&
  !process.env.ELECTRON_RUN_AS_NODE
) {
  const { app } = require('electron')
  app.whenReady().then(() =>
    measure()
      .catch((error) => {
        console.error(error)
        process.exitCode = 1
      })
      .finally(() => app.quit())
  )
} else
  measure().catch((error) => {
    console.error(error)
    process.exit(1)
  })
