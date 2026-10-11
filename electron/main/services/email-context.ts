import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { workspaceConfigDir } from './paths'
import { appendContextNote, getWorkspaceContext, saveWorkspaceContext } from './workspace-context'

const execFileAsync = promisify(execFile)

export type EmailSourceKind = 'thunderbird' | 'outlook' | 'eml'

export type EmailMessage = {
  id: string
  source: EmailSourceKind
  account?: string
  folder?: string
  from: string
  to: string
  subject: string
  date: string
  snippet: string
  path?: string
}

export type EmailSourceInfo = {
  kind: EmailSourceKind
  id: string
  label: string
  path?: string
  available: boolean
  detail?: string
}

export type EmailPullOptions = {
  sourceId: string
  query?: string
  maxMessages?: number
  /** Append a short digest into .eris/context.md ## Email */
  appendToContext?: boolean
}

export type EmailPullResult = {
  ok: boolean
  error?: string
  messages: EmailMessage[]
  writtenPath?: string
  contextUpdated?: boolean
}

const MAX_SNIPPET = 900
const MAX_MBOX_TAIL = 3_000_000
const DEFAULT_MAX = 25

function thunderbirdProfilesRoot(): string {
  return join(homedir(), 'Library', 'Thunderbird', 'Profiles')
}

function listThunderbirdProfiles(): string[] {
  const root = thunderbirdProfilesRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
}

function listMboxFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || !existsSync(dir)) return out
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name.endsWith('.msf') || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === 'msgFilterRules.dat') continue
      listMboxFiles(full, depth + 1, out)
    } else if (st.isFile() && st.size > 0 && !name.includes('.')) {
      // Thunderbird mbox folders are extensionless files (INBOX, Sent, …)
      out.push(full)
    }
  }
  return out
}

function decodeMimeWord(value: string): string {
  return value
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_m, _charset, enc, data: string) => {
      try {
        if (String(enc).toUpperCase() === 'B') {
          return Buffer.from(data, 'base64').toString('utf8')
        }
        const q = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16))
        )
        return q
      } catch {
        return data
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function headerValue(raw: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n\\S|\\r?\\n\\r?\\n|$)`, 'im')
  const m = raw.match(re)
  if (!m) return ''
  return decodeMimeWord(m[1].replace(/\r?\n[ \t]+/g, ' ').trim())
}

function bodySnippet(raw: string): string {
  const parts = raw.split(/\r?\n\r?\n/)
  const body = parts.slice(1).join('\n\n')
  // Prefer text/plain-ish content; strip HTML tags lightly
  let text = body
  if (/content-type:\s*text\/html/i.test(raw) || /<html[\s>]/i.test(body)) {
    text = body
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  }
  text = text
    .replace(/^--[^\n]*$/gm, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length > MAX_SNIPPET) return `${text.slice(0, MAX_SNIPPET)}…`
  return text
}

function parseSingleMessage(
  raw: string,
  meta: { source: EmailSourceKind; account?: string; folder?: string; path?: string; id: string }
): EmailMessage | null {
  const from = headerValue(raw, 'From')
  const subject = headerValue(raw, 'Subject') || '(no subject)'
  const date = headerValue(raw, 'Date')
  const to = headerValue(raw, 'To')
  if (!from && !subject && !date) return null
  return {
    id: meta.id,
    source: meta.source,
    account: meta.account,
    folder: meta.folder,
    from,
    to,
    subject,
    date,
    snippet: bodySnippet(raw),
    path: meta.path
  }
}

function splitMbox(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const messages: string[] = []
  let cur: string[] = []
  for (const line of lines) {
    if (/^From /.test(line) && cur.length > 0) {
      messages.push(cur.join('\n'))
      cur = [line]
    } else {
      cur.push(line)
    }
  }
  if (cur.length) messages.push(cur.join('\n'))
  return messages
}

function readMboxTail(filePath: string): string {
  const st = statSync(filePath)
  if (st.size <= MAX_MBOX_TAIL) {
    return readFileSync(filePath, 'utf8')
  }
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(MAX_MBOX_TAIL)
    readSync(fd, buf, 0, MAX_MBOX_TAIL, st.size - MAX_MBOX_TAIL)
    let text = buf.toString('utf8')
    const idx = text.indexOf('\nFrom ')
    if (idx >= 0) text = text.slice(idx + 1)
    return text
  } finally {
    closeSync(fd)
  }
}

function parseMboxFile(
  filePath: string,
  account: string,
  folder: string,
  query: string,
  limit: number
): EmailMessage[] {
  let content: string
  try {
    content = readMboxTail(filePath)
  } catch {
    return []
  }
  const chunks = splitMbox(content)
  const q = query.trim().toLowerCase()
  const out: EmailMessage[] = []
  // Newest tend to be at the end of Thunderbird mbox
  for (let i = chunks.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = chunks[i]!
    const msg = parseSingleMessage(raw, {
      source: 'thunderbird',
      account,
      folder,
      path: filePath,
      id: `tb-${basename(filePath)}-${i}`
    })
    if (!msg) continue
    if (q) {
      const hay = `${msg.from} ${msg.to} ${msg.subject} ${msg.snippet}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    out.push(msg)
  }
  return out
}

function discoverThunderbirdSources(): EmailSourceInfo[] {
  const profiles = listThunderbirdProfiles()
  if (profiles.length === 0) {
    return [
      {
        kind: 'thunderbird',
        id: 'thunderbird:none',
        label: 'Thunderbird',
        available: false,
        detail: `No profiles in ${thunderbirdProfilesRoot()}`
      }
    ]
  }
  const out: EmailSourceInfo[] = []
  for (const profile of profiles) {
    const profileName = basename(profile)
    for (const rootName of ['ImapMail', 'Mail']) {
      const root = join(profile, rootName)
      if (!existsSync(root)) continue
      let accounts: string[]
      try {
        accounts = readdirSync(root)
      } catch {
        continue
      }
      for (const account of accounts) {
        if (account.endsWith('.msf')) continue
        const accountPath = join(root, account)
        try {
          if (!statSync(accountPath).isDirectory()) continue
        } catch {
          continue
        }
        const mboxes = listMboxFiles(accountPath)
        const inbox =
          mboxes.find((p) => /\/INBOX$/i.test(p)) ||
          mboxes.find((p) => /\/Inbox$/i.test(p)) ||
          mboxes[0]
        if (!inbox) continue
        out.push({
          kind: 'thunderbird',
          id: `thunderbird:${profileName}:${account}`,
          label: `Thunderbird · ${account}`,
          path: inbox,
          available: true,
          detail: `${profileName} · ${mboxes.length} folder(s)`
        })
      }
    }
  }
  if (out.length === 0) {
    out.push({
      kind: 'thunderbird',
      id: 'thunderbird:empty',
      label: 'Thunderbird',
      available: false,
      detail: 'Profiles found but no mail folders'
    })
  }
  return out
}

async function outlookInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'tell application "System Events" to return (exists application process "Microsoft Outlook") or (exists file "Microsoft Outlook.app" of folder "Applications" of startup disk) or (exists file "Outlook.app" of folder "Applications" of startup disk)'
    ])
    return /true/i.test(stdout.trim())
  } catch {
    return existsSync('/Applications/Microsoft Outlook.app') || existsSync('/Applications/Outlook.app')
  }
}

async function pullOutlookViaAppleScript(
  query: string,
  limit: number
): Promise<{ ok: boolean; messages: EmailMessage[]; error?: string }> {
  const q = query.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `
tell application "Microsoft Outlook"
  set outList to {}
  set msgs to {}
  try
    set msgs to messages of inbox
  on error
    try
      set msgs to messages of folder "Inbox" of default account
    end try
  end try
  set n to 0
  set maxN to ${Math.max(1, Math.min(limit * 4, 120))}
  repeat with m in msgs
    if n ≥ maxN then exit repeat
    set n to n + 1
    set subj to ""
    set snd to ""
    set dt to ""
    set preview to ""
    try
      set subj to subject of m as string
    end try
    try
      set snd to address of sender of m as string
    end try
    try
      set dt to (time received of m as string)
    end try
    try
      set preview to content of m as string
    end try
    set blob to subj & " " & snd & " " & preview
    set q to "${q}"
    if q is "" or blob contains q then
      set end of outList to subj & linefeed & snd & linefeed & dt & linefeed & preview & linefeed & "====ERIS_MSG===="
    end if
    if (count of outList) ≥ ${limit} then exit repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return outList as string
end tell
`
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000
    })
    const blocks = stdout.split('====ERIS_MSG====').map((b) => b.trim()).filter(Boolean)
    const messages: EmailMessage[] = []
    for (let i = 0; i < blocks.length && messages.length < limit; i++) {
      const lines = blocks[i]!.split(/\r?\n/)
      const subject = lines[0] || '(no subject)'
      const from = lines[1] || ''
      const date = lines[2] || ''
      const snippet = lines.slice(3).join('\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      messages.push({
        id: `ol-${i}`,
        source: 'outlook',
        folder: 'Inbox',
        from,
        to: '',
        subject,
        date,
        snippet: snippet.length > MAX_SNIPPET ? `${snippet.slice(0, MAX_SNIPPET)}…` : snippet
      })
    }
    return { ok: true, messages }
  } catch (err) {
    return {
      ok: false,
      messages: [],
      error:
        err instanceof Error
          ? err.message
          : 'Outlook AppleScript failed — grant Automation access or use an .eml folder'
    }
  }
}

function parseEmlFile(filePath: string, query: string): EmailMessage | null {
  let raw: string
  try {
    const buf = readFileSync(filePath)
    raw = buf.toString('utf8')
    if (raw.length > 500_000) raw = raw.slice(0, 500_000)
  } catch {
    return null
  }
  const msg = parseSingleMessage(raw, {
    source: 'eml',
    folder: basename(dirname(filePath)),
    path: filePath,
    id: `eml-${basename(filePath)}`
  })
  if (!msg) return null
  const q = query.trim().toLowerCase()
  if (q) {
    const hay = `${msg.from} ${msg.to} ${msg.subject} ${msg.snippet}`.toLowerCase()
    if (!hay.includes(q)) return null
  }
  return msg
}

function pullFromEmlFolder(folderPath: string, query: string, limit: number): EmailMessage[] {
  if (!folderPath || !existsSync(folderPath)) return []
  let names: string[]
  try {
    names = readdirSync(folderPath)
  } catch {
    return []
  }
  const files = names
    .filter((n) => /\.(eml|txt)$/i.test(n))
    .map((n) => join(folderPath, n))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs
      } catch {
        return 0
      }
    })
  const out: EmailMessage[] = []
  for (const file of files) {
    if (out.length >= limit) break
    const msg = parseEmlFile(file, query)
    if (msg) out.push(msg)
  }
  return out
}

export async function discoverEmailSources(emlFolder?: string): Promise<EmailSourceInfo[]> {
  const sources = discoverThunderbirdSources()
  const hasOutlook = await outlookInstalled()
  sources.push({
    kind: 'outlook',
    id: 'outlook:inbox',
    label: 'Outlook (Microsoft Outlook)',
    available: hasOutlook,
    detail: hasOutlook
      ? 'Pulls recent Inbox messages via AppleScript'
      : 'Microsoft Outlook.app not found — use an .eml export folder'
  })
  const emlPath = emlFolder && existsSync(emlFolder) ? emlFolder : ''
  sources.push({
    kind: 'eml',
    id: emlPath ? `eml:${emlPath}` : 'eml:folder',
    label: 'Outlook / any mail (.eml folder)',
    path: emlPath || '',
    available: Boolean(emlPath),
    detail: emlPath
      ? `Folder: ${emlPath}`
      : 'Export messages as .eml (Outlook: File → Save As / drag to Finder) and choose the folder'
  })
  return sources
}

function resolveThunderbirdSource(sourceId: string): { path: string; account: string } | null {
  const sources = discoverThunderbirdSources().filter((s) => s.available && s.path)
  const hit = sources.find((s) => s.id === sourceId) || sources[0]
  if (!hit?.path) return null
  return { path: hit.path, account: hit.label.replace(/^Thunderbird · /, '') }
}

function formatMessagesMarkdown(messages: EmailMessage[], query: string): string {
  const stamp = new Date().toISOString()
  const lines = [
    `# Email context`,
    ``,
    `Pulled ${stamp}${query.trim() ? ` · query: “${query.trim()}”` : ''}`,
    ``
  ]
  for (const m of messages) {
    lines.push(`## ${m.subject}`)
    lines.push(`- From: ${m.from || '—'}`)
    if (m.to) lines.push(`- To: ${m.to}`)
    if (m.date) lines.push(`- Date: ${m.date}`)
    if (m.account || m.folder) {
      lines.push(`- Source: ${m.source}${m.account ? ` / ${m.account}` : ''}${m.folder ? ` / ${m.folder}` : ''}`)
    }
    lines.push(``)
    lines.push(m.snippet || '(no body)')
    lines.push(``)
  }
  return lines.join('\n')
}

export function upsertEmailSection(body: string, digest: string): string {
  const section = `## Email\n${digest.trim()}\n`
  if (/^##\s+Email\s*$/im.test(body)) {
    return body.replace(/^##\s+Email\s*\n[\s\S]*?(?=^##\s+|(?![\s\S]))/im, `${section}\n`)
  }
  return `${body.trimEnd()}\n\n${section}`
}

export async function pullEmailContext(
  workspacePath: string | null,
  options: EmailPullOptions
): Promise<EmailPullResult> {
  if (!workspacePath) return { ok: false, error: 'Open a workspace first', messages: [] }
  const max = Math.max(1, Math.min(options.maxMessages ?? DEFAULT_MAX, 50))
  const query = options.query || ''
  let messages: EmailMessage[] = []

  if (options.sourceId.startsWith('thunderbird:')) {
    const resolved = resolveThunderbirdSource(options.sourceId)
    if (!resolved) {
      return { ok: false, error: 'No Thunderbird mail folders found', messages: [] }
    }
    messages = parseMboxFile(resolved.path, resolved.account, basename(resolved.path), query, max)
  } else if (options.sourceId.startsWith('outlook:')) {
    const pulled = await pullOutlookViaAppleScript(query, max)
    if (!pulled.ok) return { ok: false, error: pulled.error, messages: [] }
    messages = pulled.messages
  } else if (options.sourceId.startsWith('eml:')) {
    // Convention: `eml:/absolute/path` or legacy `eml:folder` (needs path after colon empty → error)
    const folderPath = options.sourceId.slice('eml:'.length)
    if (!folderPath || folderPath === 'folder' || !existsSync(folderPath)) {
      return {
        ok: false,
        error: 'Choose an .eml export folder first',
        messages: []
      }
    }
    messages = pullFromEmlFolder(folderPath, query, max)
  } else {
    return { ok: false, error: 'Unknown email source', messages: [] }
  }

  if (messages.length === 0) {
    return { ok: true, messages: [], error: query ? 'No messages matched the query' : 'No messages found' }
  }

  const md = formatMessagesMarkdown(messages, query)
  const outDir = workspaceConfigDir(workspacePath)
  mkdirSync(outDir, { recursive: true })
  const writtenPath = join(outDir, 'email-context.md')
  writeFileSync(writtenPath, md.endsWith('\n') ? md : `${md}\n`, 'utf8')

  let contextUpdated = false
  if (options.appendToContext !== false) {
    const digest = messages
      .slice(0, 8)
      .map((m) => {
        const when = m.date ? ` (${m.date})` : ''
        const snip = m.snippet.replace(/\s+/g, ' ').slice(0, 160)
        return `- **${m.subject}** — ${m.from || 'unknown'}${when}: ${snip}`
      })
      .join('\n')
    const current = getWorkspaceContext(workspacePath).body
    const next = upsertEmailSection(
      current,
      `Last pull ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC` +
        `${query ? ` · “${query}”` : ''}\n\n${digest}\n\n(Full text in \`.eris/email-context.md\`)`
    )
    saveWorkspaceContext(workspacePath, next)
    contextUpdated = true
    // Also a one-line pin note for recency
    appendContextNote(
      workspacePath,
      `Pulled ${messages.length} email(s) into context from ${messages[0]?.source || 'mail'}`
    )
  }

  return { ok: true, messages, writtenPath, contextUpdated }
}

/** Lightweight read for agent tools. */
export function readPulledEmailContext(workspacePath: string | null, maxChars = 12_000): {
  ok: boolean
  detail: string
  path?: string
} {
  if (!workspacePath) return { ok: false, detail: 'No workspace open' }
  const path = join(workspaceConfigDir(workspacePath), 'email-context.md')
  if (!existsSync(path)) {
    return {
      ok: true,
      detail:
        'No email context yet. Use Settings → Context → Pull email, or ask the user to pull from Thunderbird/Outlook.'
    }
  }
  const text = readFileSync(path, 'utf8')
  const detail =
    text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`
  return { ok: true, detail, path: '.eris/email-context.md' }
}
