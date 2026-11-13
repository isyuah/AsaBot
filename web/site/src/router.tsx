import type { ComponentProps } from 'react'
import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}

export function navigate(href: string) {
  const target = new URL(href, window.location.origin)
  const samePage = target.pathname === window.location.pathname && target.search === window.location.search
  if (target.href !== window.location.href) window.history.pushState(null, '', href)
  window.dispatchEvent(new PopStateEvent('popstate'))
  if (samePage) {
    if (target.hash) {
      document.getElementById(decodeURIComponent(target.hash.slice(1)))?.scrollIntoView()
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' })
      document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true })
    }
  }
}

export function Link({ href = '/', onClick, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target ||
          props.download
        )
          return
        const target = new URL(href, window.location.origin)
        if (target.origin !== window.location.origin) return
        event.preventDefault()
        navigate(target.pathname + target.search + target.hash)
      }}
    />
  )
}
