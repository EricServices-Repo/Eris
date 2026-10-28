import { atomicEvidenceJson } from './evidence-records'
import {
  activeImageRuntime,
  publishImageRuntime,
  readImageSetupState,
  readRuntimeProvenance,
  requireImageDiskSpace,
  publishImageModel,
  imageSetupState,
  imageFailure,
  IMAGE_PROVENANCE_SCRIPT
} from './image-runtime-install'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { freemem, totalmem } from 'os'
import { z } from 'zod'
import type {
  LocalImageModel,
  LocalImageProgress,
  LocalImageStatus
} from '../../../src/shared/image-generation'
import { appResourcePath, userDataRoot } from './paths'
import { isPathInside, resolveInWorkspace } from './workspace-fs'
import { acquireInferenceLease } from './inference-governor'
import { disposeRuntime } from './builtin-model'
import { inferenceDevice } from './inference-device'

const ManifestSchema = z.object({
  repoId: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  pipeline: z.enum(['StableDiffusionPipeline', 'StableDiffusionXLPipeline']),
  variant: z.enum(['fp16']).nullable(),
  bytes: z.number().nonnegative(),
  downloadedAt: z.number(),
  files: z
    .array(
      z.object({
        path: z.string(),
        bytes: z.number().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
    )
    .min(1)
})
const RuntimeSchema = z.object({
  ready: z.literal(true),
  device: z.string(),
  deviceName: z.string()
})
let activity: 'setup' | 'download' | 'generate' | null = null
const processes = new Set<ChildProcess>()
const GIB = 1024 ** 3
export const LOCAL_IMAGE_GENERATION_TIMEOUT_MS = 3 * 60_000
export const localImageRoot = () => join(userDataRoot(), 'models', 'images')
export const localImageRuntimeRoot = () => join(userDataRoot(), 'image-runtime')
export const localImagePython = () => activeImageRuntime(localImageRuntimeRoot()).python

export const localImageModelId = (repoId: string) =>
  createHash('sha256').update(repoId).digest('hex').slice(0, 24)

export function normalizeImageRepo(input: string): string {
  const repo = input
    .trim()
    .replace(/^https:\/\/huggingface\.co\//i, '')
    .replace(/\/$/, '')
  if (
    repo.length > 160 ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Enter a Hugging Face repository such as stabilityai/sd-turbo')
  }
  return repo
}
function modelDirectory(repoId: string): string {
  const path = join(localImageRoot(), localImageModelId(repoId))
  if (!isPathInside(localImageRoot(), path)) throw new Error('Invalid local image model directory')
  return path
}

/** Fixed executables and argument arrays only. Prompts/tokens travel on stdin, never a shell. */
export async function runImageProcess(options: {
  command: string
  args: string[]
  input?: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (event: Record<string, unknown>) => void
}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted()
  await mkdir(localImageRuntimeRoot(), { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: localImageRuntimeRoot(),
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: '',
        PYTHONHOME: '',
        PYTHONUNBUFFERED: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
        HF_HUB_DOWNLOAD_TIMEOUT: '120',
        PIP_CACHE_DIR: join(localImageRuntimeRoot(), 'wheel-cache'),
        // PyTorch otherwise allows MPS to exceed the device's recommended working set. On
        // unified-memory Macs that can stall the whole desktop before Python reports an OOM.
        PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.75',
        PYTORCH_MPS_LOW_WATERMARK_RATIO: '0.60',
        PYTORCH_ENABLE_MPS_FALLBACK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    processes.add(child)
    let buffer = ''
    let errorText = ''
    let result: Record<string, unknown> = {}
    let protocolError = ''
    let stopped: Error | null = null
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      if (stopped) return
      stopped = error
      child.kill()
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
      forceKill.unref()
    }
    const abort = () =>
      stop(Object.assign(new Error('Local image operation stopped'), { name: 'AbortError' }))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => stop(new Error('Local image operation timed out')),
      options.timeoutMs ?? 900_000
    )
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 2 * 1024 * 1024) {
        stop(new Error('Local image worker response is too large'))
        return
      }
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.type === 'result') result = event.data as Record<string, unknown>
          else if (event.type === 'error') protocolError = String(event.error).slice(0, 2000)
          else if (event.type === 'progress') options.onProgress?.(event)
        } catch {
          /* pip output is ordinary text; only worker JSON is forwarded */
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorText = (errorText + chunk.toString('utf8')).slice(-4000)
    })
    child.stdin.on('error', () => undefined)
    let spawnError: Error | undefined
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (forceKill) clearTimeout(forceKill)
      processes.delete(child)
      options.signal?.removeEventListener('abort', abort)
      if (stopped) reject(stopped)
      else if (spawnError) reject(spawnError)
      else if (code !== 0 || protocolError)
        reject(
          new Error(
            protocolError ||
              errorText ||
              (signal
                ? `Image worker was stopped by ${signal}; the model may have exceeded available memory`
                : `Image worker exited with code ${code}`)
          )
        )
      else resolve(result)
    })
    child.stdin.end(options.input ? JSON.stringify(options.input) + '\n' : undefined)
    if (options.signal?.aborted) abort()
  })
}

async function worker(
  input: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (event: Record<string, unknown>) => void
) {
  return runImageProcess({
    command: localImagePython(),
    args: ['-I', appResourcePath('image-generation/worker.py')],
    input: {
      ...input,
      devicePreference: activeImageRuntime(localImageRuntimeRoot()).pointer?.backend
    },
    signal,
    onProgress,
    timeoutMs:
      input.operation === 'download'
        ? 3 * 60 * 60_000
        : input.operation === 'status'
          ? 30_000
          : LOCAL_IMAGE_GENERATION_TIMEOUT_MS
  })
}

export async function localImageStatus(): Promise<LocalImageStatus> {
  let runtime: LocalImageStatus['runtime'] = {
    ready: false,
    error: 'Set up the local image runtime (requires Python 3.10–3.12).'
  }
  try {
    if (existsSync(localImagePython()))
      runtime = RuntimeSchema.parse(
        JSON.parse(await readFile(activeImageRuntime(localImageRuntimeRoot()).readyPath, 'utf8'))
      )
  } catch {
    /* incomplete setup is not ready */
  }
  const models: LocalImageModel[] = []
  const dirs = await readdir(localImageRoot()).catch(() => [])
  for (const id of dirs) {
    if (!/^[a-f0-9]{24}$/.test(id)) continue
    try {
      const directory = join(localImageRoot(), id)
      const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'))
      )
      if (localImageModelId(manifest.repoId) !== id) continue
      const ready = manifest.files.every((file) => {
        const target = resolveInWorkspace(directory, file.path)
        return (
          isPathInside(directory, target) &&
          statSync(target).isFile() &&
          statSync(target).size === file.bytes
        )
      })
      models.push({
        id,
        repoId: manifest.repoId,
        revision: manifest.revision,
        pipeline: manifest.pipeline,
        variant: manifest.variant,
        bytes: manifest.bytes,
        downloadedAt: manifest.downloadedAt,
        ready
      })
    } catch {
      /* incomplete/corrupt downloads cannot be selected */
    }
  }
  models.sort((a, b) => b.downloadedAt - a.downloadedAt || a.id.localeCompare(b.id))
  runtime.setup = readImageSetupState(localImageRuntimeRoot())
  runtime.provenance = readRuntimeProvenance(localImageRuntimeRoot())
  return { runtime, models, activeModelId: models.find((model) => model.ready)?.id ?? null }
}

async function ensureRuntime(
  signal?: AbortSignal,
  emit?: (progress: LocalImageProgress) => void,
  force = false,
  requestedBackend: 'auto' | 'cpu' | 'cuda' = 'auto',
  reuseVersions = true
) {
  try {
    if (!force && existsSync(localImagePython())) {
      const status = RuntimeSchema.parse(await worker({ operation: 'status' }, signal))
      atomicEvidenceJson(activeImageRuntime(localImageRuntimeRoot()).readyPath, status)
      return
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  await requireImageDiskSpace(localImageRuntimeRoot(), (requestedBackend === 'cpu' ? 4 : 12) * GIB)
  imageSetupState(localImageRuntimeRoot(), {
    operation: 'setup',
    phase: 'checking',
    message: 'Checking Python and disk space'
  })
  emit?.({ operation: 'setup', message: 'Finding Python 3.10–3.12…' })
  const candidates =
    process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3.12'] },
          { command: 'py', args: ['-3.11'] },
          { command: 'python', args: [] }
        ]
      : [
          'python3.12',
          'python3.11',
          'python3.10',
          '/opt/homebrew/bin/python3.12',
          '/usr/local/bin/python3.12',
          'python3'
        ].map((command) => ({ command, args: [] as string[] }))
  let python: { command: string; args: string[] } | undefined
  for (const candidate of candidates) {
    try {
      await runImageProcess({
        command: candidate.command,
        args: [
          ...candidate.args,
          '-I',
          '-c',
          'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)'
        ],
        signal,
        timeoutMs: 10_000
      })
      python = candidate
      break
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  if (!python) throw new Error('Install Python 3.10, 3.11, or 3.12, then retry local image setup.')
  let cuda = requestedBackend === 'cuda'
  if (requestedBackend === 'auto' && process.platform !== 'darwin') {
    try {
      await runImageProcess({ command: 'nvidia-smi', args: ['-L'], signal, timeoutMs: 10000 })
      cuda = true
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  const backend = requestedBackend === 'cpu' ? 'cpu' : cuda ? 'cuda' : 'auto'
  await publishImageRuntime(
    localImageRuntimeRoot(),
    backend,
    async (stagedPython, environment) => {
      emit?.({ operation: 'setup', message: 'Creating a separate private runtime…' })
      await runImageProcess({
        command: python.command,
        args: [...python.args, '-I', '-m', 'venv', join(environment, 'venv')],
        signal
      })
      imageSetupState(localImageRuntimeRoot(), {
        operation: 'setup',
        phase: 'installing',
        message: `Installing the ${backend} dependency set`
      })
      const prior = activeImageRuntime(localImageRuntimeRoot()).pointer
      const packages = prior?.provenance.packages
      const constraints: string[] = []
      if (reuseVersions && prior?.backend === backend && packages && typeof packages === 'object') {
        const pins = Object.entries(packages)
          .filter(
            ([name, version]) =>
              /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) &&
              typeof version === 'string' &&
              /^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/.test(version)
          )
          .slice(0, 300)
          .map(([name, version]) => `${name}==${version}`)
        if (pins.length) {
          const path = join(environment, 'constraints.txt')
          await writeFile(path, pins.join('\n'))
          constraints.push('--constraint', path)
        }
      }
      const index =
        process.platform === 'darwin'
          ? []
          : ['--index-url', `https://download.pytorch.org/whl/${cuda ? 'cu128' : 'cpu'}`]
      await runImageProcess({
        command: stagedPython,
        args: [
          '-I',
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          'torch>=2.8,<3',
          'torchvision>=0.23,<1',
          ...constraints,
          ...index
        ],
        signal,
        timeoutMs: 30 * 60_000
      })
      emit?.({
        operation: 'setup',
        message: 'Installing image dependencies; wheel cache is retained for retries…'
      })
      await runImageProcess({
        command: stagedPython,
        args: [
          '-I',
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '-r',
          appResourcePath('image-generation/requirements.txt'),
          ...constraints
        ],
        signal,
        timeoutMs: 30 * 60_000
      })
      imageSetupState(localImageRuntimeRoot(), {
        operation: 'setup',
        phase: 'verifying',
        message: 'Checking imports, backend and installed-version provenance'
      })
      const ready = await runImageProcess({
        command: stagedPython,
        args: ['-I', appResourcePath('image-generation/worker.py')],
        input: { operation: 'status', devicePreference: backend },
        signal,
        timeoutMs: 30000
      })
      const provenance = await runImageProcess({
        command: stagedPython,
        args: ['-I', '-c', IMAGE_PROVENANCE_SCRIPT],
        signal,
        timeoutMs: 30000
      })
      return {
        ready,
        provenance: {
          ...provenance,
          requirementsDigest: createHash('sha256')
            .update(await readFile(appResourcePath('image-generation/requirements.txt')))
            .digest('hex')
        }
      }
    },
    signal
  )
}

async function exclusive<T>(
  kind: NonNullable<typeof activity>,
  task: () => Promise<T>
): Promise<T> {
  if (activity)
    throw new Error(
      `Local image ${activity} is in progress. Wait or cancel it before starting another operation.`
    )
  activity = kind
  try {
    return await task()
  } catch (error) {
    if (kind === 'generate') throw error
    const failure = imageFailure(error)
    imageSetupState(localImageRuntimeRoot(), {
      operation: kind,
      phase: failure.code === 'cancelled' ? 'cancelled' : 'error',
      ...failure
    })
    throw Object.assign(new Error(failure.message), {
      code: failure.code,
      name: failure.code === 'cancelled' ? 'AbortError' : 'Error'
    })
  } finally {
    activity = null
  }
}
export async function setupLocalImageRuntime(
  signal?: AbortSignal,
  emit?: (progress: LocalImageProgress) => void,
  backend: 'auto' | 'cpu' | 'cuda' = 'auto',
  reuseVersions = true
): Promise<LocalImageStatus> {
  return exclusive('setup', async () => {
    try {
      await ensureRuntime(signal, emit, true, backend, reuseVersions)
    } catch (error) {
      const failure = imageFailure(signal?.aborted ? new Error('cancelled') : error)
      imageSetupState(localImageRuntimeRoot(), {
        operation: 'setup',
        phase: failure.code === 'cancelled' ? 'cancelled' : 'error',
        ...failure
      })
      throw new Error(failure.message)
    }
    return localImageStatus()
  })
}
export async function downloadLocalImageModel(
  input: string,
  options: {
    token?: string | null
    signal?: AbortSignal
    onProgress?: (progress: LocalImageProgress) => void
  } = {}
): Promise<LocalImageStatus> {
  const repoId = normalizeImageRepo(input)
  return exclusive('download', async () => {
    await ensureRuntime(options.signal, options.onProgress)
    const status = await localImageStatus()
    if (status.models.some((model) => model.repoId === repoId && model.ready)) return status
    await mkdir(localImageRoot(), { recursive: true })
    const destination = modelDirectory(repoId)
    const directory = join(localImageRoot(), '.partial', localImageModelId(repoId))
    await requireImageDiskSpace(localImageRoot(), GIB)
    imageSetupState(localImageRuntimeRoot(), {
      operation: 'download',
      phase: 'downloading',
      message: `Downloading ${repoId}; partial data is retained for retry`
    })
    await mkdir(directory, { recursive: true })
    const result = await worker(
      { operation: 'download', repoId, modelPath: directory, token: options.token ?? null },
      options.signal,
      (event) => {
        options.onProgress?.({
          operation: 'download',
          repoId,
          message: String(event.message ?? 'Downloading…'),
          completed: typeof event.completed === 'number' ? event.completed : undefined,
          total: typeof event.total === 'number' ? event.total : undefined,
          unit: typeof event.unit === 'string' ? event.unit : undefined
        })
      }
    )
    options.signal?.throwIfAborted()
    const manifest = ManifestSchema.parse(result)
    if (manifest.repoId !== repoId) throw new Error('Downloaded model identity mismatch')
    await publishImageModel(directory, destination, manifest)
    imageSetupState(localImageRuntimeRoot(), {
      operation: 'download',
      phase: 'ready',
      message: `Verified ${repoId} download activated`
    })
    return localImageStatus()
  })
}
export async function deleteLocalImageModel(id: string): Promise<LocalImageStatus> {
  return exclusive('download', async () => {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid local image model id')
    const directory = join(localImageRoot(), id)
    if (!isPathInside(localImageRoot(), directory)) throw new Error('Invalid model path')
    await rm(directory, { recursive: true, force: true })
    return localImageStatus()
  })
}

export async function generateLocalImage(options: {
  prompt: string
  size: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<{ bytes: Buffer; model: string }> {
  return exclusive('generate', async () => {
    const status = await localImageStatus()
    if (!status.runtime.ready)
      throw new Error(
        status.runtime.error ?? 'Set up local image generation in Settings → Models → Image Models'
      )
    const selected = status.models.find((entry) => entry.id === status.activeModelId)
    if (!selected)
      throw new Error('Download a Hugging Face image model in Settings → Models → Image Models')
    const totalBytes = totalmem()
    // Darwin reports immediately free pages and omits some reclaimable cache. Keep the check
    // conservative without making ordinary SD-Turbo generation impossible on a healthy Mac.
    const freeBytes =
      process.platform === 'darwin' ? Math.max(freemem(), totalBytes * 0.2) : freemem()
    const initialHost = { totalBytes, freeBytes }
    const unsafeReason = localImageMemoryRisk(selected, status.runtime.device, initialHost)
    const model = unsafeReason
      ? status.models.find(
          (entry) => entry.ready && !localImageMemoryRisk(entry, status.runtime.device, initialHost)
        )
      : selected
    if (!model)
      throw new Error(
        unsafeReason ?? 'No downloaded image model fits the current system memory budget.'
      )
    if (model.id !== selected.id) {
      options.onProgress?.(
        `${selected.repoId} was skipped to protect system memory. Using ${model.repoId} instead.`
      )
    }
    const lease = await acquireInferenceLease({
      workload: 'image',
      owner: model.repoId,
      ...(status.runtime.device === 'cpu'
        ? { gpu: false }
        : await inferenceDevice(
            Math.ceil(model.bytes * 1.55 + 2 * GIB),
            status.runtime.deviceName
          )),
      onWait: (state) =>
        options.onProgress?.(
          `Queued for image generation: ${state.reason}. Stop cancels only this image request.`
        ),
      requestedBytes: Math.ceil(
        model.bytes * (model.pipeline === 'StableDiffusionXLPipeline' ? 1.55 : 1.25) + 2 * GIB
      ),
      gpu: status.runtime.device !== 'cpu',
      exclusiveGpu: true,
      priority: 10,
      signal: options.signal
    })
    let directory: string | null = null
    try {
      // The llama worker intentionally keeps its model loaded between chat steps. Once this
      // image job owns the GPU lease, release that idle runtime before measuring memory again.
      await disposeRuntime()
      const refreshedHost = {
        totalBytes: totalmem(),
        freeBytes: process.platform === 'darwin' ? Math.max(freemem(), totalmem() * 0.2) : freemem()
      }
      const refreshedRisk = localImageMemoryRisk(model, status.runtime.device, refreshedHost)
      if (refreshedRisk) throw new Error(refreshedRisk)
      directory = await mkdtemp(join(localImageRuntimeRoot(), 'generation-'))
      const output = join(directory, 'image.png')
      await worker(
        {
          operation: 'generate',
          repoId: model.repoId,
          modelPath: modelDirectory(model.repoId),
          variant: model.variant,
          prompt: options.prompt,
          size: options.size,
          outputPath: output,
          hostMemory: refreshedHost,
          memoryLimitBytes: Math.floor(refreshedHost.totalBytes * 0.6)
        },
        options.signal,
        (event) => options.onProgress?.(String(event.message ?? 'Generating locally…'))
      )
      options.signal?.throwIfAborted()
      if (!isPathInside(directory, output) || statSync(output).size > 20 * 1024 * 1024)
        throw new Error('Local image exceeds the output limit')
      return { bytes: await readFile(output), model: model.repoId }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
      lease.release()
    }
  })
}

/** Conservative preflight for shared-memory devices. The worker performs a second device check. */
export function localImageMemoryRisk(
  model: Pick<LocalImageModel, 'pipeline' | 'bytes' | 'repoId'>,
  device: string | undefined,
  memory: { totalBytes: number; freeBytes: number }
): string | null {
  const isSdxl = model.pipeline === 'StableDiffusionXLPipeline'
  const sharedMemory = device === 'mps' || device === 'cpu'
  if (!sharedMemory) return null
  const minimumTotal = isSdxl ? 24 * GIB : 12 * GIB
  const minimumFree = isSdxl ? 6 * GIB : 3 * GIB
  const estimatedWorkingSet = model.bytes * (isSdxl ? 1.55 : 1.25) + 2 * GIB
  if (
    memory.totalBytes < minimumTotal ||
    memory.freeBytes < minimumFree ||
    estimatedWorkingSet > memory.totalBytes * 0.68
  ) {
    const family = isSdxl ? 'SDXL' : 'Stable Diffusion'
    return `${family} is not safe to load with the available unified memory. Close memory-heavy apps or use SD-Turbo. Eris blocked this generation to keep the Mac responsive.`
  }
  return null
}

export function stopLocalImageProcesses(): void {
  for (const child of processes) child.kill('SIGKILL')
}
