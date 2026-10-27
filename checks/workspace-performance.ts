import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCodeIndexAsync, findSymbols } from '../electron/main/services/code-index'
import { disposeWorkspaceWorkers } from '../electron/main/services/workspace-worker-client'
export { performanceQuantiles, evaluatePerformanceBudget } from '../src/shared/performance-budget'
import { performanceQuantiles } from '../src/shared/performance-budget'
/** Real production index and symbol API against synthetic files; no model or provider. */
export async function runWorkspacePerformance() {
  const root = await mkdtemp(join(tmpdir(), 'eris-index-perf-'))
  const files = 4000
  let bytes = 0
  try {
    for (let batch = 0; batch < 40; batch++) {
      const dir = join(root, `src-${batch}`)
      await mkdir(dir)
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          const n = batch * 100 + i,
            content =
              `export function fixture${n}(input:number){return input+${n}}\n` +
              '// representative source comment\n'.repeat(25)
          bytes += Buffer.byteLength(content)
          return writeFile(join(dir, `module-${n}.ts`), content)
        })
      )
    }
    const start = performance.now(),
      index = await buildCodeIndexAsync(root),
      initialIndexBuildMs = performance.now() - start
    if (index.files.length !== files) throw new Error('Index fixture did not include every file')
    const warm: number[] = [],
      query: number[] = []
    for (let i = 0; i < 3; i++) {
      const at = performance.now()
      await buildCodeIndexAsync(root)
      warm.push(performance.now() - at)
    }
    for (let i = 0; i < 20; i++) {
      const at = performance.now(),
        result = await findSymbols(root, `fixture${3700 + i}`, 1)
      query.push(performance.now() - at)
      if (!result.hits.length) throw new Error('Useful-evidence query returned no source')
    }
    return {
      fixtureVersion: 'eris-index-perf-1',
      files,
      bytes,
      initialIndexBuildMs,
      warmRebuildMs: performanceQuantiles(warm),
      usefulEvidenceMs: performanceQuantiles(query),
      mainRssBytes: process.memoryUsage().rss,
      workerMemoryBytes: null,
      liveModelCalls: 0,
      limits:
        'Initial build includes worker/parser startup; rebuilds use warm OS caches. Worker memory is not measured.'
    }
  } finally {
    await disposeWorkspaceWorkers()
    await rm(root, { recursive: true, force: true })
  }
}
