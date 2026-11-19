import { motion } from 'motion/react'
import type { HTMLAttributes, ReactNode } from 'react'
import { softSpring } from '../motion.ts'
import { cn } from '../utils.ts'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props} />
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-[12.5px] text-fg-3">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

const tones = {
  neutral: 'bg-surface-2 text-fg-2 border-border',
  accent: 'bg-accent-soft text-accent-soft-fg border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
} as const

export type Tone = keyof typeof tones

export function Badge({
  tone = 'neutral',
  dot = false,
  pulse = false,
  className,
  children,
}: {
  tone?: Tone
  dot?: boolean
  pulse?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {dot && <StatusDot tone={tone} pulse={pulse} />}
      {children}
    </span>
  )
}

const dotColors: Record<Tone, string> = {
  neutral: 'bg-fg-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone
  pulse?: boolean
  className?: string
}) {
  return (
    <span className={cn('relative inline-flex size-1.5 shrink-0', className)}>
      {pulse && (
        <span
          className={cn('absolute inset-0 rounded-full motion-safe:animate-pulse-soft', dotColors[tone])}
        />
      )}
      <span className={cn('relative inline-flex size-full rounded-full', dotColors[tone])} />
    </span>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border bg-surface-2 px-1 font-sans text-[11px] font-medium text-fg-3',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={softSpring}
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-3 [&>svg]:size-5">
        {icon}
      </div>
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-fg-3">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  )
}

/** Failed query: shows the reason and a retry button instead of leaving a skeleton on screen forever. */
export function ErrorState({
  error,
  onRetry,
  retrying = false,
  className,
}: {
  error: Error
  onRetry: () => void
  retrying?: boolean
  className?: string
}) {
  return (
    <EmptyState
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="text-danger"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      }
      title="加载失败"
      description={error.message}
      className={className}
      action={
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-fg shadow-card transition-colors hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
        >
          {retrying && <Spinner className="size-3.5" />}
          重试
        </button>
      }
    />
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.025em] text-fg">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
