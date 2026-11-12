import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { type ReactNode, useEffect, useId } from 'react'
import { snappy, spring } from '../../lib/motion.ts'
import { cn } from '../../lib/utils.ts'

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-lg bg-fg px-2.5 py-1.5 text-[12px] font-medium text-bg shadow-pop data-[state=delayed-open]:animate-[pop-in_140ms_cubic-bezier(0.16,1,0.3,1)]"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export const TooltipProvider = TooltipPrimitive.Provider

/** Segmented control with a sliding selection pill. */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: V
  onChange: (value: V) => void
  options: { value: V; label: ReactNode }[]
  size?: 'sm' | 'md'
  className?: string
}) {
  const id = useId()
  return (
    <fieldset
      className={cn(
        'm-0 inline-flex min-w-0 items-center rounded-[10px] border border-border bg-surface-2 p-0.5',
        size === 'sm' ? 'h-7' : 'h-9',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative h-full cursor-pointer rounded-lg px-3 font-medium transition-colors duration-150',
              size === 'sm' ? 'text-[12px]' : 'text-[13px]',
              active ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {active && (
              <motion.span
                layoutId={`segmented-${id}`}
                transition={spring}
                className="absolute inset-0 rounded-lg border border-border bg-surface shadow-card"
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        )
      })}
    </fieldset>
  )
}

/** Tabs with an animated underline indicator. */
export function Tabs<V extends string>({
  value,
  onChange,
  tabs,
  children,
  className,
}: {
  value: V
  onChange: (value: V) => void
  tabs: { value: V; label: ReactNode; count?: number }[]
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onChange(next as V)} className={className}>
      <TabsPrimitive.List className="flex gap-1 border-b border-border px-6">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(
              'relative -mb-px flex h-10 cursor-pointer items-center gap-1.5 px-2 text-[13px] font-medium transition-colors outline-none',
              tab.value === value ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-fg-3 tabular">
                {tab.count}
              </span>
            )}
            {tab.value === value && (
              <motion.span
                layoutId={`tab-${id}`}
                transition={spring}
                className="absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-accent"
              />
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  )
}

export const TabPanel = TabsPrimitive.Content

export function Menu({
  trigger,
  children,
  align = 'end',
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-pop data-[state=open]:animate-[pop-in_150ms_cubic-bezier(0.16,1,0.3,1)]"
        >
          {children}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  )
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger = false,
  disabled = false,
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <DropdownPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 [&>svg]:size-3.5',
        danger
          ? 'text-danger data-[highlighted]:bg-danger-soft'
          : 'text-fg-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-fg',
      )}
    >
      {icon}
      {children}
    </DropdownPrimitive.Item>
  )
}

export const MenuSeparator = () => <DropdownPrimitive.Separator className="my-1 h-px bg-border" />

/** Animates numeric changes (count-up on mount, smooth roll on updates). */
export function NumberTicker({
  value,
  format,
  className,
}: {
  value: number
  format?: (n: number) => string
  className?: string
}) {
  const motionValue = useMotionValue(0)
  const text = useTransform(motionValue, (latest) =>
    format ? format(latest) : Math.round(latest).toLocaleString('zh-CN'),
  )
  useEffect(() => {
    const controls = animate(motionValue, value, { ...snappy, stiffness: 120, damping: 24 })
    return () => controls.stop()
  }, [motionValue, value])
  return <motion.span className={cn('tabular', className)}>{text}</motion.span>
}
