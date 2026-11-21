import * as Popover from '@radix-ui/react-popover'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Variants } from 'motion/react'
import { type KeyboardEvent, useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { snappy, spring } from '../motion.ts'
import { cn } from '../utils.ts'
import { Button } from './button.tsx'

const dayMs = 86_400_000
const firstDay = Date.parse('0001-01-01')
const lastDay = Date.parse('9999-12-31')
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const monthLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long' })
const dayLabel = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  dateStyle: 'full',
})

function isoDay(day: number) {
  return new Date(day).toISOString().slice(0, 10)
}

function parseDay(value: string) {
  const day = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(day) || day < firstDay || day > lastDay || isoDay(day) !== value) {
    throw new RangeError('DatePicker expects valid YYYY-MM-DD dates')
  }
  return day
}

function utcDay(year: number, month: number, date = 1) {
  return new Date(0).setUTCFullYear(year, month, date)
}

function shiftMonths(day: number, offset: number) {
  const date = new Date(day)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + offset
  const last = new Date(utcDay(year, month + 1, 0)).getUTCDate()
  return utcDay(year, month, Math.min(date.getUTCDate(), last))
}

const weekdayOf = (day: number) => (new Date(day).getUTCDay() + 6) % 7
const clamp = (day: number, min: number, max: number) => Math.max(min, Math.min(max, day))

function todayIn(timeZone: DatePickerProps['timeZone']) {
  const now = new Date()
  return timeZone === 'UTC'
    ? Math.floor(now.getTime() / dayMs) * dayMs
    : utcDay(now.getFullYear(), now.getMonth(), now.getDate())
}

const slide: Variants = {
  enter: (direction: number | null) => ({ opacity: direction === null ? 1 : 0, x: (direction ?? 0) * 16 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number | null) => ({
    opacity: 0,
    x: -(direction ?? 0) * 16,
    transition: { duration: direction === null ? 0 : 0.13 },
  }),
}

export interface DatePickerProps {
  id?: string
  value?: string
  onValueChange: (value: string | undefined) => void
  min?: string
  max?: string
  timeZone?: 'local' | 'UTC'
  placeholder?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

export function DatePicker({
  id,
  value,
  onValueChange,
  min,
  max,
  timeZone,
  placeholder = '选择日期',
  className,
  disabled,
  'aria-label': ariaLabel,
  'aria-describedby': description,
  'aria-invalid': invalid,
}: DatePickerProps) {
  const valueId = useId()
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion() === true
  const minDay = min === undefined ? firstDay : parseDay(min)
  const maxDay = max === undefined ? lastDay : parseDay(max)
  const selected = value === undefined ? undefined : parseDay(value)
  if (minDay > maxDay) throw new RangeError('DatePicker min must not exceed max')

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <motion.button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={
            value === undefined ? description : [valueId, description].filter(Boolean).join(' ')
          }
          aria-invalid={invalid}
          whileTap={reduced || disabled ? undefined : { scale: 0.985 }}
          transition={snappy}
          className={cn(
            'flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 text-[13.5px] text-fg tabular-nums shadow-card outline-none transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--ring)] data-[state=open]:border-accent disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger',
            className,
          )}
        >
          <motion.span
            id={valueId}
            key={value ?? ''}
            className={cn('min-w-0 truncate', value === undefined && 'text-fg-3')}
            initial={reduced || value === undefined ? false : { opacity: 0.45, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={snappy}
          >
            {value ?? placeholder}
          </motion.span>
          <motion.span
            aria-hidden="true"
            className={cn('shrink-0', open ? 'text-accent' : 'text-fg-3')}
            animate={{ scale: open && !reduced ? 1.12 : 1 }}
            transition={snappy}
          >
            <CalendarDays className="size-3.5" />
          </motion.span>
        </motion.button>
      </Popover.Trigger>
      <AnimatePresence>
        {open && (
          <Popover.Portal forceMount>
            <CalendarPopover
              selected={selected}
              min={minDay}
              max={maxDay}
              timeZone={timeZone}
              reduced={reduced}
              onPick={(day) => {
                onValueChange(day === undefined ? undefined : isoDay(day))
                setOpen(false)
              }}
            />
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  )
}

function CalendarPopover({
  selected,
  min,
  max,
  timeZone,
  reduced,
  onPick,
}: {
  selected?: number
  min: number
  max: number
  timeZone: DatePickerProps['timeZone']
  reduced: boolean
  onPick: (day?: number) => void
}) {
  const present = useIsPresent()
  const [today] = useState(() => todayIn(timeZone))
  const [page, setPage] = useState({ day: selected ?? today, months: false, direction: 0, focus: false })
  const calendar = useRef<HTMLDivElement>(null)
  const heading = useId()
  const cursor = clamp(page.day, min, max)
  const date = new Date(cursor)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const start = utcDay(year, page.months ? 0 : month)
  const nextStart = utcDay(year, page.months ? 12 : month + 1)
  const step = page.months ? 12 : 1
  const title = page.months ? `${year} 年` : monthLabel.format(start)

  const focusCursor = useCallback(() => {
    calendar.current
      ?.querySelector<HTMLButtonElement>('[role="grid"]:not([inert]) button[tabindex="0"]')
      ?.focus()
  }, [])

  useLayoutEffect(() => {
    if (page.focus) focusCursor()
  }, [focusCursor, page])

  function navigate(day: number, months: boolean, focus: boolean) {
    const next = clamp(day, min, max)
    if (next === cursor && months === page.months) return
    setPage({ day: next, months, direction: months === page.months ? Math.sign(next - cursor) : 0, focus })
  }

  function onCellKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const columns = page.months ? 3 : 7
    const column = page.months ? month % columns : weekdayOf(cursor)
    const offsets: Partial<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns,
      ArrowDown: columns,
      Home: -column,
      End: columns - 1 - column,
    }
    const offset = offsets[event.key]
    if (offset !== undefined) {
      event.preventDefault()
      navigate(page.months ? shiftMonths(cursor, offset) : cursor + offset * dayMs, page.months, true)
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      const distance = event.shiftKey ? 12 : step
      navigate(shiftMonths(cursor, event.key === 'PageUp' ? -distance : distance), page.months, true)
    }
  }

  function monthArrow(offset: -1 | 1) {
    const previous = offset < 0
    const unavailable = previous ? start <= min : nextStart > max
    const Chevron = previous ? ChevronLeft : ChevronRight
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-disabled={unavailable}
        aria-label={page.months ? (previous ? '上一年' : '下一年') : previous ? '上个月' : '下个月'}
        className="aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent"
        whileTap={reduced || unavailable ? undefined : { scale: 0.9 }}
        onClick={() => {
          if (!unavailable) navigate(shiftMonths(cursor, offset * step), page.months, false)
        }}
      >
        <Chevron aria-hidden="true" className={cn('size-4', unavailable && 'opacity-35')} />
      </Button>
    )
  }

  const direction = reduced ? null : page.direction
  return (
    <Popover.Content
      asChild
      align="start"
      sideOffset={8}
      collisionPadding={8}
      aria-label="选择日期"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        focusCursor()
      }}
    >
      <motion.div
        ref={calendar}
        inert={!present}
        initial={reduced ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: reduced ? 1 : 0.98, transition: { duration: reduced ? 0 : 0.12 } }}
        transition={spring}
        className="z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(18.25rem,var(--radix-popover-content-available-width))] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface shadow-pop outline-none"
        style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
      >
        <div className="p-3">
          <div className="mb-2 flex items-center justify-between gap-1">
            {monthArrow(-1)}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-[13.5px] font-semibold text-fg tabular-nums"
              aria-label={page.months ? `${title}，返回日期` : `${title}，选择月份`}
              aria-expanded={page.months}
              whileTap={reduced ? undefined : { scale: 0.95 }}
              onClick={() => navigate(cursor, !page.months, true)}
            >
              <span aria-hidden="true">{title}</span>
              <motion.span aria-hidden="true" animate={{ rotate: page.months ? 180 : 0 }} transition={snappy}>
                <ChevronDown className="size-3.5 text-fg-3" />
              </motion.span>
            </Button>
            {monthArrow(1)}
            <span id={heading} aria-live="polite" aria-atomic="true" className="sr-only">
              {title}
            </span>
          </div>
          <div className="grid overflow-clip">
            <AnimatePresence initial={false} custom={direction}>
              <CalendarGrid
                key={`${page.months}-${start}`}
                heading={heading}
                months={page.months}
                start={start}
                nextStart={nextStart}
                year={year}
                cursor={cursor}
                selected={selected}
                today={today}
                min={min}
                max={max}
                direction={direction}
                onKeyDown={onCellKeyDown}
                onPick={(day) => {
                  if (page.months)
                    navigate(shiftMonths(cursor, new Date(day).getUTCMonth() - month), false, true)
                  else onPick(day)
                }}
              />
            </AnimatePresence>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selected === undefined}
            onClick={() => onPick()}
          >
            清空
          </Button>
          <Button
            type="button"
            variant="soft"
            size="sm"
            disabled={today < min || today > max}
            onClick={() => onPick(today)}
          >
            今天
          </Button>
        </div>
      </motion.div>
    </Popover.Content>
  )
}

function CalendarGrid({
  heading,
  months,
  start,
  nextStart,
  year,
  cursor,
  selected,
  today,
  min,
  max,
  direction,
  onKeyDown,
  onPick,
}: {
  heading: string
  months: boolean
  start: number
  nextStart: number
  year: number
  cursor: number
  selected?: number
  today: number
  min: number
  max: number
  direction: number | null
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onPick: (day: number) => void
}) {
  const present = useIsPresent()
  const columns = months ? 3 : 7
  const first = start - weekdayOf(start) * dayMs
  return (
    <motion.table
      role="grid"
      aria-labelledby={heading}
      inert={!present}
      className="col-start-1 row-start-1 h-61 w-full min-w-0 table-fixed border-separate border-spacing-0.5"
      custom={direction}
      variants={slide}
      initial="enter"
      animate="center"
      exit="exit"
      transition={direction === null ? { duration: 0 } : spring}
    >
      {!months && (
        <thead>
          <tr>
            {weekdays.map((day) => (
              <th
                key={day}
                scope="col"
                aria-label={`星期${day}`}
                className="h-6 text-[11px] font-medium text-fg-3"
              >
                {day}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {Array.from({ length: months ? 4 : 6 }, (_, row) => {
          const rowStart = months ? utcDay(year, row * columns) : first + row * columns * dayMs
          return (
            <tr key={rowStart}>
              {Array.from({ length: columns }, (_, column) => {
                const index = row * columns + column
                const day = months ? utcDay(year, index) : rowStart + column * dayMs
                const end = months ? utcDay(year, index + 1) - dayMs : day
                const active = day <= cursor && cursor <= end
                const checked = selected !== undefined && day <= selected && selected <= end
                const current = day <= today && today <= end
                const muted = !months && (day < start || day >= nextStart)
                const disabled = end < min || day > max
                const label = months ? monthLabel.format(day) : dayLabel.format(day)
                return (
                  <td key={day} className="relative">
                    <motion.button
                      type="button"
                      tabIndex={active ? 0 : -1}
                      disabled={disabled}
                      aria-current={current ? 'date' : undefined}
                      aria-label={checked ? `${label}，已选` : label}
                      whileTap={disabled || direction === null ? undefined : { scale: 0.9 }}
                      transition={snappy}
                      onKeyDown={onKeyDown}
                      onClick={() => onPick(day)}
                      className={cn(
                        'absolute inset-0 grid cursor-pointer place-items-center rounded-[9px] text-[13px] font-medium tabular-nums motion-safe:transition-colors focus-visible:-outline-offset-2 disabled:cursor-not-allowed',
                        disabled
                          ? 'text-fg-3 opacity-45'
                          : checked
                            ? 'bg-accent font-semibold text-accent-fg shadow-card focus-visible:outline-accent-fg/75'
                            : cn(
                                'hover:bg-accent-soft hover:text-accent-soft-fg focus-visible:outline-accent',
                                current
                                  ? 'font-semibold text-accent-soft-fg'
                                  : muted
                                    ? 'text-fg-3'
                                    : 'text-fg',
                              ),
                      )}
                    >
                      {months ? `${index + 1} 月` : new Date(day).getUTCDate()}
                      {current && !disabled && (
                        <span
                          aria-hidden="true"
                          className="absolute bottom-1 size-[3px] rounded-full bg-current"
                        />
                      )}
                    </motion.button>
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </motion.table>
  )
}
