import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../utils.ts'

export interface SelectOption<V extends string> {
  value: V
  label: ReactNode
}

const optionKey = (value: string) => `:${value}`

export function Select<V extends string>({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  'aria-label': ariaLabel,
  'aria-invalid': invalid,
}: {
  id?: string
  value: V | undefined
  onValueChange: (value: V) => void
  options: readonly SelectOption<V>[]
  placeholder?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
  'aria-invalid'?: boolean
}) {
  return (
    // Radix treats "" as "nothing selected" (shows the placeholder) and stays controlled while data loads.
    <SelectPrimitive.Root
      disabled={disabled}
      value={value === undefined ? '' : optionKey(value)}
      onValueChange={(next) => {
        const option = options.find((item) => optionKey(item.value) === next)
        if (option) onValueChange(option.value)
      }}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        className={cn(
          'group inline-flex h-9 min-w-0 max-w-full cursor-pointer items-center justify-between gap-2 rounded-[10px] border border-border bg-surface px-3 text-[13.5px] text-fg shadow-card outline-none transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--ring)] data-[state=open]:border-accent data-[placeholder]:text-fg-3 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className="shrink-0">
          <ChevronDown className="size-3.5 text-fg-3 motion-safe:transition-transform group-data-[state=open]:rotate-180" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-h-[min(18rem,var(--radix-select-content-available-height))] w-max min-w-[min(var(--radix-select-trigger-width),var(--radix-select-content-available-width))] max-w-[min(max(24rem,var(--radix-select-trigger-width)),var(--radix-select-content-available-width))] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop motion-safe:data-[state=open]:animate-[pop-in_160ms_cubic-bezier(0.16,1,0.3,1)]"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-5 shrink-0 items-center justify-center text-fg-3">
            <ChevronUp aria-hidden="true" className="size-3.5" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="min-h-0">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={optionKey(option.value)}
                className="relative flex min-h-8 cursor-pointer items-center rounded-md py-1.5 pr-8 pl-2.5 text-[13px] leading-snug wrap-anywhere text-fg-2 outline-none select-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-soft-fg data-[state=checked]:font-medium"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute top-1/2 right-2.5 -translate-y-1/2">
                  <Check className="size-3.5 text-accent" strokeWidth={2.5} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-5 shrink-0 items-center justify-center text-fg-3">
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
