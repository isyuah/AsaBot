import type { ReactNode } from 'react'
import { cn } from './utils.ts'

/** Use as the outermost layout inside a plugin's iframe. The toolbar stays above the scrolling content. */
export function PluginPageLayout({
  toolbar,
  children,
  className,
}: {
  toolbar?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex h-dvh min-w-0 flex-col overflow-clip', className)}>
      {toolbar && <div className="shrink-0">{toolbar}</div>}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain">{children}</div>
    </div>
  )
}
