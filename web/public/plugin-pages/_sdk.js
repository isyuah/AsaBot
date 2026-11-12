// AsaBot plugin page SDK. Load it with a classic script tag inside a plugin page:
//   <script src="/plugin-pages/_sdk.js"></script>
// The page runs in a sandboxed iframe without access to the panel's cookies, so every API call is relayed by the
// panel through postMessage to the plugin's authenticated routes (`ctx.panel.route`).
;(() => {
  if (window.asabot) return
  const parent = window.parent
  const pending = new Map()
  const listeners = new Map()
  const themeListeners = new Set()
  let nextId = 1
  const theme = { mode: 'light', tokens: {} }

  function post(message) {
    // The panel is the only parent; its origin is opaque to us (sandboxed), so the target must be '*'.
    parent.postMessage({ asabot: 1, ...message }, '*')
  }

  function applyTheme(next) {
    theme.mode = next.mode === 'dark' ? 'dark' : 'light'
    theme.tokens = next.tokens ?? {}
    const root = document.documentElement
    root.dataset.theme = theme.mode
    root.style.colorScheme = theme.mode
    for (const [name, value] of Object.entries(theme.tokens)) {
      root.style.setProperty(`--asabot-${name.replace(/^--/, '')}`, String(value))
    }
    for (const listener of themeListeners) listener(theme)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (!data || data.asabot !== 1) return
    if (data.kind === 'theme') applyTheme(data)
    else if (data.kind === 'event') {
      for (const listener of listeners.get(data.topic) ?? []) listener(data.data)
    } else if (typeof data.id === 'number' && pending.has(data.id)) {
      const resolve = pending.get(data.id)
      pending.delete(data.id)
      resolve({ status: data.status, data: data.body })
    }
  })

  /** Calls one of this plugin's panel routes. Resolves with the HTTP status (0 on network failure) and the parsed body. */
  function request(path, init = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('path must start with "/"')
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      post({ kind: 'fetch', id, path, method: (init.method ?? 'GET').toUpperCase(), body: init.body })
    })
  }

  window.asabot = Object.freeze({
    fetch: request,
    /** Like fetch, but returns the body directly and throws on a non-2xx status. */
    async json(path, init) {
      const response = await request(path, init)
      if (response.status < 200 || response.status >= 300) {
        const message = response.data?.error?.message ?? `Request failed with status ${response.status}`
        throw Object.assign(new Error(message), { status: response.status, data: response.data })
      }
      return response.data
    },
    /** Subscribes to `ctx.panel.push(topic, data)` events of this plugin. Returns an unsubscribe function. */
    on(topic, listener) {
      let set = listeners.get(topic)
      if (!set) listeners.set(topic, (set = new Set()))
      set.add(listener)
      return () => set.delete(listener)
    },
    /** Shows a toast in the panel. level: 'info' | 'success' | 'error'. */
    toast(text, level = 'info') {
      post({ kind: 'toast', text: String(text), level })
    },
    /** The current panel theme; tokens are also applied to :root as --asabot-<name> CSS variables. */
    get theme() {
      return theme
    },
    onTheme(listener) {
      themeListeners.add(listener)
      return () => themeListeners.delete(listener)
    },
  })

  post({ kind: 'ready' })
})()
