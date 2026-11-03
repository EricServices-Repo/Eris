#!/usr/bin/env node
/**
 * RAM-CTX-061 (#233) measurement: what does keeping or parking a conversation's KV
 * state save on turn N of a long thread? Runs node-llama-cpp directly against a local
 * GGUF, outside Eris, so it measures the runtime capability the issue proposes to use,
 * not Eris's current turn loop.
 *
 *   node scripts/measure-kv-reuse.mjs --model <file.gguf> [--turns 24] [--repeats 3]
 *        [--context 8192] [--out report.json]
 *
 * Scenarios, each timed to the first generated token:
 *   fresh     a new sequence per turn: the whole history is evaluated again
 *             (what a per-run session does today)
 *   retained  the same sequence as the previous turn: only the new message is evaluated
 *   parked    the thread's state was saved to a file, the sequence was used by another
 *             thread, then the state was loaded back before the turn
 * A parked load uses acceptRisk; the state file comes from this process and this model.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, totalmem, cpus } from 'node:os'
import { join, basename } from 'node:path'
import { writeFileSync } from 'node:fs'
import { getLlama, LlamaChatSession } from 'node-llama-cpp'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, [])
)
if (!args.model) {
  console.error('Usage: node scripts/measure-kv-reuse.mjs --model <file.gguf> [--turns N]')
  process.exit(2)
}
const TURNS = Number(args.turns ?? 24)
const REPEATS = Number(args.repeats ?? 3)
const CONTEXT = Number(args.context ?? 8192)

/** A long, varied synthetic thread: deterministic so runs are comparable. */
function history(turns) {
  const items = []
  for (let i = 0; i < turns; i++) {
    items.push({
      type: 'user',
      text:
        `Turn ${i}: in module ${['billing', 'auth', 'search', 'export'][i % 4]}, ` +
        `function handle${i}() should validate input ${i} and log ${i * 7} events. ` +
        'Explain the change and list risks. '.repeat(3)
    })
    items.push({
      type: 'model',
      response: [
        `For handle${i}, validate the payload shape first, then reject values outside ` +
          `0..${i * 10}. Risks: missing migration for record ${i}, duplicated log lines, ` +
          'and a slower path when the cache is cold. '.repeat(4)
      ]
    })
  }
  return items
}
const NEXT = 'Summarize the three riskiest changes so far in one sentence each.'

function runtimeVersion() {
  const entry = createRequire(import.meta.url).resolve('node-llama-cpp')
  const root = entry.slice(0, entry.lastIndexOf('node-llama-cpp') + 'node-llama-cpp'.length)
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function firstToken(session, sequence) {
  const before = sequence.tokenMeter.getState().usedInputTokens
  const start = performance.now()
  let first = 0
  await session.prompt(NEXT, {
    maxTokens: 4,
    temperature: 0,
    onTextChunk: () => {
      if (!first) first = performance.now()
    }
  })
  return {
    firstTokenMs: (first || performance.now()) - start,
    evaluatedTokens: sequence.tokenMeter.getState().usedInputTokens - before
  }
}

const llama = await getLlama()
const model = await llama.loadModel({ modelPath: args.model })
const context = await model.createContext({ contextSize: CONTEXT, sequences: 2 })
const scratch = mkdtempSync(join(tmpdir(), 'eris-kv-'))
const thread = history(TURNS)
const other = history(Math.max(2, Math.floor(TURNS / 2))).map((item) =>
  item.type === 'user' ? { ...item, text: item.text.replace(/Turn/g, 'Other thread turn') } : item
)

/** A session on `sequence` whose KV already holds `items`, as the previous turn left it. */
async function seeded(sequence, items) {
  const session = new LlamaChatSession({ contextSequence: sequence, autoDisposeSequence: false })
  session.setChatHistory([
    { type: 'system', text: 'You are a concise coding assistant.' },
    ...items
  ])
  // One throwaway token evaluates the history into this sequence's KV.
  await session.prompt('ok', { maxTokens: 1, temperature: 0 })
  session.setChatHistory([
    { type: 'system', text: 'You are a concise coding assistant.' },
    ...items
  ])
  return session
}

// Warm up once so the first measured scenario does not pay shader and graph setup.
{
  const sequence = context.getSequence()
  const session = new LlamaChatSession({ contextSequence: sequence, autoDisposeSequence: false })
  await session.prompt('warm up', { maxTokens: 2, temperature: 0 })
  session.dispose({ disposeSequence: false })
  sequence.dispose()
}

const runs = { fresh: [], retained: [], parked: [] }
const park = { saveMs: [], loadMs: [], bytes: 0 }
try {
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    // fresh: nothing of this thread is in the sequence.
    {
      const sequence = context.getSequence()
      const session = new LlamaChatSession({
        contextSequence: sequence,
        autoDisposeSequence: false
      })
      session.setChatHistory([
        { type: 'system', text: 'You are a concise coding assistant.' },
        ...thread
      ])
      runs.fresh.push(await firstToken(session, sequence))
      session.dispose({ disposeSequence: false })
      sequence.dispose()
    }
    // retained: the previous turn left this thread's history in the sequence.
    {
      const sequence = context.getSequence()
      const session = await seeded(sequence, thread)
      runs.retained.push(await firstToken(session, sequence))
      session.dispose({ disposeSequence: false })
      sequence.dispose()
    }
    // parked: save, serve another thread on the same sequence, then load back.
    {
      const sequence = context.getSequence()
      let session = await seeded(sequence, thread)
      const file = join(scratch, `thread-${repeat}.state`)
      let at = performance.now()
      await sequence.saveStateToFile(file)
      park.saveMs.push(performance.now() - at)
      park.bytes = statSync(file).size
      session.dispose({ disposeSequence: false })
      const away = await seeded(sequence, other)
      away.dispose({ disposeSequence: false })
      at = performance.now()
      await sequence.loadStateFromFile(file, { acceptRisk: true })
      const loadMs = performance.now() - at
      park.loadMs.push(loadMs)
      session = new LlamaChatSession({ contextSequence: sequence, autoDisposeSequence: false })
      session.setChatHistory([
        { type: 'system', text: 'You are a concise coding assistant.' },
        ...thread
      ])
      const result = await firstToken(session, sequence)
      runs.parked.push({ ...result, firstTokenMs: result.firstTokenMs + loadMs })
      session.dispose({ disposeSequence: false })
      sequence.dispose()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const summarize = (rows) => ({
  firstTokenMsMedian: Math.round(median(rows.map((row) => row.firstTokenMs))),
  firstTokenMs: rows.map((row) => Math.round(row.firstTokenMs)),
  evaluatedTokensMedian: median(rows.map((row) => row.evaluatedTokens))
})
const report = {
  version: 1,
  evidence: 'live-hardware',
  boundary: 'node-llama-cpp context sequence directly; not the Eris turn loop',
  model: basename(args.model),
  modelBytes: statSync(args.model).size,
  runtime: { nodeLlamaCpp: runtimeVersion(), gpu: llama.gpu },
  host: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    totalMemoryBytes: totalmem()
  },
  contextSize: context.contextSize,
  gpuLayers: model.gpuLayers,
  historyTurns: TURNS,
  repeats: REPEATS,
  scenarios: {
    fresh: summarize(runs.fresh),
    retained: summarize(runs.retained),
    parked: { ...summarize(runs.parked), includesLoad: true }
  },
  parking: {
    stateFileBytes: park.bytes,
    saveMsMedian: Math.round(median(park.saveMs)),
    loadMsMedian: Math.round(median(park.loadMs))
  }
}
console.log(JSON.stringify(report, null, 2))
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n')
await context.dispose()
await model.dispose()
await llama.dispose()
