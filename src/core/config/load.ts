import { readFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import { ConfigError } from '../errors.ts'
import { type Config, configSchema } from './schema.ts'

const interpolationPattern = /\$\{([A-Za-z_][A-Za-z\d_]*)(?::-([^}]*))?\}/g

export class InterpolationError extends ConfigError {
  readonly path: string

  constructor(name: string, path: string) {
    super(`Missing environment variable "${name}" at ${formatPath(path)}`)
    this.path = formatPath(path)
  }
}

function formatPath(path: string): string {
  return path || '<root>'
}

function interpolateString(value: string, path: string, env: NodeJS.ProcessEnv): string {
  return value.replace(interpolationPattern, (_match, name: string, fallback: string | undefined) => {
    const current = env[name]

    if (current !== undefined && (current !== '' || fallback === undefined)) {
      return current
    }

    if (fallback !== undefined) {
      return fallback
    }

    throw new InterpolationError(name, path)
  })
}

function interpolateValue(value: unknown, path: string, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return interpolateString(value, path, env)
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => interpolateValue(item, `${path}[${index}]`, env))
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      const itemPath = path ? `${path}.${key}` : key
      result[key] = interpolateValue(item, itemPath, env)
    }
    return result
  }

  return value
}

export function interpolateConfigValues(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  return interpolateValue(value, '', env)
}

export function formatIssuePath(path: PropertyKey[]): string {
  return (
    path.reduce<string>((result, part) => {
      if (typeof part === 'number') {
        return `${result}[${part}]`
      }
      return result ? `${result}.${String(part)}` : String(part)
    }, '') || '<root>'
  )
}

export async function readRawConfig(path: string): Promise<unknown> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new ConfigError(`Unable to read configuration file "${path}"`, { cause: error })
  }

  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length > 0) {
    const reasons = document.errors.map((error) => `YAML: ${error.message}`)
    throw new ConfigError(`Invalid configuration file "${path}":\n${reasons.join('\n')}`)
  }

  return document.toJS()
}

export async function loadConfig(path: string): Promise<Config> {
  const interpolated = interpolateConfigValues(await readRawConfig(path))
  const result = configSchema.safeParse(interpolated)

  if (!result.success) {
    const reasons = result.error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    throw new ConfigError(`Configuration validation failed:\n${reasons.join('\n')}`)
  }

  return result.data
}
