const numberFormat = new Intl.NumberFormat('zh-CN')

export function formatNumber(value: number): string {
  return numberFormat.format(Math.round(value))
}

export function formatClock(time: number, withSeconds = true): string {
  return new Date(time).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  })
}

/** pino numeric levels */
export const logLevels = [
  { value: 10, name: 'trace' },
  { value: 20, name: 'debug' },
  { value: 30, name: 'info' },
  { value: 40, name: 'warn' },
  { value: 50, name: 'error' },
  { value: 60, name: 'fatal' },
] as const

export function levelName(level: number): string {
  return [...logLevels].reverse().find((item) => level >= item.value)?.name ?? 'trace'
}

/** Badge colours of a log level name (see levelName). */
export const levelStyle: Record<string, string> = {
  trace: 'text-fg-3 bg-surface-2',
  debug: 'text-fg-3 bg-surface-2',
  info: 'text-info bg-info-soft',
  warn: 'text-warning bg-warning-soft',
  error: 'text-danger bg-danger-soft',
  fatal: 'text-white bg-danger',
}
