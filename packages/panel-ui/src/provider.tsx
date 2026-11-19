import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { TooltipProvider } from './ui/misc.tsx'

export function PanelUIProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>{children}</TooltipProvider>
    </MotionConfig>
  )
}
