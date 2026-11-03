#!/usr/bin/env node
/**
 * RAM-CTX-059 (#231) measurement: what memory mapping costs a fully offloaded model
 * in available RAM and file cache, and what turning it off costs in load time.
 *
 *   node scripts/measure-mmap.mjs --model <file.gguf> [--repeats 3] [--out report.json]
 *
 * Each sample is a fresh child process that loads the model with every layer on the GPU
 * (the same options as fullOffloadOptions, with useMmap forced on or off), creates a
 * small context, and samples memory once the load settles. Modes alternate so neither
 * always runs after the other. Purging the OS file cache needs root, so it is not done:
 * after the first sample the GGUF is usually in cache for both modes, and the report
 * says so.
 *
 * Memory sources: darwin vm_stat (free, file-backed and purgeable pages), linux
 * /proc/meminfo (MemAvailable, Cached). Windows has no file-cache counter here; it
 * records os.freemem only, which is the number the dedicated-GPU run needs most.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, [])
)
const MiB = 1024 ** 2

/** System memory as the OS reports it, in bytes; null where this platform has no source. */
export function systemMemory() {
  const out = { freeBytes: freemem(), availableBytes: null, fileCacheBytes: null }
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('vm_stat', { encoding: 'utf8' })
      const page = Number(/page size of (\d+)/.exec(text)?.[1] ?? 16384)
      const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0) * page
      out.fileCacheBytes = pages('File-backed pages')
      // What macOS can hand out without paging: free + purgeable + inactive file cache.
      out.availableBytes = pages('Pages free') + pages('Pages purgeable') + pages('Pages inactive')
    } else if (process.platform === 'linux') {
      const text = readFileSync('/proc/meminfo', 'utf8')
      const kib = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0) * 1024
      out.availableBytes = kib('MemAvailable')
      out.fileCacheBytes = kib('Cached')
    }
  } catch {
    // Leave the platform figures null; freemem is still recorded.
  }
  return out
}

async function child() {
  const { getLlama } = await import('node-llama-cpp')
  const useMmap = args.mmap === 'on'
  const before = systemMemory()
  const llama = await getLlama()
  const start = performance.now()
  const model = await llama.loadModel({
    modelPath: args.model,
    useMmap,
    defaultContextFlashAttention: true,
    gpuLayers: 'max'
  })
  const loadMs = performance.now() - start
  const context = await model.createContext({ contextSize: 2048 })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const after = systemMemory()
  const vram = await llama.getVramState()
  process.stdout.write(
    JSON.stringify({
      useMmap,
      loadMs: Math.round(loadMs),
      gpuLayers: model.gpuLayers,
      gpu: llama.gpu,
      rssBytes: process.memoryUsage().rss,
      vramUsedBytes: vram.used,
      before,
      after
    }) + '\n'
  )
  await context.dispose()
  await model.dispose()
  await llama.dispose()
}

function sample(mode) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--child', '1', '--model', args.model, '--mmap', mode],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let text = ''
    proc.stdout.on('data', (chunk) => (text += chunk))
    proc.on('exit', (code) => {
      const line = text.trim().split('\n').pop()
      if (code === 0 && line) resolve(JSON.parse(line))
      else reject(new Error(`child (${mode}) exited ${code}`))
    })
  })
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const delta = (row, key) =>
  row.before[key] == null || row.after[key] == null ? null : row.after[key] - row.before[key]

async function main() {
  if (!args.model) {
    console.error('Usage: node scripts/measure-mmap.mjs --model <file.gguf> [--repeats 3]')
    process.exit(2)
  }
  const repeats = Number(args.repeats ?? 3)
  const samples = []
  for (let i = 0; i < repeats; i++)
    for (const mode of i % 2 ? ['off', 'on'] : ['on', 'off'])
      samples.push({ order: samples.length, ...(await sample(mode)) })
  const summarize = (useMmap) => {
    const rows = samples.filter((row) => row.useMmap === useMmap)
    const mib = (values) =>
      values.some((value) => value == null) ? null : Math.round(median(values) / MiB)
    return {
      loadMsMedian: median(rows.map((row) => row.loadMs)),
      loadMs: rows.map((row) => row.loadMs),
      rssMiBMedian: mib(rows.map((row) => row.rssBytes)),
      freeDeltaMiBMedian: mib(rows.map((row) => delta(row, 'freeBytes'))),
      availableDeltaMiBMedian: mib(rows.map((row) => delta(row, 'availableBytes'))),
      fileCacheDeltaMiBMedian: mib(rows.map((row) => delta(row, 'fileCacheBytes'))),
      gpuLayers: rows[0]?.gpuLayers
    }
  }
  const report = {
    version: 1,
    evidence: 'live-hardware',
    model: basename(args.model),
    modelBytes: statSync(args.model).size,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      totalMemoryBytes: totalmem(),
      gpu: samples[0]?.gpu
    },
    fileCache: 'not purged between samples (needs root); the GGUF is likely cached after sample 0',
    mmapOn: summarize(true),
    mmapOff: summarize(false),
    samples
  }
  console.log(JSON.stringify(report, null, 2))
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n')
}

if (args.child) await child()
else await main()
