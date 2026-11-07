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
  return { version: 1, mode: 'scripted-production-tools', liveModel: false, providerCalls: 0,
    total: QUESTIONS.length, passed: cases.filter(result => result.passed).length, cases,
    notRun: ['real model quality', 'PHP application behavior', 'GPU performance', 'renderer send interaction'] }
}
