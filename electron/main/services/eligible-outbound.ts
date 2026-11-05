import type { AppSettings } from '../../../src/shared/settings-schema'
import { withEligibleMemory } from './memory-dispatch'
import { eligibleProjectFacts } from './agent/context-compiler'
import { appendTaskEvent } from './task-ledger'

/** Recalled memory, then approved project facts, as this destination may receive them now. */
export async function eligibleOutbound<
  T extends { content?: unknown; contextBundle?: { taskId?: string } }
>(input: T[], model: string, settings: AppSettings): Promise<{ messages: T[]; revoked: boolean }> {
  const memory = await withEligibleMemory(input, model, settings)
  const facts = eligibleProjectFacts(memory.messages, model, settings)
  if (facts.removed.length) {
    const id = input.map((message) => message.contextBundle?.taskId).find(Boolean)
    if (id) appendTaskEvent(id, 'project-fact-withheld', { facts: facts.removed })
  }
  return { messages: facts.messages, revoked: memory.revoked || facts.removed.length > 0 }
}
