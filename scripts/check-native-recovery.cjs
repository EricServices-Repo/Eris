/* Actual Electron utility-process exits and cancellation; no model download or GPU claim. */
const { app, utilityProcess } = require('electron')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const root = mkdtempSync(join(tmpdir(), 'eris-process-probe-'))
app.setPath('userData', root)
require('esbuild').buildSync({
  entryPoints: ['electron/main/services/llama-worker-channel.ts'],
  outfile: join(root, 'channel.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const { waitForWorkerMessage } = require(join(root, 'channel.cjs'))
const fixture = join(root, 'worker.cjs')
writeFileSync(
  fixture,
  `process.parentPort.on('message',({data})=>{if(data==='recover')process.parentPort.postMessage({phase:'done'});else process.parentPort.postMessage({phase:data})});setInterval(()=>{},1000)`
)
const deadline = setTimeout(() => {
  console.error('Process recovery probe exceeded deadline')
  app.exit(1)
}, 30000)
app.whenReady().then(async () => {
  const rows = []
  const children = new Set()
  const spawn = () => {
    const child = utilityProcess.fork(fixture, [], { stdio: 'ignore' })
    children.add(child)
    return child
  }
  try {
    for (const phase of ['loading', 'generating']) {
      const child = spawn(),
        started = waitForWorkerMessage(child, (msg) => msg.phase === phase, undefined, 5000)
      child.postMessage(phase)
      await started
      const pending = waitForWorkerMessage(child, (msg) => msg.phase === 'done', undefined, 5000)
      child.kill()
      try {
        await pending
        throw new Error('Worker exit resolved a pending caller')
      } catch (error) {
        if (error.code !== 'LOCAL_MODEL_WORKER_FAILED') throw error
      }
      rows.push({ phase, result: 'caller-rejected' })
    }
    for (let i = 0; i < 5; i++) {
      const child = spawn(),
        controller = new AbortController()
      const pending = waitForWorkerMessage(
        child,
        (msg) => msg.phase === 'done',
        controller.signal,
        5000
      )
      controller.abort()
      child.kill()
      try {
        await pending
        throw new Error('Cancellation resolved a caller')
      } catch (error) {
        if (error.name !== 'AbortError') throw error
      }
    }
    const child = spawn(),
      result = waitForWorkerMessage(child, (msg) => msg.phase === 'done', undefined, 5000)
    child.postMessage('recover')
    await result
    child.kill()
    const report = {
      version: 1,
      os: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      backend: 'utility-process fixture',
      model: null,
      rows,
      repeatedCancellation: 5,
      recovery: 'passed',
      limitations: [
        'No GPU, model-load, memory-pressure, installer or signed-update certification.'
      ]
    }
    console.log(JSON.stringify(report, null, 2))
    if (process.env.ERIS_PROBE_REPORT)
      writeFileSync(process.env.ERIS_PROBE_REPORT, JSON.stringify(report, null, 2) + '\n')
    clearTimeout(deadline)
    rmSync(root, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error.message)
    for (const child of children) child.kill()
    clearTimeout(deadline)
    app.exit(1)
  }
})
