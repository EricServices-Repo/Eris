import { useLayoutEffect, useRef } from 'react'
type Ticket = { sequence: number; namespace: string }
/** Latest-preview publication plus exclusive mutation ownership for one inspector view. */
export function useInspectorRequests(namespace: string) {
  const state = useRef({ sequence: 0, namespace, mounted: true, mutation: false })
  state.current.namespace = namespace
  const invalidate = () => {
    state.current.sequence++
    state.current.mutation = false
  }
  useLayoutEffect(() => {
    const owner = state.current
    owner.mounted = true
    return () => {
      owner.mounted = false
      owner.sequence++
      owner.mutation = false
    }
  }, [namespace])
  const current = (ticket: Ticket) =>
    state.current.mounted &&
    state.current.namespace === ticket.namespace &&
    state.current.sequence === ticket.sequence
  return {
    invalidate,
    current,
    begin(mutation: boolean): Ticket | null {
      if (state.current.mutation || !state.current.mounted) return null
      state.current.mutation = mutation
      return { sequence: ++state.current.sequence, namespace }
    },
    finish(ticket: Ticket) {
      if (current(ticket)) state.current.mutation = false
    },
    async guard<T>(ticket: Ticket, promise: Promise<T>): Promise<T> {
      const value = await promise
      if (!current(ticket)) throw new Error('Stale inspector response discarded')
      return value
    }
  }
}
