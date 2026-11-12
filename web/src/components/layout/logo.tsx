import { cn } from '../../lib/utils.ts'

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <defs>
        <linearGradient id="asabot-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7ffa" />
          <stop offset="1" stopColor="#5b4cf0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#asabot-logo)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="white" strokeOpacity="0.18" />
      <path
        d="M10 21.5 16 9l6 12.5M12.6 17h6.8"
        stroke="white"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
