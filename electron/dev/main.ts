import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, extname, basename } from 'path'
import { tmpdir } from 'os'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  appendFile,
  copyFile,
  rm,
  stat
} from 'fs/promises'
import { randomUUID } from 'crypto'
import { parseQuestions } from './questions'
import { captureQuestion } from './capture'
import type { DevProgress, DevResult } from '../../src/shared/eris-dev'

app.setName('Eris-Dev')
app.setPath('userData', join(app.getPath('appData'), 'Eris-Dev'))
let window: BrowserWindow | null = null
let questions: string[] = []
let project: string | null = null
let active: AbortController | null = null
let runDirectory: string | null = null
let completed = 0
const emit = (event: DevProgress) => {
  if (window && !window.isDestroyed()) window.webContents.send('dev:progress', event)
}
const skipped = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  'dist-dev',
  'out-dev',
  'vendor',
  'target',
  'build',
  '__pycache__'
])
async function snapshot(source: string, target: string): Promise<void> {
  let count = 0
  let bytes = 0
  async function visit(from: string, to: string) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (active?.signal.aborted) throw new Error('Cancelled')
      if (entry.name.startsWith('.') || skipped.has(entry.name) || entry.isSymbolicLink()) continue
      const src = join(from, entry.name),
        dst = join(to, entry.name)
      if (++count > 3000)
        throw new Error('Project exceeds 3,000 entries. Choose a smaller project folder.')
      if (entry.isDirectory()) await visit(src, dst)
      else if (entry.isFile()) {
        bytes += (await stat(src)).size
        if (bytes > 20 * 1024 * 1024)
          throw new Error('Project exceeds 20 MB. Choose a smaller source folder.')
        await copyFile(src, dst)
      }
    }
  }
  await visit(source, target)
}
async function run(context: number, mode: 'ask' | 'agent', controller: AbortController) {
  let workspace: string | undefined
  try {
    workspace = await mkdtemp(join(tmpdir(), 'eris-dev-'))
    if (project) await snapshot(project, workspace)
    else {
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({ name: 'debug-fixture', version: '1.0.0' })
      )
      await writeFile(
        join(workspace, 'index.js'),
        'export function divide(a, b) { return a / b }\n'
      )
    }
    for (let index = 0; index < questions.length && !controller.signal.aborted; index++) {
      const result = await captureQuestion(
        index,
        questions[index]!,
        workspace,
        context,
        mode,
        controller.signal
      )
      await writeFile(join(runDirectory!, `${index}.json`), JSON.stringify(result))
      await appendFile(join(runDirectory!, 'requests.jsonl'), JSON.stringify(result) + '\n')
      completed++
      const { requests: _requests, events: _events, task: _task, ...summary } = result
      emit({ running: true, completed, total: questions.length, result: summary })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } catch (error) {
    emit({ running: true, completed, total: questions.length, error: String(error) })
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
    active = null
    emit({ running: false, completed, total: questions.length })
  }
}
app.whenReady().then(() => {
  ipcMain.handle('dev:import', async () => {
    if (active) throw new Error('Stop the current run before importing.')
    const selected = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Chat questions', extensions: ['txt', 'json', 'jsonl'] }]
    })
    if (selected.canceled) return null
    const path = selected.filePaths[0]!
    if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error('Question file exceeds 20 MB.')
    const parsed = parseQuestions(await readFile(path, 'utf8'), extname(path).toLowerCase())
    questions = parsed
    return { name: basename(path), questions }
  })
  ipcMain.handle('dev:project', async () => {
    if (active) throw new Error('Stop the current run first.')
    const selected = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (selected.canceled) return project
    project = selected.filePaths[0]!
    return project
  })
  ipcMain.handle('dev:start', async (_event, input: { context?: number; mode?: string }) => {
    if (active || !questions.length)
      throw new Error('Import questions and finish the current run first.')
    if (
      ![4096, 8192, 16384, 32768].includes(input?.context ?? 0) ||
      !['ask', 'agent'].includes(input?.mode ?? '')
    )
      throw new Error('Invalid run settings.')
    const controller = new AbortController()
    active = controller
    completed = 0
    try {
      runDirectory = join(app.getPath('userData'), 'captures', randomUUID())
      await mkdir(runDirectory, { recursive: true })
      await writeFile(
        join(runDirectory, 'requests.jsonl'),
        JSON.stringify({
          format: 'eris-dev-capture-v1',
          created: new Date().toISOString(),
          project: project ?? 'sample fixture',
          context: input.context,
          mode: input.mode,
          total: questions.length,
          modelResponses: 'none; semantic intent uses deterministic fallback'
        }) + '\n'
      )
      emit({ running: true, completed, total: questions.length })
      void run(input.context!, input.mode as 'ask' | 'agent', controller)
    } catch (error) {
      active = null
      throw error
    }
  })
  ipcMain.handle('dev:stop', () => active?.abort())
  ipcMain.handle('dev:result', async (_event, index: number): Promise<DevResult> => {
    if (!Number.isInteger(index) || index < 0 || index >= completed || !runDirectory)
      throw new Error('Unknown capture.')
    return JSON.parse(await readFile(join(runDirectory, `${index}.json`), 'utf8'))
  })
  ipcMain.handle('dev:export', async () => {
    if (!runDirectory || active) throw new Error('Wait for the run to finish or stop it first.')
    const result = await dialog.showSaveDialog({ defaultPath: 'eris-dev-requests.jsonl' })
    if (result.canceled || !result.filePath) return null
    await copyFile(join(runDirectory, 'requests.jsonl'), result.filePath)
    return result.filePath
  })
  window = new BrowserWindow({
    width: 1400,
    height: 940,
    minWidth: 900,
    minHeight: 650,
    title: 'Eris-Dev',
    backgroundColor: '#10131a',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
})
app.on('window-all-closed', () => {
  active?.abort()
  app.quit()
})
