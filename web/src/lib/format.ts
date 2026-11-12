const numberFormat = new Intl.NumberFormat('zh-CN')

export function formatNumber(value: number): string {
  return numberFormat.format(Math.round(value))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds % 60} 秒`
  return `${seconds} 秒`
}

export function formatClock(time: number, withSeconds = true): string {
  return new Date(time).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  })
}

export function formatRelative(time: number, now = Date.now()): string {
  const diff = Math.max(0, now - time)
  if (diff < 10_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(time).toLocaleDateString('zh-CN')
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
