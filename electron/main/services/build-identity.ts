import { app } from 'electron'

/**
 * Source identity stamped into the main bundle by electron.vite.config.ts at build time.
 * Absent under plain test runs, in which case identity stays explicitly unknown.
 */
declare const __ERIS_SOURCE_IDENTITY__:
  { gitSha: string; dirty: boolean; lockSha256: string; buildId?: string } | undefined
/** Stamped by electron.dev.config.ts into the Eris-Dev bundle. */
declare const __ERIS_DEV_BUILD__:
  { gitSha: string; dirty: boolean | null; dirtyDigest: string | null; buildId: string } | undefined

type Stamp = { gitSha: string; dirty: boolean | null; lockSha256?: string; buildId?: string }

function bakedStamp(): Stamp | undefined {
  if (typeof __ERIS_SOURCE_IDENTITY__ !== 'undefined' && __ERIS_SOURCE_IDENTITY__)
    return __ERIS_SOURCE_IDENTITY__
  if (typeof __ERIS_DEV_BUILD__ !== 'undefined' && __ERIS_DEV_BUILD__) return __ERIS_DEV_BUILD__
  return undefined
}

export interface RuntimeBuildIdentity {
  /** Product role of the running bundle: the IDE or the Eris-Dev evaluation app. */
  role: 'eris' | 'eris-dev'
  version: string
  packaged: boolean
  /** Full source commit stamped into this bundle, or 'unknown'. */
  gitSha: string
  /** null when the bundle carries no stamp, rather than guessing clean. */
  dirty: boolean | null
  /** Unique per build; two builds of the same commit stay distinguishable. */
  buildId: string
  lockSha256: string
  platform: string
  arch: string
  /** 'injected' = baked into the bundle; 'unknown' = no stamp present. */
  provenance: 'injected' | 'unknown'
}

/**
 * Identity of the code that is actually running. It is read only from values baked
 * into the bundle at build time — never from the checkout on disk — so rebuilding the
 * source without installing cannot make an installed app claim the newer identity.
 */
export function runtimeBuildIdentity(
  stamp: Stamp | undefined = bakedStamp()
): RuntimeBuildIdentity {
  const name = app.getName()
  return {
    role: /eris-dev/i.test(name) ? 'eris-dev' : 'eris',
    version: app.getVersion(),
    packaged: app.isPackaged,
    gitSha: stamp && /^[0-9a-f]{40}$/i.test(stamp.gitSha) ? stamp.gitSha : 'unknown',
    dirty: typeof stamp?.dirty === 'boolean' ? stamp.dirty : null,
    buildId: stamp?.buildId || 'unknown',
    lockSha256: stamp?.lockSha256 || 'unknown',
    platform: process.platform,
    arch: process.arch,
    provenance: stamp ? 'injected' : 'unknown'
  }
}

/** Short human label, e.g. `eris 0.6.19 · 2e856a1 · build 2026-11-09T…-ab12cd34`. */
export function formatBuildIdentity(id: RuntimeBuildIdentity): string {
  const sha = id.gitSha === 'unknown' ? 'unknown commit' : id.gitSha.slice(0, 12)
  const dirty = id.dirty === true ? ' (dirty)' : id.dirty === null ? ' (unverified)' : ''
  return `${id.role} ${id.version} · ${sha}${dirty} · build ${id.buildId}`
}
