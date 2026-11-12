const maxTimerDelay = 2_147_483_647

/** Node clamps larger setTimeout delays to 1 ms; keep long configured durations intact. */
export function scheduleTimeout(delay: number, callback: () => void, unref = false): () => void {
  let remaining = Math.ceil(delay)
  let timer: NodeJS.Timeout
  const schedule = (): void => {
    const interval = Math.min(remaining, maxTimerDelay)
    timer = setTimeout(() => {
      remaining -= interval
      if (remaining <= 0) callback()
      else schedule()
    }, interval)
    if (unref) timer.unref()
  }
  schedule()
  return () => clearTimeout(timer)
}
