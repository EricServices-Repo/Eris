import { useSyncExternalStore } from 'react'
import type { SetStateAction } from 'react'

export function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: SetStateAction<T>) {
      const updated = typeof next === 'function' ? (next as (value: T) => T)(value) : next
      if (Object.is(value, updated)) return
      value = updated
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
export function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
