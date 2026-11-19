/** A tiny external store for high-frequency realtime data that should not live in React Query. */
export function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T | ((previous: T) => T)) {
      value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type Store<T> = ReturnType<typeof createStore<T>>
