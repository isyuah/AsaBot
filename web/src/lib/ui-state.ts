import { useSyncExternalStore } from 'react'
import { createStore } from './utils.ts'

export const commandPalette = createStore<{ restoreFocus: () => void } | null>(null)

export function openCommandPalette(afterFocus?: () => void): void {
  if (commandPalette.get()) return
  const element = document.activeElement
  const path = window.location.pathname
  commandPalette.set({
    restoreFocus() {
      if (window.location.pathname !== path || !(element instanceof HTMLElement) || !element.isConnected)
        return
      element.focus({ preventScroll: true })
      afterFocus?.()
    },
  })
}

/** Text to prefill in the playground input (set from the command palette or the commands page). */
export const playgroundDraft = createStore<string | null>(null)

export function useCommandPalette() {
  return useSyncExternalStore(commandPalette.subscribe, commandPalette.get)
}

export function usePlaygroundDraft(): string | null {
  return useSyncExternalStore(playgroundDraft.subscribe, playgroundDraft.get)
}
