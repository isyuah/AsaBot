export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 配置对象递归合并；数组和普通值整体覆盖。 */
export function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isObject(override)) return override
  const result = isObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(override)) {
    Object.defineProperty(result, key, {
      value: mergeConfig(result[key], value),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return result
}
