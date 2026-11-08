import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getDefaults } from '../electron/main/services/settings'
import { markSimulatedSettings, runInDiagnosticsScope, SIMULATED_MODEL_REF } from '../electron/main/services/model-transport'
import { planInitialChatTurn, resolveChatTurnContract, buildChatTurnMessages } from '../electron/main/services/chat-turn'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent-runner'
import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'

const QUESTIONS = [
  { issue: 407, text: 'Go code the project', cancel: false },
  { issue: 413, text: 'generate those files here in the project', cancel: false },
  { issue: 406, text: 'generate those files', cancel: true }
]
const OUTPUTS: Record<string, object> = {
  'index.json': { property: {
    id: 'rental-1', title: 'Guest house', minimumNights: 2, nightlyPrice: 120,
    maximumGuests: 4, bedrooms: 2, bathrooms: 1, amenities: ['wifi', 'kitchen', 'parking'],
    cancellationPolicy: { refundableBeforeDays: 7, refundablePercent: 100 }
  }, currency: 'USD' },
  'registration.json': { registration: { enabled: true, requiresEmail: true }, passwordStorage: 'hash-only' },
  'calendar.json': { booking: { rejectOverlaps: true, allowPastDates: false }, timeZone: 'UTC' }
}

/** Installed-bundle regression, scripted models and fixture oracles; no live-model claim. */
export async function runBadAnswerSmoke(parent: string) {
  const cases = []
  for (const question of QUESTIONS) {
    const root = mkdtempSync(join(parent, 'bad-answer-'))
    const controller = new AbortController()
    const settings = markSimulatedSettings(structuredClone(getDefaults()))
    settings.models.connections = []
    settings.models.defaultModel = SIMULATED_MODEL_REF
    settings.agent.projectMemory = 'off'
    settings.images.enabled = false
    const scripts = [
      JSON.stringify({ name: 'tree', arguments: { path: '.' } }),
      ...Object.entries(OUTPUTS).map(([path, value]) => JSON.stringify({ name: 'write_file', arguments: { path, content: JSON.stringify(value, null, 2) + '\n' } })),
      'DONE: Created the three requested fixture files and checked their data.'
    ]
    let calls = 0, incomplete = false, stopped = false, checks = 0
    const changed = new Set<string>()
    const failures: string[] = []
    writeFileSync(join(root, 'README.md'), '# Rental website fixture\nGenerate the proposed configuration files here.\n')
    setWorkspaceTrusted(root, true)
    const checkArtifacts = () => {
      // Independent expected fields: neither answer prose nor the model's own status is an oracle.
      const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
      const registration = JSON.parse(readFileSync(join(root, 'registration.json'), 'utf8'))
      const calendar = JSON.parse(readFileSync(join(root, 'calendar.json'), 'utf8'))
      return index.property.minimumNights === 2 && index.currency === 'USD' &&
        registration.registration.requiresEmail === true && registration.passwordStorage === 'hash-only' &&
        calendar.booking.rejectOverlaps === true && calendar.booking.allowPastDates === false
    }
    try {
      await runInDiagnosticsScope({
        runId: randomUUID(), mode: 'simulated',
        onBlockedEffect: () => {},
        verify: () => {
          checks++
          let ok = false
          try { ok = checkArtifacts() } catch { /* not all outputs exist */ }
          return { ok, command: 'fixture-data-oracle', detail: ok ? 'Required fixture behavior fields passed' : 'Fixture output missing or incorrect' }
        },
        adapter: { kind: 'scripted', async *stream(request) {
          if (request.purpose === 'intent') { yield '{"intent":"edit","confidence":1}'; return }
          if (++calls > 12) throw new Error('Acceptance model-call budget exceeded')
          if (question.cancel && existsSync(join(root, 'index.json'))) {
            controller.abort()
            throw Object.assign(new Error('Injected cancellation after applied write'), { name: 'AbortError' })
          }
          const reply = scripts.shift()
          if (!reply) throw new Error('Unexpected extra model step')
          yield reply
        } }
      }, async () => {
        const history = [{ role: 'assistant' as const, content: 'Create index.json, registration.json, and calendar.json for this rental website.' }]
        const input = { requestId: randomUUID(), workspacePath: root, settings, text: question.text,
          model: SIMULATED_MODEL_REF, mode: 'agent' as const, history, priorTask: null,
          getSecret: () => null, signal: controller.signal }
        const initial = await planInitialChatTurn(input)
        const { plan, task } = await resolveChatTurnContract(input, initial)
        if (plan.intent !== 'edit' || !task.authority.edit || plan.error) throw new Error('Coding request lost edit authority')
        const messages = buildChatTurnMessages(root, settings, {
          text: question.text, mode: 'agent', agentId: plan.agentId, attachments: [], skillIds: [], history
        }, plan)
        try {
          for await (const event of runAgentWithWorkspaceTools({
            workspacePath: root, settings, model: plan.models.chat, messages, temperature: 0,
            signal: controller.signal, getSecret: () => null, mode: 'agent', turnPlan: plan,
            mcp: 'off', allowDelegate: false, approveCommand: async () => false
          })) {
            if (event.type === 'diff') changed.add(event.diff.path)
            if (event.type === 'progress') { event.filesTouched.forEach(path => changed.add(path)); incomplete ||= Boolean(event.incomplete) }
          }
        } catch (error) {
          if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') stopped = true
          else throw error
        }
      })
      if (question.cancel) {
        if (!stopped || !changed.has('index.json') || !existsSync(join(root, 'index.json')))
          failures.push('Cancelled run did not preserve its applied file evidence')
        if (existsSync(join(root, 'calendar.json'))) failures.push('Cancelled run continued to later writes')
      } else if (incomplete || !checks || !checkArtifacts() || changed.size !== 3)
        failures.push('Coding request did not produce all independently checked fixture outputs')
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    finally { rmSync(root, { recursive: true, force: true }) }
    cases.push({ issue: question.issue, question: question.text, passed: failures.length === 0, calls, checks, stopped, changedFiles: [...changed], failures })
  }
  cases.push(await runFileReviewSmoke(parent))
  return { version: 2, mode: 'scripted-production-tools', liveModel: false, providerCalls: 0,
    total: cases.length, passed: cases.filter(result => result.passed).length, cases,
    notRun: ['real model quality', 'PHP application behavior', 'GPU performance', 'renderer send interaction'] }
}

async function runFileReviewSmoke(parent: string) {
  const root = mkdtempSync(join(parent, 'file-review-'))
  const question = 'review the files, what else do we need to add for features?'
  const source = '<main><h1>News</h1><form data-feature="newsletter"><input type="email"><button>Subscribe</button></form></main>'
  writeFileSync(join(root, 'index.html'), source)
  setWorkspaceTrusted(root, true)
  const settings = markSimulatedSettings(structuredClone(getDefaults()))
  settings.models.connections = []
  settings.models.defaultModel = SIMULATED_MODEL_REF
  settings.agent.projectMemory = 'off'
  const scripts = [
    JSON.stringify({ name: 'tree', arguments: { path: '.' } }),
    JSON.stringify({ name: 'read_file', arguments: { path: 'index.html' } }),
    'Newsletter subscription is already implemented in index.html. Add article search and SEO metadata; both are missing from the inspected fixture.'
  ]
  let calls = 0, incomplete = false, answer = ''
  const readPaths = new Set<string>(), changedFiles = new Set<string>()
  const failures: string[] = []
  try {
    await runInDiagnosticsScope({ runId: randomUUID(), mode: 'simulated',
      onBlockedEffect: kind => failures.push('Unexpected blocked effect: ' + kind),
      verify: () => { throw new Error('A read-only review must not execute project checks') },
      adapter: { kind: 'scripted', async *stream(request) {
        if (request.purpose === 'intent') throw new Error('Explicit review should not invoke semantic inference')
        if (++calls > 6) throw new Error('Review model-call budget exceeded')
        if (JSON.stringify(request.tools).includes('write_file')) throw new Error('Read-only review received write tools')
        if (calls === 3 && !request.messages.some(message => message.content?.includes('data-feature="newsletter"')))
          throw new Error('Review response was not grounded in the actual source read')
        const reply = scripts.shift()
        if (!reply) throw new Error('Unexpected additional review model step')
        yield reply
      } }
    }, async () => {
      const history = Array.from({ length: 28 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: 'Earlier discussion about the news website.' }))
      const input = { requestId: randomUUID(), workspacePath: root, settings, text: question,
        model: SIMULATED_MODEL_REF, mode: 'agent' as const, history, priorTask: null, getSecret: () => null }
      const { plan, task } = await resolveChatTurnContract(input, await planInitialChatTurn(input))
      if (plan.intent !== 'review' || task.authority.edit || task.authority.tools !== 'read' || task.requested?.evidence !== 'source-read')
        throw new Error('Review lost its read-only source requirement')
      const messages = buildChatTurnMessages(root, settings, { text: question, mode: 'agent', agentId: plan.agentId, attachments: [], skillIds: [], history }, plan)
      for await (const event of runAgentWithWorkspaceTools({ workspacePath: root, settings, model: plan.models.chat,
        messages, temperature: 0, getSecret: () => null, turnPlan: plan, mcp: 'off', allowDelegate: false, approveCommand: async () => false })) {
        if (event.type === 'tool' && event.tool.name === 'read_file' && event.tool.status === 'ok' && event.tool.path) readPaths.add(event.tool.path)
        if (event.type === 'diff') changedFiles.add(event.diff.path)
        if (event.type === 'progress') { event.filesTouched.forEach(path => changedFiles.add(path)); incomplete ||= Boolean(event.incomplete) }
        if (event.type === 'answer') answer = event.replace ? event.text : answer + event.text
      }
    })
    if (incomplete || !readPaths.has('index.html') || changedFiles.size || readFileSync(join(root, 'index.html'), 'utf8') !== source)
      failures.push('Review did not inspect source without mutation')
    if (!answer.includes('already implemented in index.html') || !answer.includes('article search'))
      failures.push('Review failed independent existing-feature and cited-recommendation expectations')
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
  finally { rmSync(root, { recursive: true, force: true }) }
  return { issue: 431, question, passed: failures.length === 0, calls, checks: 0, stopped: false,
    changedFiles: [...changedFiles], readPaths: [...readPaths], failures }
}
