const sensitiveKey = /token|password|secret|authorization|credential|api[_-]?key|private[_-]?key|^_auth$/i

function secretsIn(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return sensitiveKey.test(key) && value ? [value] : []
  if (Array.isArray(value)) return value.flatMap((item) => secretsIn(item))
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([name, item]) => secretsIn(item, name))
  return []
}

/** Redact credentials in free-form external error messages. */
export function redactText(value: string, config?: unknown): string {
  let result = value
    .replace(
      /(\b(?:[\w-]*(?:token|password|secret)|authorization|credential|api[_-]?key|private[_-]?key|_auth)\b["']?\s*[=:]\s*["']?)(?:bearer\s+)?[^\s,"';}]+/gi,
      '$1[Redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z\d._~+/-]+=*/gi, 'Bearer [Redacted]')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[Redacted]@')
  const secrets = [
    ...secretsIn(config),
    ...Object.entries(process.env).flatMap(([key, secret]) =>
      sensitiveKey.test(key) && secret && secret.length >= 4 ? [secret] : [],
    ),
  ]
  for (const secret of secrets.sort((a, b) => b.length - a.length))
    result = result.replaceAll(secret, '[Redacted]')
  return result
}

/** Respect third-party schema writeOnly fields even when their names are not conventional secret keys. */
export function redactSchemaText(text: string, config: unknown, schema: unknown): string {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const secrets = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) secrets.add(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (record(value)) Object.values(value).forEach(collect)
  }
  const walk = (value: unknown, node: unknown): void => {
    if (!record(node)) return
    if (node.writeOnly === true) collect(value)
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      let target = schema
      for (const key of node.$ref.slice(2).split('/'))
        target = record(target) ? target[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined
      walk(value, target)
    }
    for (const kind of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(node[kind])) for (const child of node[kind]) walk(value, child)
    if (Array.isArray(value)) for (const item of value) walk(item, node.items)
    if (record(value) && record(node.properties))
      for (const [key, child] of Object.entries(node.properties)) walk(value[key], child)
  }
  walk(config, schema)
  let result = redactText(text, config)
  for (const value of [...secrets].sort((a, b) => b.length - a.length))
    result = result.replaceAll(value, '[Redacted]')
  return result
}

/** Mask structured payloads before returning them through administrative APIs. */
export function redactValue(value: unknown, config?: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[Redacted]'
  if (typeof value === 'string') return redactText(value, config)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, config))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactValue(item, config, name)]),
    )
  return value
}
