import { describe, expect, it } from 'vitest'
import { nextQueueAction, queuePauseLabel } from '../src/shared/chat-queue'

// #521: after Stop, queued messages were stranded with only "Remove"; after an
// error they all drained at once against the same broken model.
describe('chat queue after a reply ends', () => {
  it('drains after a normal finish', () => {
    expect(nextQueueAction({ stopped: false, errored: false, queued: 2 })).toBe('drain')
  })
  it('pauses after Stop', () => {
    expect(nextQueueAction({ stopped: true, errored: false, queued: 1 })).toBe('pause-stopped')
  })
  it('pauses after an error', () => {
    expect(nextQueueAction({ stopped: false, errored: true, queued: 3 })).toBe('pause-error')
  })
  it('a Stop wins over an error', () => {
    expect(nextQueueAction({ stopped: true, errored: true, queued: 1 })).toBe('pause-stopped')
  })
  it('does nothing with an empty queue', () => {
    for (const stopped of [true, false])
      for (const errored of [true, false])
        expect(nextQueueAction({ stopped, errored, queued: 0 })).toBe('idle')
  })
  it('labels each pause', () => {
    expect(queuePauseLabel).toEqual({ stopped: 'Paused after stop', error: 'Paused after an error' })
  })
})
