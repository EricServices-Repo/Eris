import { createHash } from 'crypto'

/**
 * Deterministic export redaction. Secrets become `[REDACTED:<kind>:<hash>]`, and the
 * same value always gets the same token, so linkage survives while the value does
 * not. Temporary workspace roots become `<workspace>` and the home directory `~`,
 * which keeps relative file paths, question IDs and task IDs intact.
 */
export interface RedactionManifest {
  policy: 'eris-dev-redaction-v1'
  replacements: Record<string, number>
  /** Categories that were checked even when nothing matched. */
  checked: string[]
}

const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
  },
  { kind: 'api-key', pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{12,}=*/g },
  {
    kind: 'assigned-secret',
    pattern:
      /\b((?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]{8,})/gi
  }
]

export class CaptureSanitizer {
  private readonly counts = new Map<string, number>()
  constructor(
    private readonly options: { homeDir?: string; workspaceRoots?: string[]; tmpRoots?: string[] }
  ) {}

  private token(kind: string, value: string): string {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1)
    return `[REDACTED:${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 8)}]`
  }

  text(value: string): string {
    let out = value
    for (const { kind, pattern } of SECRET_PATTERNS) {
      // Later patterns must not reinterpret earlier redaction tokens as secrets.
      // Keep tokens intact, including when sanitizing an already-clean export.
      out = out
        .split(/(\[REDACTED:[a-z-]+:[0-9a-f]{8}\])/g)
        .map((part, index) =>
          index % 2
            ? part
            : part.replace(pattern, (match: string, prefix?: string, secret?: string) =>
                kind === 'assigned-secret' && prefix !== undefined && secret !== undefined
                  ? `${prefix}${this.token(kind, secret)}`
                  : this.token(kind, match)
              )
        )
        .join('')
    }
    for (const root of [...(this.options.workspaceRoots ?? [])].sort(
      (a, b) => b.length - a.length
    )) {
      if (root.length > 3 && out.includes(root)) {
        this.counts.set('workspace-path', (this.counts.get('workspace-path') ?? 0) + 1)
        out = out.split(root).join('<workspace>')
      }
    }
    // Capture snapshots live in temporary eris-dev-* folders (macOS also reports /private/var).
    for (const tmpRoot of this.options.tmpRoots ?? []) {
      const escaped = tmpRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(
        new RegExp(`(?:/private)?${escaped}[\\\\/]+eris-dev-[A-Za-z0-9]+`, 'g'),
        () => {
          this.counts.set('workspace-path', (this.counts.get('workspace-path') ?? 0) + 1)
          return '<workspace>'
        }
      )
    }
    const home = this.options.homeDir?.trim()
    if (home && home.length > 2 && out.includes(home)) {
      this.counts.set('home-path', (this.counts.get('home-path') ?? 0) + 1)
      out = out.split(home).join('~')
    }
    return out
  }

  /** Redact every string in a JSON value; keys and structure are kept. */
  value<T>(input: T): T {
    if (typeof input === 'string') return this.text(input) as T
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as T
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, item]) => [
          key,
          this.value(item)
        ])
      ) as T
    return input
  }

  manifest(): RedactionManifest {
    return {
      policy: 'eris-dev-redaction-v1',
      replacements: Object.fromEntries(this.counts),
      checked: [...SECRET_PATTERNS.map((item) => item.kind), 'workspace-path', 'home-path']
    }
  }
}
