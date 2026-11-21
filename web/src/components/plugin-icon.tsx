import { cn } from '@asabot/panel-ui'
import { Package } from 'lucide-react'
import { useState } from 'react'

export function PluginIcon({ src, className }: { src?: string; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>()
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-border bg-surface-2 text-fg-3 transition-colors',
        className,
      )}
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain p-1"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <Package className="size-4" />
      )}
    </span>
  )
}
