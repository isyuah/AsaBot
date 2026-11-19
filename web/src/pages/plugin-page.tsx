import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@asabot/panel-ui'
import { useQuery } from '@tanstack/react-query'
import { AppWindow } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { subscribePluginEvents } from '../lib/realtime.tsx'
import { usePath } from '../lib/router.tsx'
import { useTheme } from '../lib/theme.tsx'

// Theme variables handed to plugin pages; the SDK applies them as --asabot-<name> on the page's :root.
const tokenNames = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-strong',
  'fg',
  'fg-2',
  'fg-3',
  'accent',
  'accent-hover',
  'accent-fg',
  'accent-soft',
  'accent-soft-fg',
  'success',
  'success-soft',
  'warning',
  'warning-soft',
  'danger',
  'danger-soft',
  'info',
  'info-soft',
  'ring',
  'shadow-card',
]

function themeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(tokenNames.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]))
}

type BridgeRequest =
  | { asabot: 1; kind: 'ready' }
  | { asabot: 1; kind: 'fetch'; id: number; path: string; method?: string; body?: unknown }
  | { asabot: 1; kind: 'toast'; text: string; level?: 'info' | 'success' | 'error' }

/**
 * Relays one plugin page request to the plugin's panel routes. The page is sandboxed without same-origin access, so
 * it can only reach /api/panel/ext/<plugin>/…: the resolved URL is checked after normalization, which rejects
 * `..`, encoded dot segments and backslashes that would otherwise escape to other panel APIs.
 */
async function relay(plugin: string, path: string, method: string, body: unknown) {
  const base = `/api/panel/ext/${encodeURIComponent(plugin)}`
  const url = new URL(base + path, window.location.origin)
  if (
    url.origin !== window.location.origin ||
    !(url.pathname === base || url.pathname.startsWith(`${base}/`))
  )
    return {
      status: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'Path escapes the plugin routes' } },
    }
  const verb = /^(GET|POST|PUT|PATCH|DELETE)$/.test(method) ? method : 'GET'
  const withBody = verb !== 'GET' && body !== undefined
  try {
    const response = await fetch(url, {
      method: verb,
      credentials: 'same-origin',
      headers: withBody ? { 'Content-Type': 'application/json' } : undefined,
      body: withBody ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      // Not JSON: hand the text over as-is.
    }
    return { status: response.status, body: parsed }
  } catch {
    return { status: 0, body: undefined }
  }
}

export function PluginPageHost() {
  const path = usePath()
  const name = decodeURIComponent(path.slice('/pages/'.length))
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins })
  const plugin = plugins.data?.find((item) => item.name === name)
  const frame = useRef<HTMLIFrameElement>(null)
  const { resolved } = useTheme()
  // Per plugin, so switching between plugin pages shows the skeleton until the new page has loaded.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const loaded = loadedFor === name
  const available = plugin?.state === 'active' && plugin.page !== undefined

  useEffect(() => {
    if (plugin?.page) document.title = `${plugin.page.title} · AsaBot`
  }, [plugin?.page])

  // Bridge: only messages from this iframe's window are handled.
  useEffect(() => {
    if (!available) return
    const post = (message: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage({ asabot: 1, ...message }, '*')
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const data = event.data as BridgeRequest | null
      if (data?.asabot !== 1) return
      if (data.kind === 'ready')
        post({
          kind: 'theme',
          mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          tokens: themeTokens(),
        })
      else if (data.kind === 'toast') {
        const text = String(data.text).slice(0, 300)
        if (data.level === 'error') toast.error(text)
        else if (data.level === 'success') toast.success(text)
        else toast(text)
      } else if (data.kind === 'fetch' && typeof data.id === 'number' && typeof data.path === 'string') {
        void relay(
          name,
          data.path.startsWith('/') ? data.path : `/${data.path}`,
          String(data.method ?? 'GET').toUpperCase(),
          data.body,
        ).then((result) => post({ id: data.id, ...result }))
      }
    }
    window.addEventListener('message', onMessage)
    const unsubscribe = subscribePluginEvents((event) => {
      if (event.plugin === name) post({ kind: 'event', topic: event.topic, data: event.data })
    })
    return () => {
      window.removeEventListener('message', onMessage)
      unsubscribe()
    }
  }, [available, name])

  // Re-send the theme whenever it changes (the class on <html> is already updated by the provider).
  useEffect(() => {
    if (!loaded) return
    frame.current?.contentWindow?.postMessage(
      { asabot: 1, kind: 'theme', mode: resolved, tokens: themeTokens() },
      '*',
    )
  }, [resolved, loaded])

  if (plugins.error && !plugins.data)
    return (
      <Card>
        <ErrorState
          error={plugins.error}
          onRetry={() => void plugins.refetch()}
          retrying={plugins.isFetching}
        />
      </Card>
    )
  if (!plugins.data) return <Skeleton className="h-[70vh] rounded-xl" />
  if (!available || !plugin?.page)
    return (
      <Card>
        <EmptyState
          icon={<AppWindow />}
          title="这个插件页面不可用"
          description={
            plugin
              ? plugin.state === 'active'
                ? '插件没有提供页面。'
                : '插件当前没有运行，启用后页面会出现在侧边栏。'
              : `没有名为 ${name} 的插件。`
          }
        />
      </Card>
    )

  const src = `/plugin-pages/${encodeURIComponent(name)}/`
  return (
    <>
      <PageHeader
        title={plugin.page.title}
        description={
          <>
            由插件 <span className="font-medium text-fg-2">{plugin.name}</span> 提供
          </>
        }
      />
      <Card className="relative overflow-hidden">
        {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
        <iframe
          ref={frame}
          key={name}
          title={plugin.page.title}
          src={src}
          sandbox="allow-scripts allow-forms allow-popups"
          onLoad={() => setLoadedFor(name)}
          className="block h-[calc(100dvh-190px)] min-h-[480px] w-full border-0 bg-transparent"
        />
      </Card>
    </>
  )
}
