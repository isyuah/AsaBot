import { AnimatePresence, motion } from 'motion/react'
import { type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatClock, formatNumber } from './format.ts'
import { softSpring } from './motion.ts'
import type { StatsPoint } from './types.ts'
import { cn } from './utils.ts'

const height = 232
const pad = { top: 14, right: 12, bottom: 26, left: 40 }

const series = [
  { key: 'received', label: '收到', color: 'var(--series-in)' },
  { key: 'sent', label: '发出', color: 'var(--series-out)' },
] as const

type SeriesKey = (typeof series)[number]['key']

/** Monotone cubic interpolation (Fritsch–Carlson): smooth, but never overshoots between data points. */
function monotonePath(points: [number, number][]): string {
  const first = points[0]
  if (!first) return ''
  const slopes: number[] = []
  const widths: number[] = []
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] ?? first
    const [x1, y1] = points[i] ?? first
    widths.push(x1 - x0)
    slopes.push((y1 - y0) / (x1 - x0))
  }
  const tangents = points.map((_, i) => {
    const s0 = slopes[i - 1]
    const s1 = slopes[i]
    if (s0 === undefined) return s1 ?? 0
    if (s1 === undefined || s0 * s1 <= 0) return s1 === undefined ? s0 : 0
    const w0 = widths[i - 1] ?? 0
    const w1 = widths[i] ?? 0
    return (3 * (w0 + w1)) / ((2 * w1 + w0) / s0 + (w1 + 2 * w0) / s1)
  })
  let d = `M${first[0]},${first[1]}`
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] ?? first
    const [x1, y1] = points[i] ?? first
    const h = (x1 - x0) / 3
    d += `C${x0 + h},${y0 + h * (tangents[i - 1] ?? 0)},${x1 - h},${y1 - h * (tangents[i] ?? 0)},${x1},${y1}`
  }
  return d
}

/** Rounds the axis so the four gridline steps are whole, readable numbers (1, 2, 5 × 10ⁿ). */
function niceScale(value: number): { max: number; step: number } {
  const raw = Math.max(1, value) / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = Math.max(1, (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude)
  return { max: step * 4, step }
}

export function MessageChart({
  points,
  range,
  dimmed = false,
}: {
  points: StatsPoint[]
  range: '1h' | '24h'
  dimmed?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const geometry = useMemo(() => {
    if (width === 0 || points.length === 0) return null
    const innerWidth = width - pad.left - pad.right
    const innerHeight = height - pad.top - pad.bottom
    const { max, step: tickStep } = niceScale(
      Math.max(...points.map((point) => Math.max(point.received, point.sent))),
    )
    const step = points.length > 1 ? innerWidth / (points.length - 1) : 0
    const x = (index: number) => pad.left + index * step
    const y = (value: number) => pad.top + innerHeight - (value / max) * innerHeight
    const lines = Object.fromEntries(
      series.map((s) => {
        const coords = points.map((point, index) => [x(index), y(point[s.key])] as [number, number])
        const line = monotonePath(coords)
        const area = `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`
        return [s.key, { line, area }]
      }),
    ) as Record<SeriesKey, { line: string; area: string }>
    const ticks = [0, 1, 2, 3, 4].map((index) => ({ value: index * tickStep, y: y(index * tickStep) }))
    const labelEvery = range === '1h' ? 15 : 24 // every 15 minutes, or every 6 hours (24 × 15 min)
    const xLabels = points
      .map((point, index) => ({ index, t: point.t }))
      .filter(({ t, index }) =>
        range === '1h' ? new Date(t).getMinutes() % 15 === 0 : index % labelEvery === 0,
      )
    return { x, y, lines, ticks, xLabels, innerHeight, step }
  }, [points, range, width])

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    if (!geometry || points.length === 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const relative = event.clientX - bounds.left
    const index = geometry.step === 0 ? 0 : Math.round(relative / geometry.step)
    setHover(Math.max(0, Math.min(points.length - 1, index)))
  }

  const hovered = hover === null ? null : points[hover]
  const totals = {
    received: points.reduce((sum, point) => sum + point.received, 0),
    sent: points.reduce((sum, point) => sum + point.sent, 0),
  }
  const empty = totals.received === 0 && totals.sent === 0

  return (
    <div>
      <div className="mb-3 flex items-center gap-5 px-5">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <span className="h-[2px] w-3.5 rounded-full" style={{ background: s.color }} />
            {s.label}
            <span className="font-medium text-fg tabular">{formatNumber(totals[s.key])}</span>
          </div>
        ))}
      </div>
      <div
        ref={containerRef}
        className={cn('relative transition-opacity duration-300', dimmed && 'opacity-50')}
        style={{ height }}
      >
        {geometry && (
          <svg
            width={width}
            height={height}
            className="block overflow-visible"
            role="img"
            aria-label="消息趋势图"
          >
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.14} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.01} />
                </linearGradient>
              ))}
            </defs>
            {geometry.ticks.map((tick) => (
              <g key={tick.value}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={tick.y}
                  y2={tick.y}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text
                  x={pad.left - 10}
                  y={tick.y}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-fg-3 text-[11px] tabular"
                >
                  {formatNumber(tick.value)}
                </text>
              </g>
            ))}
            {geometry.xLabels.map(({ index, t }) => (
              <text
                key={t}
                x={geometry.x(index)}
                y={height - 6}
                textAnchor="middle"
                className="fill-fg-3 text-[11px] tabular"
              >
                {formatClock(t, false)}
              </text>
            ))}
            {series.map((s) => (
              <motion.path
                key={`${s.key}-area`}
                d={geometry.lines[s.key].area}
                fill={`url(#fill-${s.key})`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, d: geometry.lines[s.key].area }}
                transition={softSpring}
              />
            ))}
            {series.map((s) => (
              <motion.path
                key={`${s.key}-line`}
                d={geometry.lines[s.key].line}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1, d: geometry.lines[s.key].line }}
                transition={{ pathLength: { duration: 1.1, ease: [0.16, 1, 0.3, 1] }, d: softSpring }}
              />
            ))}
            {hovered && hover !== null && (
              <g pointerEvents="none">
                <line
                  x1={geometry.x(hover)}
                  x2={geometry.x(hover)}
                  y1={pad.top}
                  y2={pad.top + geometry.innerHeight}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
                {series.map((s) => (
                  <motion.circle
                    key={s.key}
                    initial={false}
                    animate={{ cx: geometry.x(hover), cy: geometry.y(hovered[s.key]) }}
                    transition={{ type: 'spring', stiffness: 700, damping: 40 }}
                    r={4}
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}
            <rect
              x={pad.left}
              y={pad.top}
              width={Math.max(0, width - pad.left - pad.right)}
              height={geometry.innerHeight}
              fill="transparent"
              onPointerMove={onPointerMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        <AnimatePresence>
          {hovered && hover !== null && geometry && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, x: Math.min(Math.max(geometry.x(hover) - 70, 0), width - 150) }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 600, damping: 40 }}
              className="pointer-events-none absolute top-1 left-0 w-[150px] rounded-xl border border-border bg-surface/95 px-3 py-2.5 shadow-pop backdrop-blur"
            >
              <div className="mb-1.5 text-[11.5px] text-fg-3 tabular">
                {formatClock(hovered.t, false)}
                {range === '24h' && ` – ${formatClock(hovered.t + 15 * 60_000, false)}`}
              </div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-[12.5px]">
                  <span className="h-[2px] w-3 rounded-full" style={{ background: s.color }} />
                  <span className="font-semibold text-fg tabular">{formatNumber(hovered[s.key])}</span>
                  <span className="text-fg-3">{s.label}</span>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        {empty && geometry && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 text-[12.5px] text-fg-3">
            这段时间还没有消息
          </div>
        )}
        <table className="sr-only">
          <caption>每个时间段收到和发出的消息数</caption>
          <thead>
            <tr>
              <th>时间</th>
              <th>收到</th>
              <th>发出</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.t}>
                <td>{formatClock(point.t, false)}</td>
                <td>{point.received}</td>
                <td>{point.sent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
