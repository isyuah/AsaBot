import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { softSpring, spring } from '../../lib/motion.ts'
import { cn } from '../../lib/utils.ts'
import { Button } from './button.tsx'

function Overlay() {
  return (
    <DialogPrimitive.Overlay asChild forceMount>
      <motion.div
        className="fixed inset-0 z-40 bg-overlay backdrop-blur-[3px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
    </DialogPrimitive.Overlay>
  )
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <Overlay />
            <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
              <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97, y: 6 }}
                  transition={spring}
                  className={cn(
                    'pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-surface shadow-pop outline-none',
                    className,
                  )}
                >
                  <div className="flex items-start justify-between gap-4 px-5 pt-5">
                    <div>
                      <DialogPrimitive.Title className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
                        {title}
                      </DialogPrimitive.Title>
                      {description && (
                        <p className="mt-1 text-[13px] leading-relaxed text-fg-3">{description}</p>
                      )}
                    </div>
                    <DialogPrimitive.Close asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="关闭">
                        <X className="size-4" />
                      </Button>
                    </DialogPrimitive.Close>
                  </div>
                  {children && <div className="px-5 pt-4 pb-1">{children}</div>}
                  {footer && <div className="flex justify-end gap-2 px-5 pt-3 pb-5">{footer}</div>}
                </motion.div>
              </DialogPrimitive.Content>
            </div>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}

/** A right-side drawer for detail views. */
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  headerExtra,
  children,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  subtitle?: ReactNode
  headerExtra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <Overlay />
            <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                initial={{ x: '100%', opacity: 0.6 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: '100%', opacity: 0.6 }}
                transition={softSpring}
                className={cn(
                  'fixed inset-y-2 right-2 z-50 flex w-[min(560px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop outline-none',
                  className,
                )}
              >
                <div className="flex items-start justify-between gap-4 border-b border-border px-6 pt-5 pb-4">
                  <div className="min-w-0">
                    <DialogPrimitive.Title className="truncate text-[17px] font-semibold tracking-[-0.02em] text-fg">
                      {title}
                    </DialogPrimitive.Title>
                    {subtitle && <div className="mt-1 text-[13px] text-fg-3">{subtitle}</div>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {headerExtra}
                    <DialogPrimitive.Close asChild>
                      <Button variant="ghost" size="icon" aria-label="关闭">
                        <X className="size-4" />
                      </Button>
                    </DialogPrimitive.Close>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
              </motion.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
