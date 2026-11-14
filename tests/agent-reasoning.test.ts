import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #573: model reasoning is shown on its own channel and never becomes the answer
 * or a tool call, whether it arrives inline (`<think>`) or through onReasoning.
 */

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { interleaveReasoning, streamThinkingText } from '../electron/main/services/agent/stream'
import {
  markSimulatedSettings,
  runInDiagnosticsScope,
  SIMULATED_MODEL_REF,
  type ModelTransportRequest
} from '../electron/main/services/model-transport'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'eris-reasoning-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

type Script = (request: ModelTransportRequest) => AsyncGenerator<string, void, unknown>

function scope<T>(script: Script, fn: () => Promise<T>): Promise<T> {
  return runInDiagnosticsScope(
    {
      runId: 'reasoning-test',
      mode: 'simulated',
      adapter: { kind: 'scripted', stream: script },
      onBlockedEffect: () => {}
    },
    fn
  )
}

async function collectStream(script: Script, stopOnToolCall = true) {
  return scope(script, async () => {
    const events: Array<{ kind: string; text?: string; full?: string; aborted?: string }> = []
    for await (const event of streamThinkingText({
      settings: markSimulatedSettings(structuredClone(getDefaults())),
      model: SIMULATED_MODEL_REF,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      getSecret: () => null,
      stopOnToolCall
    }))
      events.push(event as never)
    return events
  })
}

const reasoningOf = (events: Array<{ kind: string; text?: string }>) =>
  events
    .filter((event) => event.kind === 'reasoning')
    .map((event) => event.text)
    .join('')

const toolInReasoning = JSON.stringify({ name: 'read_file', arguments: { path: 'a.ts' } })

describe('streamThinkingText reasoning', () => {
  it('keeps inline <think> reasoning out of the answer and tool parsing', async () => {
    const events = await collectStream(async function* () {
      yield '<think>Maybe call '
      yield `${toolInReasoning} first.</think>`
      yield 'The answer.'
    })
    const done = events.find((event) => event.kind === 'done')!
    expect(done.full).toBe('The answer.')
    expect(done.aborted).toBeUndefined()
    expect(reasoningOf(events)).toContain('Maybe call')
    expect(reasoningOf(events)).toContain('read_file')
  })

  it('emits reasoning delivered through onReasoning without adding it to the answer', async () => {
    const events = await collectStream(async function* (request) {
      request.onReasoning?.('weighing options')
      yield 'Final.'
    })
    expect(reasoningOf(events)).toBe('weighing options')
    expect(events.find((event) => event.kind === 'done')!.full).toBe('Final.')
  })

  it('does not split <think> text once the transport separates reasoning itself', async () => {
    const events = await collectStream(async function* (request) {
      request.onReasoning?.('')
      yield '<think>literal</think> tag in prose'
    })
    expect(events.find((event) => event.kind === 'done')!.full).toBe(
      '<think>literal</think> tag in prose'
    )
  })

  it('splits a bare closing tag on the complete text', async () => {
    const events = await collectStream(async function* () {
      yield 'opened in template\n</think>\n'
      yield 'Real answer.'
    })
    expect(reasoningOf(events)).toBe('opened in template')
    expect(events.find((event) => event.kind === 'done')!.full).toBe('Real answer.')
  })
})

describe('interleaveReasoning', () => {
  it('delivers reasoning while no text flows, in order, and pulls text lazily', async () => {
    let release: () => void = () => {}
    let pulled = 0
    const items: string[] = []
    for await (const item of interleaveReasoning((onReasoning) =>
      (async function* () {
        onReasoning('sync ')
        await new Promise<void>((resolve) => {
          release = resolve
          setTimeout(() => onReasoning('while waiting'), 0)
        })
        pulled++
        yield 'one'
        pulled++
        yield 'two'
      })()
    )) {
      items.push(`${item.kind}:${item.text}`)
      if (item.text === 'while waiting') release()
      if (item.text === 'one') expect(pulled).toBe(1)
    }
    expect(items).toEqual(['reasoning:sync ', 'reasoning:while waiting', 'text:one', 'text:two'])
  })

  it('stops without waiting for a pull that never finishes', async () => {
    const merged = interleaveReasoning((onReasoning) =>
      (async function* () {
        onReasoning('r')
        await new Promise(() => {})
        yield 'never'
      })()
    )
    for await (const item of merged) {
      expect(item).toEqual({ kind: 'reasoning', text: 'r' })
      break
    }
  })
})

describe('agent loop reasoning', () => {
  const plan: TurnPlan = {
    intent: 'answer',
    agentId: 'composer',
    agentName: 'Composer',
    mode: 'agent',
    models: { chat: SIMULATED_MODEL_REF, tools: SIMULATED_MODEL_REF },
    toolPolicy: 'read',
    requiresTools: false,
    escalateToFull: false,
    reason: 'test',
    method: 'heuristic'
  }

  it('runs no tool named only in reasoning and forwards reasoning events', async () => {
    const root = workspace({ 'a.ts': 'export const a = 1\n' })
    const requests: ModelTransportRequest[] = []
    const output: Array<Record<string, unknown>> = []
    await scope(
      async function* (request) {
        requests.push(request)
        yield `<think>I'll check the tests. ${toolInReasoning}</think>`
        yield 'DONE: a.ts exports the constant a, set to 1.'
      },
      async () => {
        for await (const event of runAgentWithWorkspaceTools({
          workspacePath: root,
          settings: markSimulatedSettings(structuredClone(getDefaults())),
          model: SIMULATED_MODEL_REF,
          messages: [
            { role: 'system', content: 'You are Eris.' },
            { role: 'user', content: 'What does a.ts export?' }
          ],
          temperature: 0,
          getSecret: () => null,
          mode: 'agent',
          turnPlan: plan,
          mcp: 'off',
          jobId: 'chat:reasoning-test',
          signal: new AbortController().signal
        }))
          output.push(event as unknown as Record<string, unknown>)
      }
    )
    const toolCalls = output.filter((event) => event.type === 'tool')
    expect(toolCalls).toEqual([])
    const answer = output
      .filter((event) => event.type === 'answer')
      .reduce((text, event) => (event.replace ? String(event.text) : text + String(event.text)), '')
    expect(answer).not.toContain('read_file')
    expect(answer).not.toContain("I'll check the tests")
    expect(answer).toContain('exports the constant')
    const reasoning = output
      .filter((event) => event.type === 'reasoning')
      .map((event) => String(event.text))
      .join('')
    expect(reasoning).toContain("I'll check the tests")
    // Reasoning is never fed back to the model as part of its own reply.
    for (const request of requests)
      for (const message of request.messages)
        expect(String(message.content)).not.toContain("I'll check the tests")
  })
})
