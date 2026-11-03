#!/usr/bin/env node
/**
 * RAM-CTX-062 (#234) gain measurement: lexical vs CPU embedding vs fused recall on the
 * labelled paraphrase set (checks/paraphrase-recall.ts). The model runs through
 * node-llama-cpp with the GPU disabled, so no VRAM is touched.
 *
 *   npx vite build --config checks/vite.performance-node.config.ts
 *   node scripts/measure-embedding-recall.mjs --model <embedding.gguf> \
 *        [--query-prefix "search_query: "] [--doc-prefix "search_document: "] [--out report.json]
 *
 * Without --model it reports the lexical path alone.
 */
import { createHash } from 'node:crypto'
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, totalmem } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, [])
)
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { measureEmbeddingRecall } = require(
  resolve(here, '../.eris/cache/performance/embedding-recall.cjs')
)

const sha256 = (path) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
      .on('error', fail)
  })

let embedder = null
let model = null
let llamaInfo = null
if (args.model) {
  const { getLlama } = await import('node-llama-cpp')
  const llama = await getLlama({ gpu: false })
  const loaded = await llama.loadModel({ modelPath: args.model, gpuLayers: 0 })
  const context = await loaded.createEmbeddingContext()
  const queryPrefix = args['query-prefix'] ?? ''
  const docPrefix = args['doc-prefix'] ?? ''
  const digest = await sha256(args.model)
  const dimensions = loaded.embeddingVectorSize
  const space = {
    indexVersion: 1,
    provider: 'node-llama-cpp-cpu',
    model: `${basename(args.model)}@${digest.slice(0, 16)}`,
    dimensions,
    tokenizer: `gguf:${JSON.stringify([queryPrefix, docPrefix])}`
  }
  const embed = async (text) => ({
    vector: [...(await context.getEmbeddingFor(text)).vector],
    space
  })
  embedder = {
    space,
    query: (text) => embed(queryPrefix + text),
    document: (text) => embed(docPrefix + text)
  }
  model = {
    file: basename(args.model),
    sha256: digest,
    bytes: statSync(args.model).size,
    dimensions,
    queryPrefix,
    docPrefix,
    gpuLayers: 0
  }
  llamaInfo = { gpu: llama.gpu, buildType: llama.buildType }
}

const report = await measureEmbeddingRecall(embedder)
const pkg = require(resolve(here, '../node_modules/node-llama-cpp/package.json'))
const out = {
  ...report,
  model,
  runtime: { nodeLlamaCpp: pkg.version, node: process.version, llama: llamaInfo },
  host: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    totalMemoryBytes: totalmem()
  },
  command: `node scripts/measure-embedding-recall.mjs ${process.argv.slice(2).join(' ')}`
}
const text = JSON.stringify(out, null, 2)
console.log(text)
if (args.out) writeFileSync(args.out, text + '\n')
process.exit(0)
