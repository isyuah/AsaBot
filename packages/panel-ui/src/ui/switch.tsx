import * as SwitchPrimitive from '@radix-ui/react-switch'
import { motion } from 'motion/react'
import { snappy } from '../motion.ts'
import { cn } from '../utils.ts'

export function Switch({
  id,
  checked,
  onCheckedChange,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  id?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-colors duration-200',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-surface-3 shadow-[inset_0_0_0_1px_var(--border-strong)]',
        className,
      )}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          layout
          transition={snappy}
          className={cn(
            'block size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25),0_0_0_0.5px_rgb(0_0_0/0.04)]',
            checked ? 'ml-auto' : 'ml-0',
          )}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}
