import { lazy, Suspense, useEffect } from 'react'
import { usePathname } from './router.tsx'
import { Site } from './site.tsx'

const Docs = lazy(() => import('./docs.tsx').then((module) => ({ default: module.Docs })))

export function App() {
  const pathname = usePathname()
  useEffect(() => {
    if (pathname.startsWith('/docs')) return
    document.title = 'AsaBot — 让想法，在对话里发生'
    if (window.location.hash) {
      document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView()
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true })
  }, [pathname])
  return pathname.startsWith('/docs') ? (
    <Suspense
      fallback={
        <div className="route-loading" role="status">
          正在打开文档…
        </div>
      }
    >
      <Docs pathname={pathname} />
    </Suspense>
  ) : (
    <Site />
  )
}
