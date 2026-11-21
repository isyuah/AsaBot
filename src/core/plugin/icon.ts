export function parsePluginIconUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  const url = URL.parse(value)
  if (url?.protocol === 'https:' && !url.username && !url.password) return url.href
}

export function pluginIconFromKeywords(keywords: unknown): string | undefined {
  if (!Array.isArray(keywords)) return undefined
  const prefix = 'asabot-icon:'
  const keyword = keywords.find(
    (value): value is string => typeof value === 'string' && value.startsWith(prefix),
  )
  return parsePluginIconUrl(keyword?.slice(prefix.length))
}
