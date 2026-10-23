import { createReadStream, createWriteStream, realpathSync } from 'fs'
import { createInterface } from 'readline'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, extname, basename } from 'path'
import { homedir, tmpdir } from 'os'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  appendFile,
  copyFile,
  rename,
  rm,
  stat
} from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { migrateLegacyIdentity, prepareQuestions } from './questions'
import { captureQuestion, captureSettings } from './capture'
import { snapshotPolicy, type SnapshotManifest } from './snapshot'
import { CaptureSanitizer, REDACTION_LIMITATIONS } from './sanitize'
import {
  caseRecordProblem,
  listRuns,
  markInterruptedRuns,
  preserveAttempt,
  readManifest,
  readProgress,
  resumeConflicts,
  resumePoint,
  writeCaseRecord,
  writeManifest,
  writeProgress,
  type RunManifest,
  type RunProgress
} from './runs'
import {
  compareCaptures,
  runCompatibility,
  type CaptureComparison
} from '../../src/shared/eris-dev-compare'
import {
  CAPTURE_FORMAT,
  LEGACY_CAPTURE_FORMAT,
  type DevImportPreview,
  type DevProgress,
  type DevResult,
  type DevRunHeader,
  type DevSummary,
  type IntentReplyMode,
  CAPTURE_COVERAGE,
  readCaptureRecord
} from '../../src/shared/eris-dev'
import {
  EVALUATION_VERSION,
  INVARIANT_VERSION,
  PROMPT_VERSION,
  ROUTING_VERSION
} from '../../src/shared/agent-versions'

/** Stamped by electron.dev.config.ts at build time; absent under plain `electron-vite dev`. */
declare const __ERIS_DEV_BUILD__:
  { gitSha: string; dirty: boolean | null; dirtyDigest: string | null; buildId: string } | undefined

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

type BuildIdentity = Pick<
  DevRunHeader['app'],
  'gitSha' | 'dirty' | 'dirtyDigest' | 'buildId' | 'provenance'
>

/**
 * Build identity for the export header. A packaged app carries the revision stamped
 * at build time; a development run reads its checkout; otherwise it stays unknown.
 */
function buildIdentity(): BuildIdentity {
  if (typeof __ERIS_DEV_BUILD__ !== 'undefined' && __ERIS_DEV_BUILD__)
    return { ...__ERIS_DEV_BUILD__, provenance: 'injected' }
  try {
    const cwd = app.getAppPath()
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()
    const diff = status
      ? execFileSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
      : ''
    return {
      gitSha,
      dirty: status.length > 0,
      dirtyDigest: status
        ? createHash('sha256').update(status).update(diff).digest('hex').slice(0, 16)
        : null,
      provenance: 'git'
    }
  } catch {
    return { gitSha: 'unknown', dirty: null, dirtyDigest: null, provenance: 'unknown' }
  }
}

/**
 * Everything that decides what a capture records: behavior versions, the record
 * schema, and the source revision. A forgotten version bump still changes this.
 */
function harnessFingerprint(identity: BuildIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        CAPTURE_FORMAT,
        ROUTING_VERSION,
        PROMPT_VERSION,
        INVARIANT_VERSION,
        EVALUATION_VERSION,
        identity.gitSha,
        identity.dirtyDigest ?? null
      ])
    )
    .digest('hex')
    .slice(0, 16)
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
  // This function owns the snapshot until it returns it; a failed copy removes it.
  try {
    return await fillWorkspace(workspace)
  } catch (error) {
    await rm(workspace, { recursive: true, force: true }).catch((cleanup) =>
      console.error('Eris-Dev could not remove a failed snapshot:', workspace, cleanup)
    )
    throw error
  }
}

async function fillWorkspace(workspace: string): Promise<{
  workspace: string | null
  fixture: DevRunHeader['fixture']
}> {
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

const capturesDir = () => join(app.getPath('userData'), 'captures')
const COMPARISON_PAGE = 200

/** What the renderer list needs; full bodies stay on disk until a case is opened. */
function summaryOf(result: DevResult): DevSummary {
  return {
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
    findingIds: result.findingsDetail.map((finding) => finding.id),
    detail: result.detail
  }
}

function headerFor(
  context: number,
  mode: 'ask' | 'agent',
  intentReplyMode: IntentReplyMode,
  fixture: DevRunHeader['fixture']
): DevRunHeader {
  const identity = buildIdentity()
  return {
    format: CAPTURE_FORMAT,
    created: new Date().toISOString(),
    app: { name: 'Eris-Dev', version: app.getVersion(), ...identity },
    versions: {
      routing: ROUTING_VERSION,
      prompt: PROMPT_VERSION,
      schema: CAPTURE_FORMAT,
      invariants: INVARIANT_VERSION,
      evaluation: EVALUATION_VERSION,
      harness: harnessFingerprint(identity)
    },
    settingsDigest: settingsDigest(context),
    corpus: {
      id: corpus!.corpusId,
      name: corpus!.name,
      total: corpus!.questions.length,
      excluded: corpus!.excluded.length
    },
    fixture,
    context,
    mode,
    intentReplyMode,
    responses: 'none',
    answerQuality: 'not-evaluated',
    coverage: CAPTURE_COVERAGE
  }
}

const settingsDigest = (context: number) =>
  createHash('sha256')
    .update(JSON.stringify(captureSettings(context)))
    .digest('hex')

async function run(
  dir: string,
  manifest: RunManifest,
  startIndex: number,
  workspace: string | null,
  controller: AbortController
) {
  const { questions, config } = manifest
  completed = startIndex
  let progress: RunProgress = {
    ...(readProgress(dir) ?? { completed: 0, rewritten: [], resumedAt: [] }),
    state: 'running',
    completed,
    updatedAt: new Date().toISOString()
  }
  writeProgress(dir, progress)
  try {
    for (let index = startIndex; index < questions.length && !controller.signal.aborted; index++) {
      const question = questions[index]!
      const result = await captureQuestion(
        index,
        question.text,
        workspace,
        config.context,
        config.mode,
        controller.signal,
        { question, intentReplyMode: config.intentReplyMode }
      )
      // A question stopped mid-capture is not completed evidence. Keep the attempt
      // beside the case and leave the case itself missing, so resume runs it again.
      if (result.status === 'cancelled') {
        const attempt = preserveAttempt(dir, index, result)
        progress = {
          ...progress,
          interruptedAttempts: [...(progress.interruptedAttempts ?? []), attempt]
        }
        break
      }
      writeCaseRecord(dir, index, result)
      await appendFile(join(dir, 'requests.jsonl'), JSON.stringify(result) + '\n')
      completed++
      progress = { ...progress, completed, updatedAt: new Date().toISOString() }
      writeProgress(dir, progress)
      emit({ running: true, completed, total: questions.length, result: summaryOf(result) })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    progress = {
      ...progress,
      state: completed >= questions.length ? 'completed' : 'stopped'
    }
  } catch (error) {
    progress = { ...progress, state: 'stopped' }
    emit({ running: true, completed, total: questions.length, error: String(error) })
  } finally {
    writeProgress(dir, { ...progress, updatedAt: new Date().toISOString() })
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
    active = null
    emit({ running: false, completed, total: questions.length })
  }
}

/** One persisted case at a time, so exports and comparisons never hold the whole run. */
async function* eachRunRecord(indices?: number[]): AsyncGenerator<DevResult> {
  const wanted = indices ?? Array.from({ length: completed }, (_, index) => index)
  for (const index of wanted) {
    if (!Number.isInteger(index) || index < 0 || index >= completed) continue
    yield JSON.parse(await readFile(join(runDirectory!, `${index}.json`), 'utf8')) as DevResult
  }
}

/** Write JSONL to a temporary file and rename it into place only when complete. */
async function writeJsonl(path: string, items: AsyncIterable<unknown>): Promise<number> {
  const temporary = `${path}.partial-${randomUUID()}`
  const out = createWriteStream(temporary, { encoding: 'utf8' })
  let count = 0
  try {
    for await (const item of items) {
      if (!out.write(JSON.stringify(item) + '\n'))
        await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      count++
    }
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve()))
    )
    await rename(temporary, path)
    return count
  } catch (error) {
    out.destroy()
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read an export line by line. The first line is a run header when it has a known
 * format; a file without one is a legacy export whose records start on line 1.
 */
async function readExport(path: string): Promise<{
  header: Partial<DevRunHeader> | null
  records: DevResult[]
}> {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  let header: Partial<DevRunHeader> | null = null
  const records: DevResult[] = []
  let lineNumber = 0
  for await (const line of lines) {
    lineNumber++
    if (!line.trim()) continue
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`Line ${lineNumber} of the export is not valid JSON.`)
    }
    if (lineNumber === 1 && typeof value.format === 'string') {
      if (value.format !== CAPTURE_FORMAT && value.format !== LEGACY_CAPTURE_FORMAT)
        throw new Error(`Unknown export format “${value.format}”.`)
      header = value as Partial<DevRunHeader>
      continue
    }
    if (lineNumber === 1 && !('question' in value))
      throw new Error('The export has no run header and its first line is not a capture record.')
    records.push(readCaptureRecord(value))
  }
  return { header, records }
}

/** The most recent full comparison, paged to the renderer and saved beside the run. */
let lastComparison: (CaptureComparison & { path: string }) | null = null

app.whenReady().then(() => {
  // A run still marked running belongs to a process that did not finish it.
  markInterruptedRuns(capturesDir())
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
      let workspace: string | null = null
      // The selected run, its directory and count change only once this run exists,
      // so a failed preparation leaves the previously open run intact.
      const runId = randomUUID()
      const dir = join(capturesDir(), runId)
      try {
        await mkdir(dir, { recursive: true })
        const prepared = await prepareWorkspace()
        workspace = prepared.workspace
        const config: RunManifest['config'] = {
          context: input.context!,
          mode: input.mode as 'ask' | 'agent',
          intentReplyMode: (input.intentReplyMode ?? 'fallback') as IntentReplyMode,
          projectKind,
          project
        }
        const manifest: RunManifest = {
          runId,
          header: headerFor(config.context, config.mode, config.intentReplyMode, prepared.fixture),
          questions: corpus.questions,
          config
        }
        writeManifest(dir, manifest)
        await writeFile(join(dir, 'requests.jsonl'), JSON.stringify(manifest.header) + '\n')
        runDirectory = dir
        completed = 0
        emit({ running: true, completed, total: corpus.questions.length })
        void run(dir, manifest, 0, workspace, controller)
      } catch (error) {
        if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        active = null
        throw error
      }
    }
  )
  ipcMain.handle('dev:runs', () => listRuns(capturesDir()))
  ipcMain.handle('dev:resume', async (_event, runId: unknown) => {
    if (active) throw new Error('Stop the current run first.')
    if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Unknown run.')
    // Reserve the operation before the first await, so a second start, resume or
    // import cannot interleave with this one's preparation.
    const controller = new AbortController()
    active = controller
    let workspace: string | null = null
    let started = false
    const previous = { projectKind, project }
    try {
      const dir = join(capturesDir(), runId)
      const manifest = readManifest(dir)
      const progress = readProgress(dir)
      if (!manifest || !progress) throw new Error('This run has no resumable manifest.')
      if (progress.state === 'completed') throw new Error('This run already completed.')
      projectKind = manifest.config.projectKind
      project = manifest.config.project
      const prepared = await prepareWorkspace()
      workspace = prepared.workspace
      if (controller.signal.aborted) throw new Error('Resume cancelled during preparation.')
      // Resuming with other settings, versions, harness or source would mix two runs.
      const conflicts = resumeConflicts(manifest.header, {
        settingsDigest: settingsDigest(manifest.config.context),
        routing: ROUTING_VERSION,
        prompt: PROMPT_VERSION,
        fixtureDigest: prepared.fixture.digest,
        harness: harnessFingerprint(buildIdentity())
      })
      if (conflicts.length) throw new Error(`This run cannot be resumed: ${conflicts.join('; ')}.`)
      const { next, unreadable, invalid } = resumePoint(dir, manifest.questions)
      // Rebuild the JSONL from the validated per-case files, so a partly written line is not kept.
      await writeJsonl(
        join(dir, 'requests.jsonl'),
        (async function* () {
          yield manifest.header
          for (let index = 0; index < next; index++)
            yield JSON.parse(await readFile(join(dir, `${index}.json`), 'utf8'))
        })()
      )
      const done: DevSummary[] = []
      for (let index = 0; index < next; index++)
        done.push(summaryOf(JSON.parse(await readFile(join(dir, `${index}.json`), 'utf8'))))
      writeProgress(dir, {
        ...progress,
        completed: next,
        rewritten: [...progress.rewritten, ...unreadable, ...invalid.map((item) => item.index)],
        invalid: [...(progress.invalid ?? []), ...invalid],
        resumedAt: [...progress.resumedAt, new Date().toISOString()],
        updatedAt: new Date().toISOString()
      })
      corpus = {
        name: manifest.header.corpus.name,
        corpusId: manifest.header.corpus.id,
        questions: manifest.questions,
        excluded: [],
        normalization: []
      }
      runDirectory = dir
      started = true
      void run(dir, manifest, next, workspace, controller)
      return { corpus, next, results: done, invalid }
    } finally {
      // Until run() takes the workspace and the lock, this handler owns both.
      if (!started) {
        if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
        ;({ projectKind, project } = previous)
        active = null
      }
    }
  })
  // FR-029: open any run read-only, completed ones included, without running it.
  ipcMain.handle('dev:open', async (_event, runId: unknown) => {
    if (active) throw new Error('Stop the current run first.')
    if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Unknown run.')
    const dir = join(capturesDir(), runId)
    const manifest = readManifest(dir)
    const progress = readProgress(dir)
    if (!manifest || !progress) throw new Error('This run has no manifest.')
    const results: DevSummary[] = []
    const invalid: Array<{ index: number; reason: string }> = []
    for (let index = 0; index < progress.completed; index++) {
      try {
        const record = JSON.parse(await readFile(join(dir, `${index}.json`), 'utf8')) as DevResult
        const problem = caseRecordProblem(record, index, manifest.questions[index])
        if (problem) {
          invalid.push({ index, reason: problem })
          break
        }
        results.push(summaryOf(record))
      } catch {
        invalid.push({ index, reason: 'unreadable' })
        break
      }
    }
    corpus = {
      name: manifest.header.corpus.name,
      corpusId: manifest.header.corpus.id,
      questions: manifest.questions,
      excluded: [],
      normalization: []
    }
    runDirectory = dir
    completed = results.length
    return { corpus, header: manifest.header, state: progress.state, results, invalid }
  })
  ipcMain.handle('dev:stop', () => active?.abort())
  ipcMain.handle('dev:result', async (_event, index: number): Promise<DevResult> => {
    if (!Number.isInteger(index) || index < 0 || index >= completed || !runDirectory)
      throw new Error('Unknown capture.')
    return JSON.parse(await readFile(join(runDirectory, `${index}.json`), 'utf8'))
  })
  ipcMain.handle(
    'dev:export',
    async (_event, input?: { sanitized?: boolean; indices?: number[] }) => {
      if (!runDirectory || active) throw new Error('Wait for the run to finish or stop it first.')
      const sanitized = input?.sanitized === true
      const selection = Array.isArray(input?.indices) ? input!.indices : undefined
      const result = await dialog.showSaveDialog({
        defaultPath: `eris-dev-requests${selection ? '-selection' : ''}${sanitized ? '.sanitized' : ''}.jsonl`
      })
      if (result.canceled || !result.filePath) return null
      const header = readManifest(runDirectory)?.header
      // A fresh linkage key per export: markers match within this file only.
      const sanitizer = new CaptureSanitizer({
        homeDir: homedir(),
        tmpRoots: [tmpdir(), realpathSync(tmpdir())]
      })
      // Streamed record by record and renamed into place only when complete.
      const records = await writeJsonl(
        result.filePath,
        (async function* () {
          yield {
            ...header,
            ...(selection ? { selection: selection.length } : {}),
            // The manifest is written up front; counts arrive in the summary below.
            ...(sanitized
              ? {
                  redaction: {
                    policy: sanitizer.manifest().policy,
                    limitations: REDACTION_LIMITATIONS
                  }
                }
              : {})
          }
          for await (const record of eachRunRecord(selection))
            yield sanitized ? sanitizer.value(record) : record
        })()
      )
      const redaction = sanitized ? sanitizer.manifest() : undefined
      if (redaction)
        await writeFile(`${result.filePath}.redaction.json`, JSON.stringify(redaction, null, 2))
      return { path: result.filePath, records: records - 1, redaction }
    }
  )
  ipcMain.handle('dev:compare', async () => {
    if (!runDirectory || active) throw new Error('Finish or stop the current run before comparing.')
    const selected = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Eris-Dev export', extensions: ['jsonl'] }]
    })
    if (selected.canceled) return null
    const earlier = await readExport(selected.filePaths[0]!)
    const current = readManifest(runDirectory)?.header
    if (!current) throw new Error('The current run has no header to compare against.')
    // v1 records have no IDs; give them the IDs their text gets today.
    const legacy = migrateLegacyIdentity(earlier.records)
    const after: DevResult[] = []
    for await (const record of eachRunRecord()) after.push(record)
    const comparison = compareCaptures(legacy.records, after)
    const path = join(runDirectory, `comparison-${Date.now()}.json`)
    const compatibility = runCompatibility(
      earlier.header?.format === CAPTURE_FORMAT ? earlier.header : null,
      current
    )
    const full = {
      file: basename(selected.filePaths[0]!),
      compatibility,
      identity: { legacyMigrated: legacy.migrated, ambiguous: legacy.ambiguous },
      ...comparison
    }
    await writeFile(path, JSON.stringify(full))
    lastComparison = { ...comparison, path }
    return {
      ...full,
      changed: comparison.changed.slice(0, COMPARISON_PAGE),
      page: {
        offset: 0,
        size: COMPARISON_PAGE,
        returned: Math.min(COMPARISON_PAGE, comparison.totalChanged)
      },
      savedTo: path
    }
  })
  // Every changed question stays reachable: page through the saved comparison.
  ipcMain.handle('dev:compare-page', (_event, offset: unknown) => {
    if (!lastComparison) throw new Error('Run a comparison first.')
    if (!Number.isInteger(offset) || (offset as number) < 0) throw new Error('Invalid page.')
    const start = offset as number
    const changed = lastComparison.changed.slice(start, start + COMPARISON_PAGE)
    return {
      changed,
      page: { offset: start, size: COMPARISON_PAGE, returned: changed.length },
      totalChanged: lastComparison.totalChanged
    }
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
