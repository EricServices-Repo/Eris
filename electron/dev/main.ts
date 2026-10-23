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
import { createHash, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { prepareQuestions } from './questions'
import { captureQuestion, captureSettings } from './capture'
import { snapshotPolicy, type SnapshotManifest } from './snapshot'
import {
  CAPTURE_FORMAT,
  type DevImportPreview,
  type DevProgress,
  type DevResult,
  type DevRunHeader,
  type IntentReplyMode
} from '../../src/shared/eris-dev'
import { PROMPT_VERSION, ROUTING_VERSION } from '../../src/shared/agent-versions'

app.setName('Eris-Dev')
app.setPath('userData', join(app.getPath('appData'), 'Eris-Dev'))
let window: BrowserWindow | null = null
let corpus: DevImportPreview | null = null
let project: string | null = null
/** sample: the built-in divide fixture; none: no workspace at all; project: a copied folder. */
let projectKind: 'sample' | 'none' | 'project' = 'sample'
let active: AbortController | null = null
let runDirectory: string | null = null
let completed = 0
const emit = (event: DevProgress) => {
  if (window && !window.isDestroyed()) window.webContents.send('dev:progress', event)
}
async function snapshot(source: string, target: string): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = { files: 0, bytes: 0, digest: '', omitted: new Map() }
  const hash = createHash('sha256')
  let count = 0
  async function visit(from: string, to: string, relativePath: string) {
    await mkdir(to, { recursive: true })
    const entries = (await readdir(from, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      if (active?.signal.aborted) throw new Error('Cancelled')
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name
      const decision = snapshotPolicy(rel, entry.isDirectory(), entry.isSymbolicLink())
      if (decision) {
        const omitted = manifest.omitted.get(decision) ?? { count: 0, examples: [] }
        omitted.count++
        if (omitted.examples.length < 10) omitted.examples.push(rel)
        manifest.omitted.set(decision, omitted)
        continue
      }
      const src = join(from, entry.name),
        dst = join(to, entry.name)
      if (++count > 3000)
        throw new Error('Project exceeds 3,000 entries. Choose a smaller project folder.')
      if (entry.isDirectory()) await visit(src, dst, rel)
      else if (entry.isFile()) {
        manifest.bytes += (await stat(src)).size
        if (manifest.bytes > 20 * 1024 * 1024)
          throw new Error('Project exceeds 20 MB. Choose a smaller source folder.')
        await copyFile(src, dst)
        hash
          .update(rel)
          .update('\0')
          .update(await readFile(dst))
          .update('\0')
        manifest.files++
      }
    }
  }
  await visit(source, target, '')
  manifest.digest = hash.digest('hex')
  return manifest
}

/** Build identity for the export header; unknown when not run from a Git checkout. */
function buildIdentity(): { gitSha: string; dirty: boolean | null } {
  try {
    const cwd = app.getAppPath()
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim().length > 0
    return { gitSha, dirty }
  } catch {
    return { gitSha: 'unknown', dirty: null }
  }
}

const SAMPLE_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'debug-fixture', version: '1.0.0' }),
  'index.js': 'export function divide(a, b) { return a / b }\n'
}

async function prepareWorkspace(): Promise<{
  workspace: string | null
  fixture: DevRunHeader['fixture']
}> {
  if (projectKind === 'none')
    return { workspace: null, fixture: { kind: 'none', digest: null, files: 0, omitted: [] } }
  const workspace = await mkdtemp(join(tmpdir(), 'eris-dev-'))
  if (projectKind === 'project' && project) {
    const manifest = await snapshot(project, workspace)
    return {
      workspace,
      fixture: {
        kind: 'project',
        digest: manifest.digest,
        files: manifest.files,
        omitted: [...manifest.omitted].map(([category, value]) => ({ category, ...value }))
      }
    }
  }
  const hash = createHash('sha256')
  for (const [name, content] of Object.entries(SAMPLE_FIXTURE)) {
    await writeFile(join(workspace, name), content)
    hash.update(name).update('\0').update(content).update('\0')
  }
  return {
    workspace,
    fixture: {
      kind: 'sample',
      digest: hash.digest('hex'),
      files: Object.keys(SAMPLE_FIXTURE).length,
      omitted: []
    }
  }
}

async function run(
  context: number,
  mode: 'ask' | 'agent',
  intentReplyMode: IntentReplyMode,
  controller: AbortController
) {
  let workspace: string | null = null
  const questions = corpus?.questions ?? []
  try {
    const prepared = await prepareWorkspace()
    workspace = prepared.workspace
    const header: DevRunHeader = {
      format: CAPTURE_FORMAT,
      created: new Date().toISOString(),
      app: { name: 'Eris-Dev', version: app.getVersion(), ...buildIdentity() },
      versions: { routing: ROUTING_VERSION, prompt: PROMPT_VERSION, schema: CAPTURE_FORMAT },
      settingsDigest: createHash('sha256')
        .update(JSON.stringify(captureSettings(context)))
        .digest('hex'),
      corpus: {
        id: corpus!.corpusId,
        name: corpus!.name,
        total: questions.length,
        excluded: corpus!.excluded.length
      },
      fixture: prepared.fixture,
      context,
      mode,
      intentReplyMode,
      responses: 'none',
      answerQuality: 'not-evaluated'
    }
    await writeFile(join(runDirectory!, 'requests.jsonl'), JSON.stringify(header) + '\n')
    for (let index = 0; index < questions.length && !controller.signal.aborted; index++) {
      const question = questions[index]!
      const result = await captureQuestion(
        index,
        question.text,
        workspace,
        context,
        mode,
        controller.signal,
        { question, intentReplyMode }
      )
      await writeFile(join(runDirectory!, `${index}.json`), JSON.stringify(result))
      await appendFile(join(runDirectory!, 'requests.jsonl'), JSON.stringify(result) + '\n')
      completed++
      const summary = {
        index: result.index,
        questionId: result.questionId,
        sourceLine: result.sourceLine,
        question: result.question,
        status: result.status,
        stages: result.stages,
        agent: result.agent,
        intent: result.intent,
        artifact: result.artifact,
        calls: result.calls,
        findings: result.findings,
        detail: result.detail
      }
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
    corpus = prepareQuestions(
      await readFile(path, 'utf8'),
      extname(path).toLowerCase(),
      basename(path)
    )
    return corpus
  })
  ipcMain.handle('dev:project-kind', (_event, kind: unknown) => {
    if (active) throw new Error('Stop the current run first.')
    if (kind !== 'sample' && kind !== 'none') throw new Error('Unknown project kind.')
    projectKind = kind
  })
  ipcMain.handle('dev:project', async () => {
    if (active) throw new Error('Stop the current run first.')
    const selected = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (selected.canceled) return project
    project = selected.filePaths[0]!
    projectKind = 'project'
    return project
  })
  ipcMain.handle(
    'dev:start',
    async (_event, input: { context?: number; mode?: string; intentReplyMode?: string }) => {
      if (active || !corpus?.questions.length)
        throw new Error('Import questions and finish the current run first.')
      if (
        ![4096, 8192, 16384, 32768].includes(input?.context ?? 0) ||
        !['ask', 'agent'].includes(input?.mode ?? '') ||
        !['fallback', 'malformed', 'timeout'].includes(input?.intentReplyMode ?? 'fallback')
      )
        throw new Error('Invalid run settings.')
      const controller = new AbortController()
      active = controller
      completed = 0
      try {
        runDirectory = join(app.getPath('userData'), 'captures', randomUUID())
        await mkdir(runDirectory, { recursive: true })
        emit({ running: true, completed, total: corpus.questions.length })
        void run(
          input.context!,
          input.mode as 'ask' | 'agent',
          (input.intentReplyMode ?? 'fallback') as IntentReplyMode,
          controller
        )
      } catch (error) {
        active = null
        throw error
      }
    }
  )
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
