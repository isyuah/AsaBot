import { useSyncExternalStore } from 'react'
import { createStore } from './utils.ts'

/** Cross-page UI state that is not server data. */
export const commandPaletteOpen = createStore(false)

/** Text to prefill in the playground input (set from the command palette or the commands page). */
export const playgroundDraft = createStore<string | null>(null)

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(commandPaletteOpen.subscribe, commandPaletteOpen.get)
}

export function usePlaygroundDraft(): string | null {
  return useSyncExternalStore(playgroundDraft.subscribe, playgroundDraft.get)
}
