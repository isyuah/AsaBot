const sensitiveKey = /token|password|secret|authorization|^_auth$/i

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
      /(\b(?:\w*token|\w*password|\w*secret|authorization|_auth)\b["']?\s*[=:]\s*["']?)(?:bearer\s+)?[^\s,"';}]+/gi,
      '$1[Redacted]',
    )
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
