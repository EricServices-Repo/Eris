import { ipcMain } from 'electron'
import {
  buildCodeIndexAsync,
  findReferences,
  findSymbols,
  formatIndexSummary,
  loadCodeIndex,
  relatedFiles
} from '../services/code-index'
import { workspaceGlob, workspaceGrep } from '../services/workspace-search'
import { inspectWorkspace } from '../services/workspace-intelligence'
import { appState } from '../app-state'
import { listRules } from '../services/rules'
import { listSkills } from '../services/skills'

export function registerSearchIpc(): void {
  ipcMain.handle('search:grep', async (_e, pattern: string, glob?: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
    return workspaceGrep(appState.currentWorkspace, pattern, { glob })
  })

  ipcMain.handle('search:glob', (_e, pattern: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return workspaceGlob(appState.currentWorkspace, pattern)
  })

  ipcMain.handle('search:symbols', (_e, query: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
    return findSymbols(appState.currentWorkspace, query)
  })
  ipcMain.handle('search:references', (_e, name: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
    return findReferences(appState.currentWorkspace, name)
  })
  ipcMain.handle('search:related', (_e, path: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return relatedFiles(appState.currentWorkspace, path)
  })

  ipcMain.handle('search:retrieve', async (_e, query: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return inspectWorkspace(appState.currentWorkspace, query)
  })

  ipcMain.handle('index:rebuild', async () => {
    if (!appState.currentWorkspace) return { ok: false, files: 0, symbols: 0 }
    const record = await buildCodeIndexAsync(appState.currentWorkspace)
    return { ok: true, files: record.files.length, symbols: record.symbols.length }
  })

  ipcMain.handle('index:stats', async () => {
    const workspace = appState.currentWorkspace
    if (!workspace) {
      return {
        ok: false,
        files: 0,
        symbols: 0,
        refs: 0,
        summary: '',
        topSymbols: [] as Array<{ name: string; kind: string; path: string; line: number }>,
        rules: 0,
        skills: 0
      }
    }
    let record = loadCodeIndex(workspace)
    if (!record) {
      record = await buildCodeIndexAsync(workspace)
    }
    const symbols = [...record.symbols]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 80)
      .map((s) => ({ name: s.name, kind: s.kind, path: s.path, line: s.line }))
    return {
      ok: true,
      files: record.files.length,
      symbols: record.symbols.length,
      refs: record.refs?.length ?? 0,
      summary: formatIndexSummary(workspace),
      topSymbols: symbols,
      rules: listRules(workspace).length,
      skills: listSkills(workspace).length
    }
  })
}
