import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

const fieldBase =
  'w-full rounded-[10px] border border-border bg-surface text-[13.5px] text-fg placeholder:text-fg-3 shadow-[inset_0_1px_1px_rgb(0_0_0/0.02)] transition-[border-color,box-shadow] duration-150 outline-none hover:border-border-strong focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:shadow-[0_0_0_3px_var(--danger-soft)]'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }
>(function Input({ className, icon, ...props }, ref) {
  if (!icon) return <input ref={ref} className={cn(fieldBase, 'h-9 px-3', className)} {...props} />
  return (
    <div className={cn('relative', className)}>
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3 [&>svg]:size-4">
        {icon}
      </span>
      <input ref={ref} className={cn(fieldBase, 'h-9 pr-3 pl-9')} {...props} />
    </div>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(fieldBase, 'min-h-20 resize-y px-3 py-2 leading-relaxed', className)}
        {...props}
      />
    )
  },
)

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string
  required?: boolean
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-[12.5px] font-medium text-fg-2">
        {label}
        {required && <span className="text-danger">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger">{error}</p>
      ) : (
        hint && <p className="text-[12px] leading-relaxed text-fg-3">{hint}</p>
      )}
    </div>
  )
}
