import { useState } from 'react'
import { cn } from '../lib/utils.ts'

const palettes = [
  'bg-[#efedff] text-[#5245de] dark:bg-[#8b7ffa]/15 dark:text-[#b4acff]',
  'bg-[#e2f5ef] text-[#0e8a6c] dark:bg-[#2bbd95]/15 dark:text-[#5fd6b3]',
  'bg-[#fdeef4] text-[#c2457a] dark:bg-[#f2a5c8]/15 dark:text-[#f2a5c8]',
  'bg-[#e7effd] text-[#2f6fd6] dark:bg-[#5f9cf3]/15 dark:text-[#8ab8f7]',
  'bg-[#fcf0d9] text-[#a76a05] dark:bg-[#e9a43a]/15 dark:text-[#f0bf70]',
]

function hash(value: string): number {
  let result = 0
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) >>> 0
  return result
}

/**
 * Shows the avatar URL supplied by the backend (adapters know where their platform keeps avatars), falling back to a
 * soft colored initial. The panel itself never builds platform-specific avatar URLs.
 */
export function Avatar({
  id,
  name,
  src,
  size = 32,
  className,
}: {
  id: string
  name?: string
  src?: string
  size?: number
  className?: string
}) {
  const [failedSrc, setFailedSrc] = useState<string>()
  const initial = (name?.trim() || id).slice(0, 1).toUpperCase()
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium select-none',
        palettes[hash(id) % palettes.length],
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        initial
      )}
      <span className="absolute inset-0 rounded-full ring-1 ring-black/5 ring-inset dark:ring-white/10" />
    </span>
  )
}
