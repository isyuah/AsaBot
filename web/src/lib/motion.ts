import { type Transition, useReducedMotion } from 'motion/react'

/** Shared motion presets so every transition in the panel feels like one system. */
export const spring: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }
export const softSpring: Transition = { type: 'spring', stiffness: 260, damping: 30 }
export const snappy: Transition = { type: 'spring', stiffness: 600, damping: 38 }

export function useFadeUp() {
  const reducedMotion = useReducedMotion()
  return {
    initial: { opacity: 0, y: reducedMotion ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reducedMotion ? 0 : -4, transition: { duration: 0.12 } },
    transition: softSpring,
  }
}

/** Parent/child variants for staggered list entrances. */
export const stagger = {
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
}
export const staggerItem = {
  initial: { opacity: 0, y: 10, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1, transition: softSpring },
}
