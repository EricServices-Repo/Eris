/** Export formats. v1 files remain readable through readCaptureRecord. */
export const CAPTURE_FORMAT = 'eris-dev-capture-v2'
export const LEGACY_CAPTURE_FORMAT = 'eris-dev-capture-v1'

/**
 * How intent-model requests are answered during capture. fallback replies with
 * confidence 0; malformed sends invalid JSON; timeout never replies. A question
 * record may carry its own scripted reply, which is labeled as supplied.
 */
export type IntentReplyMode = 'fallback' | 'malformed' | 'timeout'

/** One imported question with a content-derived ID that survives reordering and chunking. */
export interface DevQuestion {
  /** sha256(text) prefix plus occurrence, e.g. `3f2a9c1b04de-1`. */
  id: string
  text: string
  /** One-based line (TXT/JSONL) or record (JSON) number in the original file. */
  sourceLine: number
  /** One-based occurrence of identical text, so duplicates stay addressable. */
  occurrence: number
  /** Digest of the case content (text and history) without the occurrence. */
  contentHash?: string
  /** Distinguishes scripted variants of the same content; absent for the default script. */
  variant?: string
  /** Scripted intent reply supplied by the corpus, never by a model. */
  intentReply?: { intent: string; confidence: number }
  /** The scripted reply is deliberately malformed, for resolver-failure testing. */
  intentReplyMalformed?: boolean
  /** Earlier turns, so a follow-up (“implement those”) is captured as a follow-up. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface DevImportPreview {
  name: string
  corpusId: string
  questions: DevQuestion[]
  /** Lines that were not imported, each with the reason. Nothing is dropped silently. */
  excluded: Array<{ sourceLine: number; text: string; reason: string }>
  /** Normalizations applied, in plain words. */
  normalization: string[]
}

/** A deterministic request-level finding. It never grades an answer. */
export interface DevFinding {
  id: string
  severity: 'defect' | 'review'
  detail: string
}

/**
 * Independent stages. Reaching the model boundary says nothing about routing
 * coherence, and neither says anything about answer quality.
 */
export interface DevStages {
  /** The request reached the model transport boundary. */
  reachability: 'captured' | 'blocked' | 'error' | 'cancelled'
  /** Deterministic invariants over the task, prompt and tools. */
  requestValidity: 'no-findings' | 'review' | 'defects' | 'not-assessed'
  inference: 'not-run' | 'completed' | 'error' | 'cancelled'
  answerQuality: 'not-evaluated'
}

export interface DevSummary {
  /** Zero-based position in this run; display adds one. */
  index: number
  questionId: string
  /** Scripted variant of the case, when the corpus supplied a resolver reply. */
  variant?: string
  /**
   * How questionId was assigned on a legacy record: v1-index is the record's position,
   * v1-content was migrated from its text. Absent on v2 records, whose IDs came from import.
   */
  identity?: 'v1-index' | 'v1-content'
  sourceLine: number
  question: string
  status: DevStages['reachability']
  stages: DevStages
  /** Model transport completion is separate from whether the agent finished its task. */
  completion?: { status: 'completed' | 'incomplete' | 'failed' | 'cancelled'; reason?: string }
  agent?: string
  intent?: string
  artifact?: string
  calls: number
  findings: { defect: number; review: number }
  /** Stable finding IDs, for filtering and grouping without loading request bodies. */
  findingIds: string[]
  detail?: string
}

export interface DevCapture {
  /** Raw live output for this transport call, including intent replies and partial failures. */
  response?: string
  error?: string
  durationMs?: number
  purpose: string
  model: string
  messages: unknown[]
  tools: unknown[]
  temperature: number
  toolChoice?: string
  schema?: Record<string, unknown>
  /** Context compiler manifest for this request: blocks, trust, truncation, budget. */
  context?: unknown
  /** Tool capability record in effect for this request. */
  toolManifest?: unknown
}

export interface DevResult extends DevSummary {
  task?: unknown
  requests: DevCapture[]
  /** Model output. Capture never generates one; responseReason says why it is absent. */
  response: string | null
  inference?: {
    model: string
    calls: number
    firstTokenMs: number | null
    outputChars: number
    error?: string
  }
  responseReason: 'not-generated' | 'not-observed-v1' | 'generated' | 'inference-failed'
  sourceMode: 'capture' | 'live'
  intentReplySource: 'fallback' | 'malformed' | 'timeout' | 'question-script' | 'none' | 'live'
  routeDecision?: unknown
  retrieval?: unknown
  workflowLint?: unknown
  findingsDetail: DevFinding[]
  events: string[]
  /** Local pre-inference phases. Not model latency and not generation speed. */
  phases: { routeMs: number; resolveMs: number; promptMs: number; toBoundaryMs: number }
  timing: 'pre-inference' | 'end-to-end'
  durationMs: number
}

export interface DevRunHeader {
  format: typeof CAPTURE_FORMAT
  created: string
  app: {
    name: 'Eris-Dev'
    version: string
    gitSha: string
    dirty: boolean | null
    /** Digest of uncommitted changes at build time; null when clean or unknown. */
    dirtyDigest?: string | null
    buildId?: string
    /** injected: stamped at build time; git: read from a checkout at run time; unknown: neither. */
    provenance?: 'injected' | 'git' | 'unknown'
  }
  versions: {
    routing: string
    prompt: string
    schema: typeof CAPTURE_FORMAT
    /** Request invariant checker; absent on runs recorded before it was versioned. */
    invariants?: string
    /** Oracle and grading policy. */
    evaluation?: string
    /** Fingerprint of everything above plus the source revision; resume requires a match. */
    harness?: string
  }
  /** sha256 of the capture settings; settings never contain credentials in capture. */
  settingsDigest: string
  corpus: { id: string; name: string; total: number; excluded: number }
  fixture: {
    kind: 'sample' | 'project' | 'none'
    digest: string | null
    files: number
    omitted: Array<{ category: string; count: number; examples: string[] }>
  }
  context: number
  mode: 'ask' | 'agent'
  intentReplyMode: IntentReplyMode
  responses: 'none' | 'live'
  live?: DevLiveConfig
  answerQuality: 'not-evaluated'
  /** What a capture run exercises and what it cannot, stated in every export. */
  coverage: { exercised: readonly string[]; notExercised: readonly string[] }
}

export const CAPTURE_COVERAGE = {
  exercised: [
    'question import',
    'routing and intent resolution',
    'task contract and interpretation',
    'prompt compilation',
    'tool exposure'
  ],
  notExercised: [
    'model inference',
    'tool execution',
    'workspace changes',
    'verification',
    'answer quality',
    'agent coordination',
    'desktop chat UI delivery'
  ]
} as const

export interface DevProgress {
  running: boolean
  completed: number
  total: number
  result?: DevSummary
  batch?: { number: number; total: number; size: 10 }
  error?: string
}

export interface DevModelOption {
  id: string
  label: string
}
export interface DevLiveConfig {
  model: string
  batchSize: 10
  timeoutMs: number
  maxCalls: number
}
export interface DevStartInput {
  context: number
  mode: 'ask' | 'agent'
  intentReplyMode: IntentReplyMode
  live?: DevLiveConfig
}

export interface DevApi {
  models(): Promise<DevModelOption[]>
  connect(input: { baseUrl: string; apiKey?: string }): Promise<DevModelOption[]>

  importQuestions(): Promise<DevImportPreview | null>
  listRuns(): Promise<DevRunListing[]>
  resumeRun(runId: string): Promise<{
    corpus: DevImportPreview
    next: number
    results: DevSummary[]
    /** Saved cases that were rejected and will be captured again, with reasons. */
    invalid: Array<{ index: number; reason: string }>
  }>
  /** Open any run read-only, completed runs included, without running it again. */
  openRun(runId: string): Promise<{
    corpus: DevImportPreview
    header: DevRunHeader
    state: DevRunListing['state']
    results: DevSummary[]
    invalid: Array<{ index: number; reason: string }>
  }>
  compareWith(): Promise<DevComparison | null>
  /** A further page of the last comparison's changed questions. */
  comparePage(offset: number): Promise<{
    changed: DevComparison['changed']
    page: DevComparison['page']
    totalChanged: number
  }>
  chooseProject(): Promise<string | null>
  setProjectKind(kind: 'sample' | 'none'): Promise<void>
  start(input: DevStartInput): Promise<void>
  stop(): Promise<void>
  result(index: number): Promise<DevResult>
  exportRun(options?: { sanitized?: boolean; indices?: number[] }): Promise<{
    path: string
    records: number
    redaction?: { replacements: Record<string, number>; limitations: readonly string[] }
  } | null>
  onProgress(listener: (event: DevProgress) => void): () => void
}

export interface DevRunListing {
  runId: string
  created: string
  corpus: string
  total: number
  completed: number
  state: 'running' | 'completed' | 'stopped' | 'interrupted'
  gitSha?: string
  mode?: 'ask' | 'agent'
  context?: number
  fixture?: string
  bytes?: number
}

export interface DevComparison {
  file: string
  /** Whether the two runs differ only in the code under test. */
  compatibility: {
    status: 'controlled' | 'confounded' | 'legacy'
    confounders: string[]
    controlled: string[]
  }
  /** v1 records given content IDs; duplicated texts whose occurrence pairing is uncertain. */
  identity: { legacyMigrated: number; ambiguous: string[] }
  matched: number
  added: string[]
  removed: string[]
  /** One page of changed questions; totalChanged counts all of them. */
  changed: Array<{
    questionId: string
    sourceLine: number
    question: string
    changes: Record<string, { before: unknown; after: unknown; detail?: string }>
  }>
  totalChanged: number
  page: { offset: number; size: number; returned: number }
  /** The complete comparison, saved beside the run. */
  savedTo: string
  byField: Record<string, number>
  byCategory: Record<string, number>
  transitions: Record<string, number>
  duplicates: { before: string[]; after: string[] }
}

const ZERO_PHASES = { routeMs: 0, resolveMs: 0, promptMs: 0, toBoundaryMs: 0 }

/**
 * Read one exported record of either format. A v1 record never claims a
 * response: its detail was the capture-stop message, not model output.
 */
export function readCaptureRecord(record: Record<string, unknown>): DevResult {
  if (record.responseReason) {
    const result = record as unknown as DevResult
    // Earlier live builds saved internal stop statuses but labeled their final
    // summaries as answered. Recover the outcome from those runtime events only.
    if (
      !result.completion &&
      result.sourceMode === 'live' &&
      Array.isArray(result.events) &&
      result.events.some(
        (event) => event === 'Incomplete' || event === 'Paused · run step budget reached'
      )
    )
      return {
        ...result,
        completion: {
          status: 'incomplete',
          reason: 'This earlier run stopped before the agent completed its task.'
        }
      }
    return result
  }
  const status = (record.status as DevStages['reachability']) ?? 'error'
  return {
    index: Number(record.index ?? 0),
    questionId: String(record.questionId ?? `v1-${record.index ?? 0}`),
    ...(record.questionId ? {} : { identity: 'v1-index' as const }),
    sourceLine: Number(record.index ?? 0) + 1,
    question: String(record.question ?? ''),
    status,
    stages: {
      reachability: status,
      requestValidity: 'not-assessed',
      inference: 'not-run',
      answerQuality: 'not-evaluated'
    },
    agent: record.agent as string | undefined,
    intent: record.intent as string | undefined,
    artifact: typeof record.artifact === 'string' ? record.artifact : undefined,
    calls: Number(record.calls ?? 0),
    findings: { defect: 0, review: 0 },
    findingIds: [],
    detail: record.detail as string | undefined,
    task: record.task,
    requests: (record.requests as DevCapture[]) ?? [],
    response: null,
    responseReason: 'not-observed-v1',
    sourceMode: 'capture',
    intentReplySource: 'fallback',
    findingsDetail: [],
    events: (record.events as string[]) ?? [],
    phases: ZERO_PHASES,
    timing: 'pre-inference',
    durationMs: Number(record.durationMs ?? 0)
  }
}
