import { type HTMLMotionProps, motion } from 'motion/react'
import { forwardRef, type ReactNode } from 'react'
import { snappy } from '../../lib/motion.ts'
import { cn } from '../../lib/utils.ts'
import { Spinner } from './primitives.tsx'

const variants = {
  primary:
    'bg-accent text-accent-fg shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.16)] hover:bg-accent-hover',
  secondary:
    'bg-surface text-fg border border-border shadow-card hover:bg-surface-2 hover:border-border-strong',
  ghost: 'text-fg-2 hover:text-fg hover:bg-surface-2',
  soft: 'bg-accent-soft text-accent-soft-fg hover:brightness-[0.97] dark:hover:brightness-125',
  danger: 'bg-danger text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] hover:brightness-105',
  'danger-ghost': 'text-danger hover:bg-danger-soft',
} as const

const sizes = {
  sm: 'h-7 gap-1.5 rounded-lg px-2.5 text-[12.5px]',
  md: 'h-9 gap-2 rounded-[10px] px-3.5 text-[13.5px]',
  lg: 'h-10 gap-2 rounded-xl px-4 text-sm',
  icon: 'size-8 rounded-lg',
  'icon-sm': 'size-7 rounded-md',
} as const

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
  loading?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, className, children, ...props },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      whileTap={disabled || loading ? undefined : { scale: 0.97 }}
      transition={snappy}
      disabled={disabled || loading}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,border-color,color,filter,box-shadow] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-[inherit]', loading && 'opacity-0')}>{children}</span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner className="size-4" />
        </span>
      )}
    </motion.button>
  )
})
