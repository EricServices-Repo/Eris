import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { TaskContract } from '../../../../src/shared/task-contract'
import { sourcePathsIn } from '../../../../src/shared/agent-contract'
import { requestTextForIntent } from '../../../../src/shared/task-interpretation'
import { evidenceEpoch } from '../context-evidence-epochs'
import { isPathInside, realpathAllowMissing } from '../workspace-fs'

export interface SourceReadReceipt {
  path: string
  digest: string
  range?: { startLine?: number; endLine?: number }
  requirementIds: string[]
  followedFrom?: string
  supersededByMutation?: boolean
  movedTo?: string
  truncated?: boolean
}
type Entry = SourceReadReceipt & {
  absolute: string
  version: string | null
  epoch: ReturnType<typeof evidenceEpoch>
  links: string[]
  words: Set<string>
  movedVersion?: string | null
}
const stop = new Set(
  'review inspect audit examine check explain find read source code files file project repo repository workspace current existing website site app application flow feature features recommend recommendations improvements missing improve enhancement enhancements enhance confirm ensure build builds implement implementation refactor optimize polish remove delete rename replace move update edit finish list describe report source summary function functions component components what which should could would can you please this that these those the our my and for with from into then add create need else how does work works changes change general behavior'.split(
    ' '
  )
)
function terms(text: string, limit = 24): string[] {
  return [
    ...new Set(
      (
        text
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .match(/[a-z][a-z0-9]{2,}/g) ?? []
      )
        .filter((word) => !stop.has(word))
        .map((word) =>
          /^(?:authentication|authenticate|authorization)$/.test(word)
            ? 'auth'
            : word.replace(/(?:ing|s)$/, '')
        )
    )
  ].slice(0, limit)
}
function version(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true })
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null
  } catch {
    return null
  }
}

/** Bounded, run-local proof of what source was read and whether it still applies. */
export class SourceReadEvidence {
  private entries = new Map<string, Entry>()
  private targets: string[]
  private topics: string[]
  private root: string
  private project: string
  private needed: Set<string>
  private targetOverflow: boolean
  constructor(private task: TaskContract) {
    this.root = task.scope.workspaceRoot!
    this.project = task.scope.projectRoot!
    const instruction = requestTextForIntent(task.originalText)
    const paths = [
      ...new Set([...sourcePathsIn(instruction), ...(task.requested?.targetFiles ?? [])])
    ]
    this.targetOverflow = paths.length > 64
    this.targets = paths
      .slice(0, 64)
      .map((path) => {
        const prefix = relative(this.root, this.project).replace(/\\/g, '/')
        return realpathAllowMissing(
          resolve(prefix && path.startsWith(prefix + '/') ? this.root : this.project, path)
        )
      })
      .filter((path) => task.intent !== 'edit' || existsSync(path))
    this.topics = terms(
      paths.slice(0, 64).reduce((text, path) => text.replaceAll(path, ' '), instruction)
    )
    this.needed = new Set([
      ...this.topics,
      ...(task.interpretation?.obligations ?? [])
        .slice(0, 16)
        .flatMap((obligation) => terms(obligation.text))
    ])
  }
  private epoch(path: string) {
    return evidenceEpoch(this.root, [path])
  }
  private fresh(entry: Entry): boolean {
    const epoch = this.epoch(entry.path)
    return (
      !epoch.dirty &&
      epoch.floor === entry.epoch.floor &&
      realpathAllowMissing(resolve(this.root, entry.path)) === entry.absolute &&
      version(entry.absolute) === entry.version &&
      (entry.version !== null || !existsSync(entry.absolute)) &&
      (!entry.movedTo ||
        (!this.epoch(entry.movedTo).dirty &&
          version(resolve(this.root, entry.movedTo)) === entry.movedVersion))
    )
  }
  noteRead(path: string, detail?: string, range?: SourceReadReceipt['range']): boolean {
    try {
      const absolute = realpathSync(resolve(this.root, path))
      if (!isPathInside(this.project, absolute)) return false
      const local = relative(this.root, absolute).replace(/\\/g, '/')
      if (local.split('/').some((part) => part === '.eris' || part === '.git')) return false
      const fileVersion = version(absolute),
        epoch = this.epoch(local)
      if (!fileVersion || epoch.dirty) return false
      if (detail === undefined && statSync(absolute).size > 80_000) return false
      const content = (detail ?? readFileSync(absolute, 'utf8')).slice(0, 80_000)
      const links: string[] = []
      for (const match of content.matchAll(
        /(?:from\s*|(?:import|require)\s*\()\s*['"](\.[^'"]+)['"]/g
      )) {
        for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
          try {
            const target = realpathSync(resolve(dirname(absolute), match[1]! + suffix))
            if (isPathInside(this.project, target) && statSync(target).isFile()) {
              links.push(target)
              break
            }
          } catch {
            /* An unresolved import is not evidence. */
          }
        }
        if (links.length >= 32) break
      }
      if (this.entries.size >= 64 && !this.entries.has(absolute))
        this.entries.delete(this.entries.keys().next().value!)
      this.entries.set(absolute, {
        path: local,
        absolute,
        version: fileVersion,
        epoch,
        links,
        words: new Set(
          terms(local + ' ' + content, 20_000).filter((word) => this.needed.has(word))
        ),
        digest: createHash('sha256').update(content).digest('hex'),
        range,
        requirementIds: [],
        ...((detail?.length ?? 0) > 80_000 || /\[truncated at/.test(content)
          ? { truncated: true }
          : {})
      })
      return true
    } catch {
      return false
    }
  }
  noteMutation(path: string, movedTo?: string): void {
    // A host-observed effect can advance a read's lineage. External edits cannot.
    const absolute = realpathAllowMissing(resolve(this.root, path))
    for (const entry of this.entries.values()) {
      if (entry.absolute !== absolute && !isPathInside(absolute, entry.absolute)) continue
      entry.version = version(absolute)
      if (entry.absolute !== absolute) entry.version = version(entry.absolute)
      entry.epoch = this.epoch(entry.path)
      entry.supersededByMutation = true
      if (movedTo) {
        const target = realpathAllowMissing(
          resolve(this.root, movedTo, relative(absolute, entry.absolute))
        )
        if (!isPathInside(this.project, target)) continue
        entry.movedTo = relative(this.root, target).replace(/\\/g, '/')
        entry.movedVersion = version(target)
      }
    }
  }
  assess(): { ok: boolean; reason?: string } {
    if (this.targetOverflow)
      return {
        ok: false,
        reason:
          'Source review exceeds the 64-target evidence bound; split the requested files into smaller reviews.'
      }
    const fresh = [...this.entries.values()].filter((entry) => this.fresh(entry))
    for (const entry of this.entries.values()) {
      entry.requirementIds = []
      delete entry.followedFrom
    }
    const missing = this.targets.filter(
      (target) => !fresh.some((entry) => entry.absolute === target)
    )
    if (missing.length)
      return {
        ok: false,
        reason: `Requested source was not read or is stale: ${missing.map((path) => relative(this.project, path)).join(', ')}.`
      }
    const relevant = new Set<string>()
    for (const entry of fresh) {
      const words = entry.words
      const uiSource =
        /\.(?:html?|css|scss|tsx|jsx|vue|svelte)$/i.test(entry.path) &&
        this.topics.some((topic) =>
          ['layout', 'style', 'design', 'page', 'banner', 'search', 'ui'].includes(topic)
        )
      if (
        this.targets.includes(entry.absolute) ||
        !this.topics.length ||
        uiSource ||
        this.topics.some((topic) => words.has(topic))
      ) {
        relevant.add(entry.absolute)
        entry.requirementIds = [
          'task-source',
          ...(this.task.interpretation?.obligations ?? [])
            .filter((obligation) => terms(obligation.text).some((word) => words.has(word)))
            .map((obligation) => obligation.id)
        ].slice(0, 16)
      }
    }
    for (let pass = 0; pass < 8; pass++) {
      let changed = false
      for (const parent of fresh.filter((entry) => relevant.has(entry.absolute))) {
        for (const entry of fresh.filter(
          (entry) => !relevant.has(entry.absolute) && parent.links.includes(entry.absolute)
        )) {
          relevant.add(entry.absolute)
          entry.requirementIds = [...parent.requirementIds]
          entry.followedFrom = parent.path
          changed = true
        }
      }
      if (!changed) break
    }
    return relevant.size
      ? { ok: true }
      : {
          ok: false,
          reason:
            'No fresh project source relevant to the requested files or topic was inspected. Read the target or follow its source dependencies.'
        }
  }
  snapshot(): SourceReadReceipt[] {
    this.assess()
    return [...this.entries.values()]
      .filter((entry) => this.fresh(entry))
      .map((entry) => ({
        path: entry.path,
        digest: entry.digest,
        range: entry.range,
        requirementIds: [...entry.requirementIds],
        ...(entry.followedFrom ? { followedFrom: entry.followedFrom } : {}),
        ...(entry.supersededByMutation ? { supersededByMutation: true } : {}),
        ...(entry.movedTo ? { movedTo: entry.movedTo } : {}),
        ...(entry.truncated ? { truncated: true } : {})
      }))
  }
}
