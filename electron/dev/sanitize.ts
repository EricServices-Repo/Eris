import { createHmac, randomBytes } from 'crypto'

/**
 * Automated export redaction. Secrets become `[REDACTED:<kind>:<marker>]`; within one
 * export the same value always gets the same marker, so linkage survives while the
 * value does not. Markers are keyed per export, so a public marker cannot be checked
 * against a guessed password and two exports do not reveal shared values. Temporary
 * workspace roots become `<workspace>` and the home directory `~`, which keeps
 * relative file paths, question IDs and task IDs intact.
 *
 * This is pattern- and field-name-based redaction, not a guarantee that every
 * sensitive value was removed; LIMITATIONS is shown with every sanitized export.
 */
export const REDACTION_POLICY = 'eris-dev-redaction-v2'
export const REDACTION_LIMITATIONS = [
  'Only listed token formats, credential field names, auth headers, cookies and URL passwords are redacted.',
  'Custom or nonstandard secrets in free text, personal data and customer data are not detected.',
  'Ordinary source files in a project snapshot are exported as captured; only paths are normalized.'
] as const

export interface RedactionManifest {
  policy: typeof REDACTION_POLICY
  replacements: Record<string, number>
  /** Categories that were checked even when nothing matched. */
  checked: string[]
  /** export-scoped: markers match only within this export. */
  linkage: 'export-scoped' | 'shared-key'
  limitations: readonly string[]
}

/** Field names whose string values are credentials, whatever the value looks like. */
const SECRET_FIELD =
  /^(?:x[_-])?(?:pass(?:word|wd|phrase)?|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|private[_-]?key|authorization|cookie|set[_-]?cookie|session[_-]?(?:id|token|key)|credentials?|bearer|connection[_-]?string|database[_-]?url|dsn)$/i
/**
 * Similar names that are not secrets: token counts and budgets, policies, and flags.
 * Reviewed explicitly so useful evidence is not destroyed.
 */
const NOT_SECRET_FIELD =
  /^(?:max|input|output|prompt|completion|total|estimated)?[_-]?tokens?[_-]?(?:count|counts|usage|budget|limit|estimate|chars)$|^(?:password|token)[_-]?(?:policy|length|rules|required|expires(?:[_-]?at)?)$/i

const MARKER = /(\[REDACTED:[a-z-]+:[0-9a-f]{8}(?:[0-9a-f]{8})?\])/g

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
    kind: 'auth-header',
    pattern:
      /\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:\s*)([^\n\r"]{4,})/gi
  },
  {
    kind: 'url-password',
    pattern: /\b([a-z][\w+.-]*:\/\/[^\s:@/]+:)([^\s@/]{1,})(?=@)/gi
  },
  {
    kind: 'assigned-secret',
    pattern:
      /\b((?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]{4,})/gi
  }
]

const PREFIXED = new Set(['assigned-secret', 'auth-header', 'url-password'])

export class CaptureSanitizer {
  private readonly counts = new Map<string, number>()
  private readonly key: Buffer
  constructor(
    private readonly options: {
      homeDir?: string
      workspaceRoots?: string[]
      tmpRoots?: string[]
      /**
       * Linkage key. Omitted: a fresh random key per export. Pass one only when
       * markers must match across exports, and keep it private.
       */
      linkageKey?: string
    }
  ) {
    this.key = options.linkageKey ? Buffer.from(options.linkageKey) : randomBytes(32)
  }

  private token(kind: string, value: string): string {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1)
    // Keyed, 64-bit markers: consistent within the export, not checkable by guessing.
    return `[REDACTED:${kind}:${createHmac('sha256', this.key).update(value).digest('hex').slice(0, 16)}]`
  }

  text(value: string): string {
    let out = value
    for (const { kind, pattern } of SECRET_PATTERNS) {
      // Later patterns must not reinterpret earlier redaction tokens as secrets.
      // Keep tokens intact, including when sanitizing an already-clean export.
      out = out
        .split(MARKER)
        .map((part, index) =>
          index % 2
            ? part
            : part.replace(pattern, (match: string, prefix?: string, secret?: string) =>
                PREFIXED.has(kind) && typeof prefix === 'string' && typeof secret === 'string'
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

  /** A credential field's string value, redacted whatever it looks like. */
  private field(value: string): string {
    if (!value || /^\[REDACTED:[a-z-]+:[0-9a-f]{8,16}\]$/.test(value)) return value
    return this.token('credential-field', value)
  }

  /**
   * Redact every string in a JSON value; keys and structure are kept. Values under
   * credential field names ({password: …}, {name: "Authorization", value: …}) are
   * redacted by their key, not only by how the value looks.
   */
  value<T>(input: T, key?: string): T {
    const secretKey = key !== undefined && SECRET_FIELD.test(key) && !NOT_SECRET_FIELD.test(key)
    if (typeof input === 'string') return (secretKey ? this.field(input) : this.text(input)) as T
    if (Array.isArray(input)) return input.map((item) => this.value(item, key)) as T
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>
      // Header lists: [{ name: "Authorization", value: "Basic …" }].
      const label = record.name ?? record.key ?? record.header
      const pairSecret =
        typeof label === 'string' && SECRET_FIELD.test(label) && !NOT_SECRET_FIELD.test(label)
      return Object.fromEntries(
        Object.entries(record).map(([name, item]) => [
          name,
          pairSecret && name === 'value' && typeof item === 'string'
            ? this.field(item)
            : this.value(item, name)
        ])
      ) as T
    }
    return input
  }

  manifest(): RedactionManifest {
    return {
      policy: REDACTION_POLICY,
      replacements: Object.fromEntries(this.counts),
      checked: [
        ...SECRET_PATTERNS.map((item) => item.kind),
        'credential-field',
        'workspace-path',
        'home-path'
      ],
      linkage: this.options.linkageKey ? 'shared-key' : 'export-scoped',
      limitations: REDACTION_LIMITATIONS
    }
  }
}
