import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

export interface SelectOption<V extends string> {
  value: V
  label: ReactNode
}

export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: V | undefined
  onValueChange: (value: V) => void
  options: SelectOption<V>[]
  placeholder?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    // Radix treats "" as "nothing selected" (shows the placeholder) and stays controlled while data loads.
    <SelectPrimitive.Root
      disabled={disabled}
      value={value ?? ''}
      onValueChange={(next) => onValueChange(next as V)}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-9 min-w-32 cursor-pointer items-center justify-between gap-2 rounded-[10px] border border-border bg-surface px-3 text-[13.5px] text-fg shadow-card outline-none transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--ring)] data-[placeholder]:text-fg-3 disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3.5 text-fg-3" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop data-[state=open]:animate-[pop-in_160ms_cubic-bezier(0.16,1,0.3,1)]"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex h-8 cursor-pointer items-center rounded-lg pr-8 pl-2.5 text-[13px] text-fg-2 outline-none select-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-fg data-[state=checked]:text-fg"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2.5">
                  <Check className="size-3.5 text-accent" strokeWidth={2.5} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
