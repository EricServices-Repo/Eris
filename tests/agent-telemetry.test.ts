import { describe, expect, it } from 'vitest'
import {
  bestTelemetryModelForIntent,
  emptyOutcome,
  summarizeOutcome,
  type AgentOutcomeRecord
} from '../src/shared/agent-telemetry'

function rec(partial: Partial<AgentOutcomeRecord> & { model: string }): AgentOutcomeRecord {
  return { ...emptyOutcome(partial.model, partial.intent ?? 'edit'), ...partial }
}

describe('agent telemetry', () => {
  it('summarizes success, steps and keep rate', () => {
    const s = summarizeOutcome(
      rec({ model: 'm', runs: 4, succeeded: 3, totalSteps: 20, kept: 6, undone: 2 })
    )
    expect(s.successRate).toBeCloseTo(0.75)
    expect(s.avgSteps).toBeCloseTo(5)
    expect(s.keepRate).toBeCloseTo(0.75)
  })

  it('treats no decisions as full keep rate and no runs as zero', () => {
    const s = summarizeOutcome(emptyOutcome('m', 'edit'))
    expect(s.keepRate).toBe(1)
    expect(s.successRate).toBe(0)
    expect(s.avgSteps).toBe(0)
  })

  it('picks the best model for an intent among ready candidates with enough runs', () => {
    const records = [
      rec({ model: 'good', intent: 'edit', runs: 5, succeeded: 5, totalSteps: 10, kept: 5 }),
      rec({ model: 'meh', intent: 'edit', runs: 5, succeeded: 2, totalSteps: 40, kept: 1, undone: 3 }),
      rec({ model: 'other-intent', intent: 'review', runs: 9, succeeded: 9 })
    ]
    expect(bestTelemetryModelForIntent(records, 'edit', ['good', 'meh'], 3)).toBe('good')
  })

  it('returns null when nothing has enough runs or is a candidate', () => {
    const records = [rec({ model: 'good', intent: 'edit', runs: 1, succeeded: 1 })]
    expect(bestTelemetryModelForIntent(records, 'edit', ['good'], 3)).toBeNull()
    expect(bestTelemetryModelForIntent(records, 'edit', ['absent'], 1)).toBeNull()
  })

  it('does not pick a model with zero successes', () => {
    const records = [rec({ model: 'bad', intent: 'edit', runs: 5, succeeded: 0, undone: 5 })]
    expect(bestTelemetryModelForIntent(records, 'edit', ['bad'], 3)).toBeNull()
  })
})

import { getDefaults } from '../electron/main/services/settings'
import { recordAgentRun, bestModelForIntent, clearTelemetry } from '../electron/main/services/agent-telemetry'
import { routingEvidenceKey } from '../electron/main/services/routing-evidence'

describe('versioned production routing evidence', () => {
  it('invalidates outcomes after endpoint or protocol changes', () => {
    clearTelemetry()
    const settings = getDefaults()
    settings.models.connections = [{ id: 'audit', name: 'Audit', type: 'openai-compatible',
      provider: 'custom', enabled: true, models: ['audit-model'], baseUrl: 'http://localhost:11434/v1', apiKeyRef: '' }]
    const connection = settings.models.connections[0]!
    recordAgentRun({ model: 'audit-model', intent: 'edit', steps: 2, mutated: true,
      incomplete: false, aborted: false, settings })
    expect(bestModelForIntent('edit', ['audit-model'], 1, settings)).toBe('audit-model')
    connection.baseUrl = 'https://replacement.example/v1'
    expect(bestModelForIntent('edit', ['audit-model'], 1, settings)).toBeNull()
    recordAgentRun({ model: 'audit-model', intent: 'edit', steps: 2, mutated: true,
      incomplete: false, aborted: false, settings })
    expect(bestModelForIntent('edit', ['audit-model'], 1, settings)).toBe('audit-model')
    const key = routingEvidenceKey(settings, 'audit-model')
    connection.toolProtocol = connection.toolProtocol === 'text-tools' ? 'native-tools' : 'text-tools'
    expect(routingEvidenceKey(settings, 'audit-model')).not.toBe(key)
    expect(bestModelForIntent('edit', ['audit-model'], 1, settings)).toBeNull()
  })
})
