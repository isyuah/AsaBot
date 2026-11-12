import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, getRecentLogs } from './logger.ts'

describe('logger redaction', () => {
  it('redacts sensitive fields in output and recent logs', () => {
    let output = ''
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    const testLogger = createLogger({ destination, pretty: false })
    const marker = `redaction-test-${crypto.randomUUID()}`
    const secrets = ['root-access', 'root-token', 'root-password', 'root-api-token', 'nested-token']

    testLogger.info(
      {
        accessToken: secrets[0],
        token: secrets[1],
        password: secrets[2],
        apiToken: secrets[3],
        nested: { token: secrets[4] },
      },
      marker,
    )

    const recentLog = getRecentLogs().find((record) => record.msg === marker)
    expect(recentLog).toBeDefined()
    expect(JSON.stringify(recentLog)).not.toContain(secrets.join('|'))
    expect(output).toContain('[Redacted]')
    for (const secret of secrets) {
      expect(output).not.toContain(secret)
      expect(JSON.stringify(recentLog)).not.toContain(secret)
    }
  })

  it('rotates files by size and keeps stdout usable if a file fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-logs-'))
    try {
      let output = ''
      const destination = new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString()
          callback()
        },
      })
      const path = join(dir, 'logs', 'asabot.log')
      const log = createLogger({ destination, pretty: false, file: { path, maxSize: 1, maxFiles: 3 } })
      for (const message of ['one', 'two', 'three', 'four']) log.info(message)
      expect((await readdir(join(dir, 'logs'))).sort()).toEqual([
        'asabot.log',
        'asabot.log.1',
        'asabot.log.2',
      ])
      expect(JSON.parse(await readFile(path, 'utf8')).msg).toBe('four')
      expect(JSON.parse(await readFile(`${path}.1`, 'utf8')).msg).toBe('three')
      expect(JSON.parse(await readFile(`${path}.2`, 'utf8')).msg).toBe('two')
      const broken = createLogger({
        destination,
        pretty: false,
        file: { path: dir, maxSize: 1, maxFiles: 2 },
      })
      broken.info('still written')
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(output).toContain('still written')
      expect(output).toContain('Log file write or rotation failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
