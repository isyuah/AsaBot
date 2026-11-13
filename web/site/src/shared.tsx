import { Check, Copy } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'

const nl = '\n'
export const ease = [0.22, 1, 0.36, 1] as const
const keywords = new Set([
  'import',
  'from',
  'export',
  'default',
  'const',
  'return',
  'async',
  'await',
  'if',
  'new',
])
const functions = new Set([
  'definePlugin',
  'setup',
  'command',
  'description',
  'action',
  'prompt',
  'set',
  'get',
  'migrate',
  'prepare',
  'all',
  'cron',
  'interval',
  'inject',
  'provide',
  'info',
])

export function navigateTabs(event: KeyboardEvent<HTMLDivElement>, vertical = false) {
  const activeTab = event.target
  if (!(activeTab instanceof HTMLButtonElement)) return
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'))
  const index = tabs.indexOf(activeTab)
  const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
  const previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
  const nextIndex =
    event.key === nextKey
      ? (index + 1) % tabs.length
      : event.key === previousKey
        ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : undefined
  if (nextIndex === undefined) return
  event.preventDefault()
  tabs[nextIndex]?.focus()
  tabs[nextIndex]?.click()
}

export function Mark({ className = '' }: { className?: string }) {
  return (
    <svg className={`brand-mark ${className}`} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="m9.5 23 6.5-15 6.5 15M12 17.5h8"
        stroke="var(--logo-stroke, white)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
export function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.8, ease, delay }}
    >
      {children}
    </motion.div>
  )
}
export function CopyButton({
  text,
  label = '复制代码',
  className = '',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2200)
    return () => window.clearTimeout(timer)
  }, [state])
  return (
    <button
      type="button"
      className={`copy-button ${className}`}
      aria-label={state === 'copied' ? '已复制' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setState('copied')
        } catch {
          setState('error')
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {state === 'copied' ? <Check size={15} /> : <Copy size={15} />}
        </motion.span>
      </AnimatePresence>
      <span aria-live="polite">
        {state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请手动选择' : label}
      </span>
    </button>
  )
}
function highlight(line: string) {
  const parts: ReactNode[] = []
  let index = 0
  while (index < line.length) {
    const char = line.charAt(index)
    if (line.slice(index, index + 2) === '//') {
      parts.push(
        <span className="token-comment" key={index}>
          {line.slice(index)}
        </span>,
      )
      break
    }
    if (char === "'" || char === '"' || char === '`') {
      const closing = line.indexOf(char, index + 1)
      const end = closing === -1 ? line.length : closing + 1
      parts.push(
        <span className="token-string" key={index}>
          {line.slice(index, end)}
        </span>,
      )
      index = end
    } else if (/[a-zA-Z0-9_]/.test(char)) {
      let end = index + 1
      while (end < line.length && /[a-zA-Z0-9_]/.test(line.charAt(end))) end++
      const word = line.slice(index, end)
      const kind = keywords.has(word)
        ? 'keyword'
        : functions.has(word)
          ? 'function'
          : word === 'string' || word === 'number'
            ? 'type'
            : /^[0-9]/.test(word)
              ? 'number'
              : ''
      parts.push(
        kind ? (
          <span className={`token-${kind}`} key={index}>
            {word}
          </span>
        ) : (
          word
        ),
      )
      index = end
    } else {
      parts.push(char)
      index++
    }
  }
  return parts
}
export function Code({ code, numbers = true }: { code: string; numbers?: boolean }) {
  let offset = 0
  return (
    <pre className={`code ${numbers ? 'with-lines' : ''}`}>
      <code>
        {code.split(nl).map((line, index) => {
          const start = offset
          offset += line.length + 1
          return (
            <span className="code-line" key={start}>
              {numbers && (
                <span className="line-number" aria-hidden="true">
                  {index + 1}
                </span>
              )}
              <span>{highlight(line)}</span>
            </span>
          )
        })}
      </code>
    </pre>
  )
}
