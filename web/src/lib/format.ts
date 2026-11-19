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

export function formatRelative(time: number, now = Date.now()): string {
  const diff = Math.max(0, now - time)
  if (diff < 10_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(time).toLocaleDateString('zh-CN')
}

/** A config duration as written in YAML: strings pass through, milliseconds become e.g. `1h30m`, `30s`, `500ms`. */
export function compactDuration(value: string | number): string {
  if (typeof value === 'string') return value
  if (value <= 0) return '0s'
  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
    ['ms', 1],
  ]
  let rest = value
  let text = ''
  for (const [unit, size] of units) {
    const count = Math.floor(rest / size)
    if (count > 0) {
      text += `${count}${unit}`
      rest -= count * size
    }
  }
  return text
}
