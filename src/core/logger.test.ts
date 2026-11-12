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
})
