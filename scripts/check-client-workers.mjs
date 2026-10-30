import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'eris-client-workers-'))
const worker = new Worker(resolve('out/main/workspace-worker.js'), {
  env: { ...process.env, ERIS_APP_PATH: process.cwd() }
})
let sequence = 0
const pending = new Map()
worker.on('message', ({ id, result, error }) => {
  const request = pending.get(id)
  if (!request) return
  clearTimeout(request.timer)
  pending.delete(id)
  if (error) request.reject(new Error(error))
  else request.resolve(result)
})
worker.on('error', (error) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
})
const request = (payload) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Worker timed out: ${payload.type}`))
    }, 20_000)
    pending.set(id, { resolve, reject, timer })
    worker.postMessage({ id, request: payload })
  })

try {
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export function alpha() { return 1 }')
  await writeFile(join(root, 'src', 'nested', 'b.ts'), 'export function beta() { return 2 }')
  const tree = await request({ type: 'tree', root, maxDepth: 0 })
  assert.equal(tree[0].name, 'src')
  assert.equal(tree[0].children, undefined)
  const indexPath = join(root, '.eris', 'code-index.json')
  const indexed = await request({ type: 'index', root, indexPath })
  assert.ok(indexed.symbols.some((symbol) => symbol.name === 'alpha'))
  await unlink(join(root, 'src', 'a.ts'))
  const patched = await request({ type: 'patch-index', root, indexPath, paths: ['src/a.ts'] })
  assert.deepEqual(patched.files, ['src/nested/b.ts'])
  const dir = join(root, '.eris', 'chats')
  await mkdir(dir, { recursive: true })
  const legacy = {
    id: 'legacy',
    title: 'Legacy',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: Array.from({ length: 150 }, (_, index) => ({
      id: String(index),
      role: 'user',
      content: `Message ${index}`,
      createdAt: index
    }))
  }
  const original = JSON.stringify(legacy)
  await writeFile(join(dir, 'legacy.json'), original)
  const summaries = await request({ type: 'chat-list', dir })
  assert.equal(summaries[0].messages.length, 0)
  const page = await request({ type: 'chat-get', dir, id: 'legacy', page: { limit: 10 } })
  assert.equal(page.messageOffset, 140)
  page.messages.push({ id: 'follow-up', role: 'user', content: 'New question', createdAt: 1000 })
  await request({ type: 'chat-save', dir, thread: page })
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      request({
        type: 'chat-append',
        dir,
        id: 'legacy',
        message: {
          id: `worker-${index}`,
          role: 'assistant',
          content: `Answer ${index}`,
          createdAt: 1001 + index
        }
      })
    )
  )
  const full = await request({ type: 'chat-get', dir, id: 'legacy' })
  const sourceHeader = await request({ type: 'context-header', dir, id: 'legacy' })
  assert.equal(sourceHeader.revision, full.contextRevision)
  assert.equal(sourceHeader.sourceEpoch, full.contextEpoch)
  assert.ok(sourceHeader.sourceEpoch)
  assert.equal(full.messages.length, 156)
  assert.equal(full.messages[0].content, 'Message 0')
  assert.equal(await readFile(join(dir, 'legacy.json'), 'utf8'), original)
  const context = await request({ type: 'context-page', dir, id: 'legacy' })
  assert.equal(context.records.length, 156)
  assert.equal(context.revision, full.contextRevision)
  assert.equal(context.done, true)
  const controls = {
    version: 1,
    forgotten: ['0'],
    pinned: [{ id: 'pin', text: 'Use CAD for checkout' }],
    afterOrdinal: 0
  }
  await request({ type: 'context-controls', dir, id: 'legacy', write: controls })
  assert.deepEqual(await request({ type: 'context-controls', dir, id: 'legacy' }), controls)
  await request({ type: 'shutdown' })
  console.log(
    'Client worker checks passed: lazy tree, index patch, legacy import, paginated save, concurrent append, context paging and controls, graceful shutdown.'
  )
} finally {
  await worker.terminate()
  for (const entry of pending.values()) clearTimeout(entry.timer)
  await rm(root, { recursive: true, force: true })
}
