/**
 * RAM-CTX-062 (#234) measurement gate: how much does lexical recall miss when the user
 * paraphrases what the conversation said? §12.9 allows embeddings only if this
 * benchmark shows a material gap. It runs the production ContextMemoryStore ranking
 * with no model, so it measures lexical recall alone.
 */
import type { ChatMessage } from '../src/shared/settings-schema'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { ContextMemorySettingsSchema, emptyMemoryControls } from '../src/shared/context-memory'

export type ParaphraseCategory =
  'lexical-control' | 'synonym' | 'abbreviation' | 'inflection' | 'description'
export type ParaphraseCase = {
  id: string
  category: ParaphraseCategory
  /** What the conversation said, earlier in the thread. */
  source: string
  /** How the user later refers to it. */
  query: string
  /** Shares surface words with the query but is not the answer. */
  distractor: string
}

/**
 * Hand-labelled. Controls repeat the source's key term, so they show the store itself
 * works; every other case avoids sharing the source's content words with the query
 * except where the category is defined by a word form (inflection, abbreviation).
 */
export const PARAPHRASE_CASES: ParaphraseCase[] = [
  // Controls: the query reuses the source's own key terms.
  {
    id: 'ctl-oauth',
    category: 'lexical-control',
    source: 'The OAuth callback handler drops the state parameter on redirect',
    query: 'what was wrong with the OAuth callback handler?',
    distractor: 'The payment handler logs every redirect'
  },
  {
    id: 'ctl-currency',
    category: 'lexical-control',
    source: 'Invoice currency for the Zurich entity is CHF',
    query: 'which invoice currency did we pick?',
    distractor: 'The Zurich office opens at nine'
  },
  {
    id: 'ctl-retry',
    category: 'lexical-control',
    source: 'Webhook retry backoff is capped at 30 seconds',
    query: 'what is the webhook retry backoff cap?',
    distractor: 'The webhook URL moved to the new domain'
  },
  {
    id: 'ctl-postgres',
    category: 'lexical-control',
    source: 'We chose Postgres over MySQL for the reporting service',
    query: 'did we choose Postgres for reporting?',
    distractor: 'MySQL dumps are archived weekly'
  },
  {
    id: 'ctl-flag',
    category: 'lexical-control',
    source: 'The checkout redesign ships behind the new_checkout feature flag',
    query: 'which feature flag gates the checkout redesign?',
    distractor: 'The checkout button colour is final'
  },
  {
    id: 'ctl-timeout',
    category: 'lexical-control',
    source: 'Gateway timeout is 45 seconds for the export endpoint',
    query: 'what gateway timeout does the export endpoint use?',
    distractor: 'Export files are named by date'
  },
  // Synonyms and near-synonyms: same meaning, different words.
  {
    id: 'syn-login',
    category: 'synonym',
    source: 'The OAuth callback handler drops the state parameter on redirect',
    query: 'remind me what the sign-in bug was',
    distractor: 'Sign up page copy is approved'
  },
  {
    id: 'syn-money',
    category: 'synonym',
    source: 'Invoice currency for the Zurich entity is CHF',
    query: 'what money do we bill the Swiss company in?',
    distractor: 'Billing emails go out on Mondays'
  },
  {
    id: 'syn-delete',
    category: 'synonym',
    source: 'Removing an account must purge uploads within 30 days',
    query: 'how long until files are erased after someone deletes their profile?',
    distractor: 'Profile pictures are cropped to a square'
  },
  {
    id: 'syn-slow',
    category: 'synonym',
    source: 'The dashboard query takes 12 seconds because of a missing index on orders.created_at',
    query: 'why is the dashboard sluggish?',
    distractor: 'The dashboard header uses the brand font'
  },
  {
    id: 'syn-crash',
    category: 'synonym',
    source: 'The worker process segfaults when the image is larger than 40 megapixels',
    query: 'when does the background job crash?',
    distractor: 'Background jobs are listed in the admin panel'
  },
  {
    id: 'syn-forbid',
    category: 'synonym',
    source: 'Never push directly to the release branch',
    query: 'am I allowed to commit straight to the release line?',
    distractor: 'The release notes template lives in docs'
  },
  {
    id: 'syn-cheap',
    category: 'synonym',
    source: 'Use the spot instances for nightly builds to cut cost',
    query: 'how did we make the overnight CI less expensive?',
    distractor: 'Nightly reports are emailed to the team'
  },
  // Abbreviations and expansions.
  {
    id: 'abbr-db',
    category: 'abbreviation',
    source: 'The database must stay on Oracle 19c for the audit',
    query: 'which DB version is required?',
    distractor: 'The audit team meets on Fridays'
  },
  {
    id: 'abbr-k8s',
    category: 'abbreviation',
    source: 'Deploys go to the Kubernetes cluster in eu-west-1',
    query: 'where does k8s run?',
    distractor: 'The cluster dashboard needs a new logo'
  },
  {
    id: 'abbr-ci',
    category: 'abbreviation',
    source: 'Continuous integration runs the Windows agents job on every pull request',
    query: 'what does CI run on a PR?',
    distractor: 'The Windows installer is signed'
  },
  {
    id: 'abbr-auth',
    category: 'abbreviation',
    source: 'Authentication tokens expire after 15 minutes',
    query: 'how long do auth tokens last?',
    distractor: 'Token colours in the editor were changed'
  },
  {
    id: 'abbr-env',
    category: 'abbreviation',
    source: 'Staging environment variables live in the vault under app/staging',
    query: 'where are the staging env vars?',
    distractor: 'Staging was rebuilt last week'
  },
  // Inflection: the same word in another form.
  {
    id: 'inf-retried',
    category: 'inflection',
    source: 'Failed uploads are retried three times with jitter',
    query: 'how many times do we retry an upload that fails?',
    distractor: 'Upload size limit is 50 MB'
  },
  {
    id: 'inf-migration',
    category: 'inflection',
    source: 'We migrated the users table to UUID keys',
    query: 'what was the users migration about?',
    distractor: 'The users page lists admins first'
  },
  {
    id: 'inf-cached',
    category: 'inflection',
    source: 'Search results are cached for five minutes per tenant',
    query: 'how long is the search cache?',
    distractor: 'Search box placeholder text was updated'
  },
  {
    id: 'inf-validates',
    category: 'inflection',
    source: 'The form validates postcodes against the Royal Mail list',
    query: 'what does postcode validation check against?',
    distractor: 'The form submit button is blue'
  },
  {
    id: 'inf-deprecated',
    category: 'inflection',
    source: 'The v1 export endpoint is deprecated and returns a sunset header',
    query: 'what happens with the deprecation of export v1?',
    distractor: 'Export v2 supports CSV'
  },
  // Description: refers to the thing by what it does, sharing no content words.
  {
    id: 'desc-login-thing',
    category: 'description',
    source: 'The OAuth callback handler drops the state parameter on redirect',
    query: 'the login thing from earlier — what did we find?',
    distractor: 'We found a typo on the pricing page earlier'
  },
  {
    id: 'desc-rounding',
    category: 'description',
    source: 'Invoices round half-even for the Zurich entity',
    query: 'how do we handle cents on bills over there?',
    distractor: 'Bills over 10k need approval'
  },
  {
    id: 'desc-index',
    category: 'description',
    source: 'Add a composite index on orders(customer_id, created_at)',
    query: 'what was the fix for the slow customer history page?',
    distractor: 'The customer history page has a new layout'
  },
  {
    id: 'desc-secrets',
    category: 'description',
    source: 'API keys are loaded from 1Password at startup, never from .env files',
    query: 'where should credentials come from?',
    distractor: 'Startup time improved after the refactor'
  },
  {
    id: 'desc-flake',
    category: 'description',
    source: 'The e2e checkout spec fails intermittently because the Stripe mock starts late',
    query: 'why does that test sometimes go red?',
    distractor: 'The test report is uploaded as an artifact'
  }
]

const NOISE = 40
const K = [1, 3, 5] as const

function thread(c: ParaphraseCase): ChatMessage[] {
  return [
    { id: 'source', role: 'user', content: c.source, createdAt: 1 },
    { id: 'distractor', role: 'user', content: c.distractor, createdAt: 2 },
    ...Array.from({ length: NOISE }, (_, i) => ({
      id: `noise-${i}`,
      role: 'user' as const,
      content: `Routine status update ${i}: nothing blocking today`,
      createdAt: 3 + i
    }))
  ]
}

export type ParaphraseResult = {
  id: string
  category: ParaphraseCategory
  /** 1-based rank of the source among recalled facts, or null when it was not recalled. */
  rank: number | null
  distractorRank: number | null
}

export async function measureParaphraseRecall(cases = PARAPHRASE_CASES) {
  const results: ParaphraseResult[] = []
  for (const c of cases) {
    const store = new ContextMemoryStore()
    store.configure(ContextMemorySettingsSchema.parse({}))
    const messages = thread(c)
    store.install(
      'gate',
      {
        revision: 1,
        total: messages.length,
        records: messages.map((message, ordinal) => ({ ordinal, message })),
        controls: emptyMemoryControls(),
        partial: false
      },
      store.token('gate')
    )
    const { inspection } = await store.select('gate', c.query)
    const ranked = inspection.facts
      .filter((fact) => fact.kind !== 'pinned')
      .map((fact) => fact.sourceId)
    const rankOf = (id: string) => (ranked.indexOf(id) >= 0 ? ranked.indexOf(id) + 1 : null)
    results.push({
      id: c.id,
      category: c.category,
      rank: rankOf('source'),
      distractorRank: rankOf('distractor')
    })
  }
  const categories = [...new Set(cases.map((c) => c.category))]
  const summarize = (rows: ParaphraseResult[]) => ({
    cases: rows.length,
    ...Object.fromEntries(
      K.map((k) => [
        `recallAt${k}`,
        rows.filter((row) => row.rank !== null && row.rank <= k).length / rows.length
      ])
    ),
    misses: rows.filter((row) => row.rank === null).map((row) => row.id)
  })
  const paraphrased = results.filter((row) => row.category !== 'lexical-control')
  return {
    version: 1 as const,
    evidence: 'deterministic-lexical' as const,
    boundary: 'ContextMemoryStore.select ranking; no model, no embeddings, no provider call',
    noisePerThread: NOISE,
    byCategory: Object.fromEntries(
      categories.map((category) => [
        category,
        summarize(results.filter((row) => row.category === category))
      ])
    ) as Record<ParaphraseCategory, ReturnType<typeof summarize>>,
    paraphrased: summarize(paraphrased),
    results
  }
}
