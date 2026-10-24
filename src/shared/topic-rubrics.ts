/**
 * The 40 topic rubrics from docs/reviews/eris-dev-10000-2026-10-23/improvements.json,
 * as data. Each required behavior has a keyword pattern; `core` behaviors are what a
 * minimal but complete example must show, the rest are reported as gaps. Keyword
 * coverage is a heuristic for review, not proof that the code is correct.
 */
export interface RubricBehavior {
  label: string
  pattern: RegExp
  core?: boolean
}
export interface TopicRubric {
  id: string
  topic: string
  /** Phrase that identifies the topic in a request. */
  match: RegExp
  behaviors: RubricBehavior[]
}

const b = (label: string, pattern: RegExp, core = false): RubricBehavior => ({
  label,
  pattern,
  core
})

export const TOPIC_RUBRICS: TopicRubric[] = [
  {
    id: 'TOPIC-01',
    topic: 'API key generation and rotation',
    match: /api key generation and rotation/i,
    behaviors: [
      b(
        'cryptographically random keys',
        /randomBytes|crypto\.getRandomValues|secrets\.token|SecureRandom|crypto\/rand/i,
        true
      ),
      b('stored hash, not the raw key', /hash|sha-?256|digest|bcrypt|argon/i, true),
      b('one-time display', /once|one-time|only shown|never (?:shown|returned) again/i),
      b('scopes or tenant binding', /scope|tenant|owner/i),
      b('overlapping rotation', /rotat|overlap|previous key|grace/i, true),
      b('revoke and audit', /revok|audit/i)
    ]
  },
  {
    id: 'TOPIC-02',
    topic: 'TOTP-based two-factor authentication',
    match: /totp|two-factor|2fa/i,
    behaviors: [
      b('enrollment verification', /enrol|verify.*setup|confirm.*code/i, true),
      b('protected secret storage', /encrypt|protected|secret.*stor/i),
      b('bounded clock skew', /window|skew|drift|step/i, true),
      b('rate limiting', /rate.?limit|attempts|throttl|lockout/i),
      b('recovery codes', /recovery|backup code/i)
    ]
  },
  {
    id: 'TOPIC-03',
    topic: 'a circuit breaker around external API calls',
    match: /circuit breaker/i,
    behaviors: [
      b('closed/open/half-open states', /half.?open/i, true),
      b('open after failures', /open/i, true),
      b('limited probes', /probe|trial|single request/i),
      b('timeout integration', /timeout|AbortController|deadline/i),
      b('error classification', /classif|retryable|transient|status ?code/i),
      b('recovery/backoff', /reset|cool ?down|backoff|recovery/i, true)
    ]
  },
  {
    id: 'TOPIC-04',
    topic: 'a multi-step form that saves progress',
    match: /multi-step form/i,
    behaviors: [
      b('per-step validation', /step.*(?:schema|valid)|valid.*step/i, true),
      b('versioned draft', /version|draft/i, true),
      b('autosave ordering or debounce', /debounce|autosave|save.*(?:order|latest)/i),
      b('navigation and restore', /restore|resume|load.*draft|back/i, true),
      b('conflict handling', /conflict|stale|etag/i),
      b('final submission', /submit/i)
    ]
  },
  {
    id: 'TOPIC-05',
    topic: 'a secure password reset flow',
    match: /password reset/i,
    behaviors: [
      b('random token', /randomBytes|getRandomValues|secrets\.token|SecureRandom|token/i, true),
      b('stored token digest', /hash|digest|sha-?256/i, true),
      b('expiry', /expir|ttl|valid until|maxAge/i, true),
      b('single use', /single.?use|one.?time|delete.*token|used(?:At)?\b|consume/i, true),
      b('anti-enumeration', /enumerat|same response|whether.*exists|generic message/i),
      b('session invalidation', /session|revoke|sign.?out|logout/i),
      b('rate limits', /rate.?limit|throttl|attempts/i)
    ]
  },
  {
    id: 'TOPIC-06',
    topic: 'audit logging for sensitive operations',
    match: /audit logging/i,
    behaviors: [
      b('actor, action, target, time, outcome', /actor|user(?:Id)?/i, true),
      b('action and target', /action/i, true),
      b('redaction', /redact|mask|omit/i),
      b('durable append', /append|insert|immutable|write.?once/i, true),
      b('transaction or outbox', /transaction|outbox/i),
      b(
        'tamper evidence or access control',
        /tamper|hash chain|signature|access control|permission/i
      )
    ]
  },
  {
    id: 'TOPIC-07',
    topic: 'background job processing with exponential backoff',
    match: /background job processing/i,
    behaviors: [
      b('durable job state', /status|state|attempts/i, true),
      b('exponential delay', /\*\*|Math\.pow|2 \^|exponential|<<\s*attempt/i, true),
      b('jitter and cap', /jitter|Math\.random|cap|max(?:imum)?Delay|Math\.min/i, true),
      b('idempotent handlers', /idempot/i),
      b('retry classification', /retryable|permanent|transient/i),
      b('dead-letter policy', /dead.?letter|dlq|give up|max(?:imum)? attempts/i)
    ]
  },
  {
    id: 'TOPIC-08',
    topic: 'bulk operations that report progress',
    match: /bulk operations/i,
    behaviors: [
      b('job identity', /job ?id|operation ?id|id\b/i, true),
      b('numerator and denominator', /total|processed|completed|done\s*\/|of\b/i, true),
      b('per-item failure accounting', /fail(?:ed|ures)/i, true),
      b('idempotence', /idempot/i),
      b('cancellation', /cancel|abort/i)
    ]
  },
  {
    id: 'TOPIC-09',
    topic: 'cache invalidation after data changes',
    match: /cache invalidation/i,
    behaviors: [
      b('key scope or versioning', /key|version/i, true),
      b('invalidate after commit', /commit|after.*(?:write|save|update)|invalidate/i, true),
      b('TTL', /ttl|expire|maxAge/i),
      b('concurrent updates', /concurren|race|lock|compare/i),
      b('stampede handling', /stampede|single.?flight|coalesc|dogpile/i)
    ]
  },
  {
    id: 'TOPIC-10',
    topic: 'cursor-based pagination for a large dataset',
    match: /cursor-based pagination/i,
    behaviors: [
      b('stable ordering', /order by|sort/i, true),
      b('unique tie-breaker', /\bid\b|tie.?break/i, true),
      b('opaque or validated cursor', /base64|encode|decode|opaque|valid/i, true),
      b('limit', /limit|page ?size|take/i, true),
      b('next-page query', />\s*\$?\??|after|next/i)
    ]
  },
  {
    id: 'TOPIC-11',
    topic: 'database connection pooling',
    match: /connection pooling/i,
    behaviors: [
      b('bounded pool size', /max|size|limit/i, true),
      b('acquire and release', /release|acquire|connect\(|client\.release|finally/i, true),
      b('timeouts or backpressure', /timeout|wait|queue/i),
      b('shutdown', /end\(|close|shutdown|drain/i, true),
      b('transaction boundaries', /transaction|begin|commit|rollback/i)
    ]
  },
  {
    id: 'TOPIC-12',
    topic: 'distributed tracing across services',
    match: /distributed tracing/i,
    behaviors: [
      b('context propagation', /propagat|traceparent|context|inject|extract/i, true),
      b('spans and error status', /span/i, true),
      b('error status', /status|recordException|error/i),
      b('sampling', /sampl/i),
      b('exporter failure isolation', /exporter|batch/i)
    ]
  },
  {
    id: 'TOPIC-13',
    topic: 'environment-specific configuration loading',
    match: /environment-specific configuration/i,
    behaviors: [
      b('typed schema validation', /schema|zod|pydantic|valid/i, true),
      b('precedence', /precedence|override|default/i, true),
      b('required values', /required|missing/i, true),
      b('secrets separated from client-safe values', /secret|public|client/i),
      b('startup failure diagnostics', /throw|exit|fail/i)
    ]
  },
  {
    id: 'TOPIC-14',
    topic: 'error boundaries that support retry',
    match: /error boundar/i,
    behaviors: [
      b('fallback UI', /fallback/i, true),
      b('reset or retry', /reset|retry/i, true),
      b('error state', /error/i, true),
      b('async and event-handler limits', /async|event handler|promise/i),
      b('bounded retry', /max|attempt|limit/i)
    ]
  },
  {
    id: 'TOPIC-15',
    topic: 'exporting filtered data to CSV',
    match: /export\w* filtered data to csv/i,
    behaviors: [
      b('reuse filter semantics', /filter/i, true),
      b('streaming', /stream|pipe|cursor|chunk/i),
      b('quoting, newlines and encoding', /quote|escape|"\\""|replace/i, true),
      b('formula-injection handling', /formula|=|\+|-|@|injection/i),
      b('authorization', /authori|permission|owner/i)
    ]
  },
  {
    id: 'TOPIC-16',
    topic: 'feature flags that can be toggled without redeploying',
    match: /feature flags/i,
    behaviors: [
      b('typed flag keys', /key|type|enum/i, true),
      b('safe defaults', /default/i, true),
      b('targeting or tenant scope', /target|tenant|user|percent|rollout/i),
      b('refresh without redeploy', /refresh|poll|subscribe|reload|ttl/i, true),
      b('provider outage', /outage|fallback|catch|unavailable/i)
    ]
  },
  {
    id: 'TOPIC-17',
    topic: 'file uploads with progress tracking and cancellation',
    match: /file uploads with progress/i,
    behaviors: [
      b('progress', /progress|loaded|total/i, true),
      b('cancellation', /abort|cancel/i, true),
      b('server validation and size limits', /size|limit|valid|mime/i),
      b('temporary-file cleanup', /cleanup|unlink|remove|delete/i),
      b('retry policy', /retry/i)
    ]
  },
  {
    id: 'TOPIC-18',
    topic: 'forcing logout across all devices',
    match: /logout across all devices/i,
    behaviors: [
      b('session registry or revocation version', /session|version|revoc|tokenVersion/i, true),
      b('refresh-token invalidation', /refresh/i, true),
      b('access-token validity window', /access token|expir|ttl|short/i),
      b('enforcement on each request', /check|verify|middleware/i)
    ]
  },
  {
    id: 'TOPIC-19',
    topic: 'generating image thumbnails on the fly',
    match: /image thumbnails/i,
    behaviors: [
      b('resize', /resize|scale|thumbnail/i, true),
      b('aspect ratio', /aspect|ratio|fit|contain|cover/i, true),
      b('input byte and pixel limits', /limit|max|size/i),
      b('EXIF orientation', /exif|orient|rotate/i),
      b('cache keys', /cache/i)
    ]
  },
  {
    id: 'TOPIC-20',
    topic: 'graceful shutdown of a long-running process',
    match: /graceful shutdown/i,
    behaviors: [
      b('signal handling', /SIGTERM|SIGINT|signal/i, true),
      b('stop accepting work', /close|stop|accept/i, true),
      b('drain inflight work', /drain|inflight|in-flight|await|wait/i, true),
      b('bounded deadline', /timeout|deadline|setTimeout/i),
      b('repeated signals', /again|second|force|once/i)
    ]
  },
  {
    id: 'TOPIC-21',
    topic: 'health checks that verify downstream dependencies',
    match: /health checks/i,
    behaviors: [
      b('separate liveness and readiness', /liveness|readiness|ready|live/i, true),
      b('per-dependency timeout', /timeout/i, true),
      b('failure aggregation', /status|healthy|unhealthy|degraded|fail/i, true),
      b('bounded concurrency', /Promise\.all|allSettled|concurren|gather/i),
      b('cached or lightweight probes', /cache|SELECT 1|ping|lightweight/i)
    ]
  },
  {
    id: 'TOPIC-22',
    topic: 'idempotent API endpoints',
    match: /idempotent api/i,
    behaviors: [
      b('idempotency key', /idempotency.?key|Idempotency-Key/i, true),
      b('request hash', /hash|fingerprint|body/i),
      b('atomic ownership', /atomic|unique|lock|insert.*conflict|transaction/i, true),
      b(
        'response replay',
        /replay|stored response|cached response|return.*(?:saved|previous)/i,
        true
      ),
      b('expiry', /expir|ttl/i)
    ]
  },
  {
    id: 'TOPIC-23',
    topic: 'infinite scroll using cursor pagination',
    match: /infinite scroll/i,
    behaviors: [
      b('cursor', /cursor/i, true),
      b('duplicate prevention', /dedup|duplicate|Set\(|seen/i),
      b('stale request cancellation', /abort|cancel|stale/i),
      b('termination', /hasMore|has_more|end|done|null/i, true),
      b('load trigger', /IntersectionObserver|scroll|load more/i, true)
    ]
  },
  {
    id: 'TOPIC-24',
    topic: 'optimistic updates for a list of items',
    match: /optimistic updates/i,
    behaviors: [
      b('temporary identity', /temp|tmp|clientId|optimistic id/i, true),
      b('rollback', /rollback|revert|restore|previous/i, true),
      b('pending UI', /pending|loading|saving/i),
      b('reconciliation with server', /reconcil|replace|server/i, true),
      b('out-of-order acknowledgements', /order|version|sequence/i)
    ]
  },
  {
    id: 'TOPIC-25',
    topic: 'per-user rate limiting',
    match: /rate limiting/i,
    behaviors: [
      b('stable user or tenant key', /user(?:Id)?|tenant|key/i, true),
      b('counter or token bucket', /bucket|count|window|tokens/i, true),
      b('expiry', /expir|ttl|reset|window/i, true),
      b('retry signaling', /429|Retry-After|retry/i, true),
      b('storage failures', /redis|fail|catch|unavailable/i)
    ]
  },
  {
    id: 'TOPIC-26',
    topic: 'real-time presence indicators',
    match: /presence indicators/i,
    behaviors: [
      b('session or device identity', /session|device|connection/i, true),
      b('heartbeat and TTL', /heartbeat|ping|ttl|expire/i, true),
      b('offline transitions', /offline|away|stale/i, true),
      b('reconnect', /reconnect/i),
      b('multiple devices', /devices|connections|count/i)
    ]
  },
  {
    id: 'TOPIC-27',
    topic: 'request validation middleware',
    match: /request validation middleware/i,
    behaviors: [
      b('schema', /schema|zod|joi|pydantic|valid/i, true),
      b('structured errors', /400|422|errors|issues/i, true),
      b('handler not run on failure', /return|next\(|throw/i, true),
      b('size limits', /limit|size/i),
      b('unknown-field policy', /strict|unknown|additional/i)
    ]
  },
  {
    id: 'TOPIC-28',
    topic: 'role-based access control',
    match: /role-based access control|\brbac\b/i,
    behaviors: [
      b('server-side policy evaluation', /permission|policy|can\(|authorize/i, true),
      b('deny by default', /deny|forbid|403|default/i, true),
      b('role mapping', /role/i, true),
      b('object and tenant scope', /tenant|owner|resource|object/i),
      b('authentication separate from authorization', /authent|identity|user/i)
    ]
  },
  {
    id: 'TOPIC-29',
    topic: 'rotating secrets without downtime',
    match: /rotating secrets/i,
    behaviors: [
      b('versioned secrets', /version|current|previous/i, true),
      b('overlap period', /overlap|both|either|grace/i, true),
      b('atomic switch', /atomic|swap|promote/i),
      b('cache invalidation', /cache|refresh|reload/i),
      b('rollback and redacted logging', /rollback|redact/i)
    ]
  },
  {
    id: 'TOPIC-30',
    topic: 'sanitizing user-generated rich text',
    match: /sanitiz\w* user-generated rich text/i,
    behaviors: [
      b('explicit allowlist', /allow(?:ed)?(?:Tags|Attributes|list)?|whitelist/i, true),
      b('maintained sanitizer', /DOMPurify|sanitize-html|bleach|nh3|sanitizer/i, true),
      b('URL scheme checks', /javascript:|href|scheme|url/i),
      b('server-side enforcement', /server|on save|before stor/i)
    ]
  },
  {
    id: 'TOPIC-31',
    topic: 'scheduled report generation',
    match: /scheduled report generation/i,
    behaviors: [
      b('schedule and timezone', /cron|schedule|timezone|tz/i, true),
      b('idempotent jobs', /idempot|unique|already/i),
      b('overlap policy', /overlap|lock|running/i),
      b('authorization and data scope', /authori|scope|tenant|owner/i),
      b('storage and delivery', /store|upload|email|deliver|send/i, true)
    ]
  },
  {
    id: 'TOPIC-32',
    topic: 'search that supports filters, sorting, and highlighting',
    match: /search that supports filters/i,
    behaviors: [
      b('validated filters', /filter|valid|allow/i, true),
      b('stable sort with tie-break', /sort|order/i, true),
      b('pagination', /limit|offset|cursor|page/i),
      b('escaped highlighting', /highlight|escape|<mark>|mark/i, true),
      b('indexed query', /index|full.?text|tsvector|match/i)
    ]
  },
  {
    id: 'TOPIC-33',
    topic: 'seeding realistic test data',
    match: /seeding realistic test data/i,
    behaviors: [
      b('deterministic seed', /seed|faker\.seed|random\(\s*\d|deterministic/i, true),
      b('schema-valid fixtures', /insert|create|schema|id\b/i, true),
      b('bounded size', /count|length|limit|times/i, true),
      b('cleanup', /cleanup|truncate|delete|reset/i),
      b('environment guard', /NODE_ENV|production|environment|env/i)
    ]
  },
  {
    id: 'TOPIC-34',
    topic: 'soft deletes with the ability to restore',
    match: /soft deletes?/i,
    behaviors: [
      b('deletion marker', /deleted_?at|is_?deleted|deleted\b/i, true),
      b(
        'default queries exclude deleted rows',
        /filter|where|IS NULL|=== null|== None|exclude/i,
        true
      ),
      b('restore', /restore|undelete|recover/i, true),
      b('uniqueness collisions', /unique|collision|conflict/i),
      b('authorization and related records', /authori|related|cascade|owner/i)
    ]
  },
  {
    id: 'TOPIC-35',
    topic: 'structured JSON logging',
    match: /structured json logging/i,
    behaviors: [
      b('stable schema and levels', /level|info|error|warn/i, true),
      b('JSON output', /JSON\.stringify|json|pino|structlog|zap/i, true),
      b('contextual IDs', /request ?id|trace ?id|correlation|context/i, true),
      b('redaction', /redact|mask/i),
      b('error stacks', /stack/i)
    ]
  },
  {
    id: 'TOPIC-36',
    topic: 'transactional emails using templates',
    match: /transactional emails/i,
    behaviors: [
      b('escaped templates', /template|escape|render/i, true),
      b('provider adapter', /provider|send|transport|client/i, true),
      b('durable enqueue or outbox', /outbox|queue|enqueue|job/i),
      b('idempotency', /idempot|message ?id|dedup/i),
      b('transient retry', /retry/i)
    ]
  },
  {
    id: 'TOPIC-37',
    topic: 'user authentication with magic links',
    match: /magic links?/i,
    behaviors: [
      b('random token', /randomBytes|getRandomValues|secrets\.token|SecureRandom|token/i, true),
      b('stored token digest', /hash|digest|sha-?256/i, true),
      b('expiry', /expir|ttl|maxAge/i, true),
      b('single use', /single.?use|one.?time|delete|used(?:At)?\b|consume/i, true),
      b('safe redirect allowlist', /redirect|allow/i),
      b('anti-enumeration response', /enumerat|same response|whether.*exists/i),
      b('session creation', /session|cookie|jwt/i, true)
    ]
  },
  {
    id: 'TOPIC-38',
    topic: 'user notification preferences',
    match: /notification preferences/i,
    behaviors: [
      b('preference model and defaults', /default|preference/i, true),
      b('channel and topic scope', /channel|email|sms|push|topic/i, true),
      b('authorization', /authori|owner|user(?:Id)?/i),
      b('evaluation at delivery time', /deliver|send|should(?:Send|Notify)/i, true),
      b('cache invalidation', /cache/i)
    ]
  },
  {
    id: 'TOPIC-39',
    topic: 'webhook signature verification',
    match: /webhook signature/i,
    behaviors: [
      b('raw request bytes', /raw|Buffer|bytes|body/i, true),
      b('HMAC signature', /hmac|createHmac|sha256/i, true),
      b(
        'constant-time comparison',
        /timingSafeEqual|compare_digest|constant.?time|ConstantTimeCompare/i,
        true
      ),
      b('timestamp replay window', /timestamp|replay|tolerance|window/i),
      b('key rotation', /rotat|secrets\b|keys\b/i)
    ]
  },
  {
    id: 'TOPIC-40',
    topic: 'zero-downtime database migrations',
    match: /zero-downtime database migrations/i,
    behaviors: [
      b('expand, backfill, contract', /expand|backfill|contract/i, true),
      b('old and new application compatibility', /compatib|both versions|old and new|dual/i, true),
      b('bounded lock time', /lock|concurrently|batch/i),
      b('restartable backfill', /batch|resume|restart|chunk/i),
      b('rollback constraints', /rollback|revert/i)
    ]
  }
]

export function rubricForTopic(idOrText: string): TopicRubric | undefined {
  return (
    TOPIC_RUBRICS.find((rubric) => rubric.id === idOrText) ??
    TOPIC_RUBRICS.find((rubric) => rubric.match.test(idOrText))
  )
}
