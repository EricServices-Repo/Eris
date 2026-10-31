import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'eris-client-workers-'))
const worker = new Worker(resolve(process.argv[2] ?? 'out/main/workspace-worker.js'), {
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
  const evidence = await request({
    type: 'context-evidence-capture',
    root,
    paths: ['src/nested/b.ts']
  })
  assert.equal(evidence.complete, true)
  assert.deepEqual(
    await request({ type: 'context-evidence-validate', root, snapshots: [evidence] }),
    [true]
  )
  await writeFile(join(root, 'src', 'nested', 'b.ts'), 'export function beta() { return 3 }')
  assert.deepEqual(
    await request({ type: 'context-evidence-validate', root, snapshots: [evidence] }),
    [false]
  )
  const indexPath = join(root, '.eris', 'code-index.json')
  const indexed = await request({ type: 'index', root, indexPath })
  assert.ok(indexed.symbols.some((symbol) => symbol.name === 'alpha'))
  await unlink(join(root, 'src', 'a.ts'))
  const patched = await request({ type: 'patch-index', root, indexPath, paths: ['src/a.ts'] })
  assert.deepEqual(patched.files, ['src/nested/b.ts'])
  const dir = join(root, '.eris', 'chats')
  const emptyUsage = await request({ type: 'chat-storage-usage', dir })
  assert.equal(emptyUsage.initialized, false)
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
  const usage = await request({ type: 'chat-storage-usage', dir })
  assert.equal(usage.initialized, true)
  assert.equal(usage.conversations, 1)
  assert.equal(usage.messages, 156)
  assert.ok(usage.databaseBytes > 0)
  assert.ok(usage.journalBytes >= 0)
  assert.equal(full.messages.length, 156)
  assert.equal(full.messages[0].content, 'Message 0')
  assert.equal(await readFile(join(dir, 'legacy.json'), 'utf8'), original)
  const archive = await request({
    type: 'context-archive-search',
    dir,
    id: 'legacy',
    query: 'Message'
  })
  assert.equal(archive.index.backend, 'sqlite-postings')
  assert.equal(typeof archive.index.fts5Available, 'boolean')
  assert.ok(archive.index.builtChunks <= 32)
  assert.ok(archive.records.length <= 12)
  assert.equal(await request({ type: 'chat-close', dir }), true)
  const replay = await request({ type: 'context-replay', dir, limit: 500 })
  assert.equal(replay.complete, true)
  const changes = await request({ type: 'context-changes', dir, after: 0, limit: 2 })
  assert.equal(changes.events.length, 2)
  assert.equal(changes.capabilities.journal, 'wal')
  assert.equal(typeof changes.capabilities.fts5, 'boolean')
  const context = await request({ type: 'context-page', dir, id: 'legacy' })
  assert.equal(context.records.length, 156)
  assert.equal(context.revision, full.contextRevision)
  assert.equal(context.done, true)
  // Recall's projection/cursor contract must also survive a real built-worker transfer.
  const content = 'Remember: booking currency CAD. ' + '界😀 conversation '.repeat(6000)
  await request({
    type: 'chat-save',
    dir,
    thread: {
      id: 'chunked',
      title: 'Chunked',
      model: 'local:test',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'source',
          role: 'assistant',
          content,
          thinking: 'private trace'.repeat(200000),
          createdAt: 1
        }
      ]
    }
  })
  let before, beforeContentOffset
  const chunks = []
  for (let i = 0; i < 20; i++) {
    const page = await request({
      type: 'context-page',
      dir,
      id: 'chunked',
      before,
      beforeContentOffset
    })
    assert.equal(page.omitted, 0)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 2000000)
    assert.ok(!JSON.stringify(page).includes('private trace'))
    chunks.unshift(...page.records)
    if (page.done) break
    before = page.before
    beforeContentOffset = page.beforeContentOffset
  }
  assert.equal(chunks.map((row) => row.message.content).join(''), content)
  assert.equal(chunks[0].message.contextContentOffset, 0)
  assert.ok(chunks.length > 1)
  const controls = {
    version: 1,
    forgotten: ['0'],
    pinned: [{ id: 'pin', text: 'Use CAD for checkout' }],
    afterOrdinal: 0
  }
  const savedControls = await request({
    type: 'context-controls',
    dir,
    id: 'legacy',
    write: controls
  })
  assert.deepEqual(await request({ type: 'context-controls', dir, id: 'legacy' }), savedControls)
  assert.equal(
    await request({
      type: 'context-source-scope',
      dir,
      id: 'legacy',
      messageId: '0',
      projectRoot: root
    }),
    true
  )
  const scoped = await request({ type: 'context-page', dir, id: 'legacy' })
  assert.equal(scoped.records[0].message.contextProjectRoot, root)
  await request({ type: 'shutdown' })
  console.log(
    'Client worker checks passed: lazy tree, index patch, legacy import, paginated save, concurrent append, context paging and controls, trace-free Unicode chunk continuation, graceful shutdown.'
  )
} finally {
  await worker.terminate()
  for (const entry of pending.values()) clearTimeout(entry.timer)
  await rm(root, { recursive: true, force: true })
}
