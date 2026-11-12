const unitMilliseconds: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** 以毫秒表示的时长。 */
export type Duration = number

/** 将非负毫秒数或 1h30m 等时长字符串转换为毫秒；格式无效时抛错。 */
export function parseDuration(value: string | number): Duration {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value}`)
    }
    return value
  }

  if (value.length === 0) {
    throw new Error('Invalid duration: empty value')
  }

  const partPattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy
  let milliseconds = 0

  while (partPattern.lastIndex < value.length) {
    const match = partPattern.exec(value)
    if (!match) {
      throw new Error(`Invalid duration: ${value}`)
    }

    const amountText = match[1]
    const unit = match[2]

    if (amountText === undefined || unit === undefined) {
      throw new Error(`Invalid duration: ${value}`)
    }

    const amount = Number(amountText)
    const multiplier = unitMilliseconds[unit]

    if (multiplier === undefined) {
      throw new Error(`Invalid duration: ${value}`)
    }

    milliseconds += amount * multiplier
  }

  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid duration: ${value}`)
  }

  return milliseconds
}
