import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './load.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function writeConfig(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'asabot-config-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'config.yaml')
  await writeFile(path, source, 'utf8')
  return path
}

describe('loadConfig', () => {
  it('interpolates environment values in parsed YAML strings', async () => {
    const previous = process.env.ASABOT_CONFIG_TEST
    process.env.ASABOT_CONFIG_TEST = 'configured'
    const path = await writeConfig(`dataDir: \${ASABOT_CONFIG_TEST}\n`)

    try {
      const config = await loadConfig(path)
      expect(config.dataDir).toBe('configured')
    } finally {
      if (previous === undefined) {
        delete process.env.ASABOT_CONFIG_TEST
      } else {
        process.env.ASABOT_CONFIG_TEST = previous
      }
    }
  })

  it('uses interpolation defaults and reports missing variables with a config path', async () => {
    const previous = process.env.ASABOT_CONFIG_MISSING
    delete process.env.ASABOT_CONFIG_MISSING
    const defaultPath = await writeConfig(`dataDir: \${ASABOT_CONFIG_MISSING:-./fallback}\n`)
    const missingPath = await writeConfig(
      `adapters:\n  custom:\n    connections:\n      - url: \${ASABOT_CONFIG_MISSING}\n`,
    )

    try {
      const config = await loadConfig(defaultPath)
      expect(config.dataDir).toBe('./fallback')
      await expect(loadConfig(missingPath)).rejects.toThrow(
        'Missing environment variable "ASABOT_CONFIG_MISSING" at adapters.custom.connections[0].url',
      )
    } finally {
      if (previous !== undefined) {
        process.env.ASABOT_CONFIG_MISSING = previous
      }
    }
  })

  it('aggregates validation errors with field paths', async () => {
    const path = await writeConfig('command:\n  prefixes: invalid\nserver:\n  port: -1\n')

    await expect(loadConfig(path)).rejects.toThrow(/command\.prefixes:.*\nserver\.port:/)
  })
})
