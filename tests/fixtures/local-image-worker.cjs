// A process-level protocol simulator. Production never references this fixture.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZLsAAAAASUVORK5CYII=', 'base64')
readline.createInterface({ input: process.stdin }).once('line', (line) => {
  const input = JSON.parse(line)
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
  emit({ type: 'progress', message: 'Simulated worker started' })
  if (input.repoId === 'slow/model') { setTimeout(() => {}, 60_000); return }
  let data
  if (input.operation === 'status') data = { ready: true, device: 'cpu', deviceName: 'Simulated CPU' }
  else if (input.operation === 'download') {
    const content = JSON.stringify({ _class_name: 'StableDiffusionPipeline' })
    fs.mkdirSync(input.modelPath, { recursive: true })
    fs.writeFileSync(path.join(input.modelPath, 'model_index.json'), content)
    data = { repoId: input.repoId, revision: 'a'.repeat(40), pipeline: 'StableDiffusionPipeline', variant: 'fp16', bytes: Buffer.byteLength(content), downloadedAt: Date.now(),
      files: [{ path: 'model_index.json', bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') }] }
  } else if (input.operation === 'generate') {
    if (input.prompt === 'FAIL') { emit({ type: 'error', error: 'Simulated local inference failure' }); process.exitCode = 1; return }
    fs.writeFileSync(input.outputPath, png)
    data = { device: 'cpu', width: 1, height: 1 }
  }
  emit({ type: 'result', data })
})
