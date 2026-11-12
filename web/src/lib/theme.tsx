import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const storageKey = 'asabot-theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

interface ThemeContextValue {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolve(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'system') return media().matches ? 'dark' : 'light'
  return preference
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => (localStorage.getItem(storageKey) as ThemePreference | null) ?? 'system',
  )
  const [resolved, setResolved] = useState(() => resolve(preference))

  useEffect(() => {
    const apply = () => {
      const next = resolve(preference)
      setResolved(next)
      document.documentElement.classList.toggle('dark', next === 'dark')
    }
    apply()
    if (preference !== 'system') return
    const query = media()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    localStorage.setItem(storageKey, next)
    setPreferenceState(next)
  }, [])

  return <ThemeContext value={{ preference, resolved, setPreference }}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
