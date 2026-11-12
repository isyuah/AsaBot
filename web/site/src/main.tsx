import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Site } from './site.tsx'
import './style.css'

const root = document.getElementById('root')
if (!root) throw new Error('Site root is missing')

createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <Site />
    </MotionConfig>
  </StrictMode>,
)
