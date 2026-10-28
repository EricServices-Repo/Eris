import { existsSync } from 'fs'
import { mkdir, rename, rm, statfs, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { atomicEvidenceJson, readEvidence } from './evidence-records'
export const IMAGE_DEPENDENCY_SET = 'eris-image-constraints-1'
const Pointer = z.object({
  version: z.literal(1),
  environmentId: z.string().uuid(),
  backend: z.enum(['auto', 'cpu', 'cuda']),
  publishedAt: z.number(),
  dependencySet: z.string(),
  provenance: z.record(z.string(), z.unknown())
})
export function imageRuntimePointer(root: string) {
  return readEvidence(join(root, 'current.json'), (v) => Pointer.parse(v))
}
export function environmentPython(root: string, id?: string) {
  return join(
    root,
    ...(id ? ['environments', id] : []),
    'venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  )
}
export function activeImageRuntime(root: string) {
  const pointer = imageRuntimePointer(root)
  return {
    pointer,
    python: environmentPython(root, pointer?.environmentId),
    readyPath: join(root, ...(pointer ? ['environments', pointer.environmentId] : []), 'ready.json')
  }
}
export function imageFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const code = /disk|space|ENOSPC/i.test(message)
    ? 'disk'
    : /401|403|gated|unauthor|forbidden/i.test(message)
      ? 'auth'
      : /404|not found.*repo|repository.*not found/i.test(message)
        ? 'repository'
        : /CUDA|driver|cudnn/i.test(message)
          ? 'driver'
          : /No matching distribution|wheel|Python|dependencies|ModuleNotFound/i.test(message)
            ? 'dependencies'
            : /abort|stopped|cancel/i.test(message)
              ? 'cancelled'
              : 'setup'
  const guidance = {
    disk: 'Free disk space and retry. Existing verified models and the active runtime were retained.',
    auth: 'Accept the Hugging Face model license and configure an authorized token, then retry.',
    repository: 'Check the repository name and access permissions.',
    driver:
      'Check the NVIDIA driver or explicitly select CPU setup. No heavyweight fallback is retried automatically.',
    dependencies:
      'Use Python 3.10–3.12 and a supported wheel platform, then repair the private environment.',
    cancelled:
      'Operation stopped. Retry reuses the download/wheel cache; the active runtime was retained.',
    setup: 'Repair the private runtime or retry the download. Existing verified data was retained.'
  }[code]
  return { code, message: guidance }
}
export function imageSetupState(
  root: string,
  state: { operation: 'setup' | 'download'; phase: string; message: string; code?: string }
) {
  atomicEvidenceJson(join(root, 'setup-state.json'), {
    ...state,
    updatedAt: Date.now(),
    dependencySet: IMAGE_DEPENDENCY_SET
  })
}
export function readImageSetupState(root: string) {
  return (
    readEvidence(join(root, 'setup-state.json'), (v) =>
      z
        .object({
          operation: z.enum(['setup', 'download']),
          phase: z.string(),
          message: z.string(),
          code: z.string().optional(),
          updatedAt: z.number(),
          dependencySet: z.string()
        })
        .parse(v)
    ) ?? undefined
  )
}
export async function requireImageDiskSpace(root: string, bytes: number) {
  await mkdir(root, { recursive: true })
  const stat = await statfs(root)
  const available = Number(stat.bavail) * Number(stat.bsize)
  if (!Number.isFinite(available) || available < bytes)
    throw new Error(
      `Insufficient disk space: need ${(bytes / 1024 ** 3).toFixed(1)} GiB free for staged setup/download`
    )
}
/** Stable environment paths avoid relocating venv shebangs. Only the pointer is atomically replaced. */
export async function publishImageRuntime(
  root: string,
  backend: 'auto' | 'cpu' | 'cuda',
  build: (
    python: string,
    environment: string
  ) => Promise<{ ready: unknown; provenance: Record<string, unknown> }>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const id = randomUUID(),
    environment = join(root, 'environments', id),
    python = environmentPython(root, id)
  await mkdir(environment, { recursive: true })
  imageSetupState(root, {
    operation: 'setup',
    phase: 'creating',
    message: 'Preparing a separate environment; current runtime stays available'
  })
  try {
    const result = await build(python, environment)
    signal?.throwIfAborted()
    if (!existsSync(python)) throw new Error('Private Python environment is incomplete')
    const ready = z
      .object({ ready: z.literal(true), device: z.string(), deviceName: z.string() })
      .passthrough()
      .parse(result.ready)
    if (backend === 'cuda' && ready.device !== 'cuda')
      throw new Error(
        'CUDA driver/runtime verification failed; choose CPU explicitly or repair the driver'
      )
    atomicEvidenceJson(join(environment, 'ready.json'), ready)
    const pointer = Pointer.parse({
      version: 1,
      environmentId: id,
      backend,
      publishedAt: Date.now(),
      dependencySet: IMAGE_DEPENDENCY_SET,
      provenance: result.provenance
    })
    imageSetupState(root, {
      operation: 'setup',
      phase: 'ready',
      message: `Verified ${ready.device} environment activated`
    })
    // Commit last: no fallible metadata write may delete an already activated environment.
    atomicEvidenceJson(join(root, 'current.json'), pointer)
    return pointer
  } catch (error) {
    const failure = imageFailure(signal?.aborted ? new Error('cancelled') : error)
    imageSetupState(root, {
      operation: 'setup',
      phase: failure.code === 'cancelled' ? 'cancelled' : 'error',
      ...failure
    })
    await rm(environment, { recursive: true, force: true }).catch(() => {})
    throw Object.assign(new Error(failure.message), { code: failure.code, cause: error })
  }
}
/** Staged download publication never deletes the previous directory before verification. */
export async function publishImageModel(staging: string, destination: string, manifest: unknown) {
  const backup = destination + '.previous-' + randomUUID()
  let moved = false
  await writeFile(join(staging, 'ready.json.tmp'), JSON.stringify(manifest))
  await rename(join(staging, 'ready.json.tmp'), join(staging, 'ready.json'))
  try {
    if (existsSync(destination)) {
      await rename(destination, backup)
      moved = true
    }
    await rename(staging, destination)
  } catch (error) {
    if (moved && !existsSync(destination)) await rename(backup, destination)
    throw error
  }
  // Old invalid directories remain recoverable. A verified destination is never overwritten by download admission.
}
export function readRuntimeProvenance(root: string) {
  const pointer = imageRuntimePointer(root)
  return pointer
    ? {
        dependencySet: pointer.dependencySet,
        backend: pointer.backend,
        publishedAt: pointer.publishedAt,
        ...pointer.provenance
      }
    : undefined
}
/** Only package names and versions, not full environment variables or credentials, enter provenance. */
export const IMAGE_PROVENANCE_SCRIPT =
  "import sys,platform,importlib.metadata as m,json; print(json.dumps({'type':'result','data':{'python':platform.python_version(),'platform':sys.platform,'packages':{d.metadata['Name']:d.version for d in m.distributions()}}}))"
