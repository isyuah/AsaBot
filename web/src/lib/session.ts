import type { QueryClient } from '@tanstack/react-query'

/**
 * Switch the signed-in state. Drops every cached query except the session itself: `QueryClient.clear()` would also
 * remove the active session query, leaving the App's observer attached to a detached query that never updates.
 */
export function resetSession(client: QueryClient, authenticated: boolean): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' })
  client.setQueryData(['session'], { authenticated })
}
