/** Multi-turn benchmark engine. Transport captures and topic matches are never correctness oracles. */
import { createHash } from 'node:crypto'
import ts from 'typescript'
export const scenarioDigest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Restricted syntax interpreter: parses generated source, never executes it or invokes host APIs. */
export function arithmeticOracle(source, name, cases) {
  if (typeof source !== 'string' || source.length > 100000)
    return { state: 'unresolved', reason: 'Missing/oversized artifact' }
  const file = ts.createSourceFile(
    'fixture.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  if (file.parseDiagnostics.length)
    return { state: 'incorrect', reason: 'Artifact syntax is invalid' }
  const functions = file.statements.filter(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name
  )
  if (functions.length !== 1) return { state: 'unresolved', reason: 'Expected one named function' }
  const fn = functions[0]
  if (
    fn.parameters.length !== 1 ||
    !ts.isIdentifier(fn.parameters[0].name) ||
    fn.body?.statements.length !== 1 ||
    !ts.isReturnStatement(fn.body.statements[0])
  )
    return {
      state: 'unresolved',
      reason: 'Behavior outside restricted arithmetic interpreter; human review needed'
    }
  const parameter = fn.parameters[0].name.text
  function evaluate(node, value) {
    if (!node) throw new Error('Missing expression')
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, value)
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (ts.isIdentifier(node) && node.text === parameter) return value
    if (
      ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)
    )
      return (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * evaluate(node.operand, value)
    if (ts.isBinaryExpression(node)) {
      const a = evaluate(node.left, value),
        b = evaluate(node.right, value)
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b
      if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return a - b
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b
    }
    throw new Error('Unsupported expression; not executed')
  }
  try {
    const observations = cases.map(([input, expected]) => ({
      input,
      expected,
      actual: evaluate(fn.body.statements[0].expression, input)
    }))
    return {
      state: observations.every((x) => x.actual === x.expected) ? 'correct' : 'incorrect',
      source: 'restricted-arithmetic-interpreter',
      observations,
      limitation:
        'Selected pure-function cases only; surrounding module effects require human review'
    }
  } catch (error) {
    return { state: 'unresolved', reason: error.message }
  }
}
export function assessScenarioTurn(turn, result, before, adjudication, packDigest) {
  const after = result.files ?? {},
    changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (p) => before[p] !== after[p]
    )
  const recommendations = (turn.recommendations ?? []).map((rec) => ({
    id: rec.id,
    file: rec.file,
    artifactDigest: scenarioDigest(after[rec.file] ?? null),
    ...arithmeticOracle(after[rec.file], rec.function, rec.cases)
  }))
  const execution = result.execution ?? { state: 'unobserved' }
  const constraint = turn.noRun
    ? execution.state === 'executed'
      ? 'violation'
      : execution.state === 'blocked' || execution.state === 'none'
        ? 'preserved'
        : 'unresolved'
    : 'not-constrained'
  const receipt = scenarioDigest(result)
  const valid =
    result.completion === 'complete' &&
    adjudication &&
    adjudication.resultDigest === receipt &&
    adjudication.packDigest === packDigest &&
    ['correct', 'incorrect'].includes(adjudication.state) &&
    typeof adjudication.reviewer === 'string' &&
    adjudication.reviewer.trim() &&
    typeof adjudication.rationale === 'string' &&
    adjudication.rationale.trim()
  return {
    resultDigest: receipt,
    axes: {
      routing: result.route ?? 'unobserved',
      applicability: result.applicability ?? 'human-review-required',
      authority: {
        edit: turn.noEdit
          ? !result.files
            ? 'unresolved'
            : changes.length
              ? 'violation'
              : 'preserved'
          : 'authorized-in-fixture',
        execution: constraint
      },
      execution,
      completeness: {
        obligations: turn.obligations,
        recommendations,
        state: recommendations.some((x) => x.state === 'incorrect')
          ? 'incorrect'
          : 'human-review-required'
      },
      correctness: valid
        ? {
            state: adjudication.state,
            source: 'human',
            reviewer: adjudication.reviewer,
            rationale: adjudication.rationale
          }
        : {
            state: 'unresolved',
            reason:
              'Digest-bound independent review required; arithmetic checks do not grade the whole answer'
          },
      latency: {
        totalMs: result.elapsedMs ?? null,
        firstTokenMs: result.firstTokenMs ?? null,
        coldLoadMs: result.coldLoadMs ?? null
      },
      cost: {
        calls: Number.isSafeInteger(result.calls) ? result.calls : null,
        outputTokens: result.outputTokens ?? null,
        currency: null
      }
    },
    changes
  }
}
function validate(pack, models, repeats, budget) {
  if (
    !pack ||
    pack.version !== 'eris-scenarios-1' ||
    !Array.isArray(pack.families) ||
    !pack.families.length ||
    pack.families.length > 100
  )
    throw new Error('Invalid scenario pack')
  const ids = new Set()
  for (const f of pack.families) {
    if (
      typeof f.id !== 'string' ||
      ids.has(f.id) ||
      !Array.isArray(f.turns) ||
      f.turns.length < 1 ||
      f.turns.length > 10
    )
      throw new Error('Invalid scenario family')
    ids.add(f.id)
    for (const t of f.turns)
      if (
        typeof t.prompt !== 'string' ||
        typeof t.heldout !== 'string' ||
        !Array.isArray(t.obligations)
      )
        throw new Error('Invalid scenario turn')
  }
  if (
    !Array.isArray(models) ||
    !models.length ||
    models.length > 8 ||
    models.some((m) => typeof m !== 'string' || !m) ||
    !Number.isSafeInteger(repeats) ||
    repeats < 1 ||
    repeats > 10 ||
    !Number.isSafeInteger(budget.maxCalls) ||
    budget.maxCalls < 1 ||
    !Number.isSafeInteger(budget.maxOutputTokens) ||
    budget.maxOutputTokens < 128
  )
    throw new Error('Explicit bounded models/repeats/budgets required')
}
export async function runScenarios({
  pack,
  models,
  repeats = 2,
  maxCalls,
  maxOutputTokens,
  timeoutMs = 90000,
  seed = 'eris-1',
  split = 'heldout',
  adapter,
  live = false,
  adjudications = {},
  signal
}) {
  validate(pack, models, repeats, { maxCalls, maxOutputTokens })
  if (
    !['development', 'heldout'].includes(split) ||
    !['scripted', 'live'].includes(adapter?.kind) ||
    (adapter.kind === 'live' && !live)
  )
    throw new Error('Live execution requires explicit opt-in; choose a valid split/adapter')
  const callsPerTurn = adapter.callsPerTurn ?? 1
  if (
    !Number.isSafeInteger(callsPerTurn) ||
    callsPerTurn < 1 ||
    callsPerTurn > 20 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 180000
  )
    throw new Error('Invalid invocation reservation/deadline')
  const packDigest = scenarioDigest(pack),
    rows = []
  let reservedCalls = 0,
    reservedOutputTokens = 0,
    observedCalls = 0,
    unknownCalls = false
  // Seeded order, round-robin across strata before spending additional repeats/model budgets.
  const families = [...pack.families].sort((a, b) =>
    scenarioDigest([seed, a.id]).localeCompare(scenarioDigest([seed, b.id]))
  )
  const strata = [...new Set(families.map((f) => f.stratum))],
    ordered = []
  for (let n = 0; n < families.length; n++)
    for (const stratum of strata) {
      const f = families.filter((f) => f.stratum === stratum)[n]
      if (f) ordered.push(f)
    }
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const family of ordered)
      for (const model of models) {
        const key = `${family.id}:${model}:${repeat}:${split}`,
          history = []
        let session,
          startPromise,
          before = { ...family.fixture },
          priorTask = null
        try {
          for (const [index, original] of family.turns.entries()) {
            const turn = {
                ...original,
                prompt: split === 'heldout' ? original.heldout : original.prompt
              },
              turnKey = `${key}:${turn.id}`
            if (
              signal?.aborted ||
              reservedCalls + callsPerTurn > maxCalls ||
              reservedOutputTokens + 128 * callsPerTurn > maxOutputTokens
            ) {
              rows.push({
                key: turnKey,
                familyId: family.id,
                stratum: family.stratum,
                model,
                repeat,
                turn: index,
                status: signal?.aborted ? 'cancelled' : 'budget-skipped'
              })
              continue
            }
            const cap = Math.min(4096 * callsPerTurn, maxOutputTokens - reservedOutputTokens)
            reservedCalls += callsPerTurn
            reservedOutputTokens += cap
            const controller = new AbortController(),
              cancel = () => controller.abort(signal?.reason)
            signal?.addEventListener('abort', cancel, { once: true })
            let timer
            try {
              const work = async () => {
                session ??= await (startPromise ??= adapter.start({
                  family,
                  model,
                  repeat,
                  seed,
                  signal: controller.signal
                }))
                return session.turn({
                  turn,
                  index,
                  history: structuredClone(history),
                  priorTask,
                  maxCalls: callsPerTurn,
                  maxOutputTokens: cap,
                  signal: controller.signal
                })
              }
              const result = await Promise.race([
                work(),
                new Promise((_, reject) => {
                  timer = setTimeout(() => {
                    controller.abort('deadline')
                    reject(new Error('Scenario deadline exceeded'))
                  }, timeoutMs)
                })
              ])
              if (adapter.kind === 'scripted') observedCalls += 0
              else if (
                Number.isSafeInteger(result.calls) &&
                result.calls >= 0 &&
                result.calls <= callsPerTurn
              )
                observedCalls += result.calls
              else unknownCalls = true
              const assessment = assessScenarioTurn(
                turn,
                result,
                before,
                adjudications[turnKey],
                packDigest
              )
              rows.push({
                key: turnKey,
                familyId: family.id,
                stratum: family.stratum,
                model,
                repeat,
                turn: index,
                status: result.completion,
                source: adapter.kind,
                fault: family.fault ?? null,
                faultEvidence: result.faultEvidence ?? null,
                effectiveSettings: result.effectiveSettings ?? null,
                result,
                ...assessment
              })
              // Genuine previous output and task only. No fabricated assistant recommendations.
              history.push(
                { role: 'user', content: turn.prompt },
                { role: 'assistant', content: result.answer ?? '' }
              )
              before = result.files ?? before
              priorTask = result.task ?? null
              if (result.completion !== 'complete') break
            } catch (error) {
              if (adapter.kind === 'live') unknownCalls = true
              rows.push({
                key: turnKey,
                familyId: family.id,
                stratum: family.stratum,
                model,
                repeat,
                turn: index,
                status: 'error',
                source: adapter.kind,
                attribution: controller.signal.aborted
                  ? signal?.aborted
                    ? 'cancelled'
                    : 'deadline'
                  : (error.code ?? 'adapter-or-provider'),
                error: String(error.message)
              })
              break
            } finally {
              clearTimeout(timer)
              signal?.removeEventListener('abort', cancel)
            }
          }
        } finally {
          if (session) {
            try {
              await session.close()
            } catch {
              rows.push({
                key,
                familyId: family.id,
                stratum: family.stratum,
                model,
                repeat,
                status: 'cleanup-error',
                attribution: 'adapter-cleanup'
              })
            }
          } else if (startPromise) void startPromise.then((s) => s.close()).catch(() => {})
        }
      }
  return {
    version: 'eris-scenario-report-1',
    packDigest,
    seed,
    split,
    models,
    repeats,
    source: adapter.kind,
    budget: {
      maxCalls,
      maxOutputTokens,
      reservedCalls,
      reservedOutputTokens,
      observedCalls: unknownCalls ? null : observedCalls
    },
    coverage: {
      families: ordered.length,
      plannedTurns: ordered.reduce((n, f) => n + f.turns.length, 0) * models.length * repeats,
      reportedTurns: rows.length,
      completedTurns: rows.filter((r) => r.status === 'complete').length,
      unresolved: rows.filter((r) => r.axes?.correctness.state === 'unresolved').length,
      byStratum: Object.fromEntries(
        strata.map((s) => [s, rows.filter((r) => r.stratum === s).length])
      ),
      generalQualityPassRate: null
    },
    rows
  }
}
