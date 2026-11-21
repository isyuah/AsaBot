import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CredentialInput } from './contracts.ts'
import { AiError } from './errors.ts'

export type StoredCredential = Exclude<CredentialInput, { kind: 'key' }> | { kind: 'key'; encrypted: string }

export class Vault {
  private readonly keyFile: string

  constructor(dataDir: string) {
    this.keyFile = join(dataDir, 'credentials.key')
  }

  seal(channelId: string, credential: CredentialInput, allowCreate: boolean): StoredCredential {
    if (credential.kind !== 'key') return credential
    const key = this.readKey(allowCreate)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(channelId))
    const data = Buffer.concat([cipher.update(credential.value, 'utf8'), cipher.final()])
    return { kind: 'key', encrypted: Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') }
  }

  resolve(channelId: string, stored: StoredCredential): string | undefined {
    if (stored.kind === 'none') return undefined
    if (stored.kind === 'env') {
      const value = process.env[stored.variable]
      if (!value || !/^[\x21-\x7e]+$/.test(value)) throw new AiError('CREDENTIAL_UNAVAILABLE')
      return value
    }
    try {
      const key = this.readKey(false)
      const blob = Buffer.from(stored.encrypted, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
      decipher.setAAD(Buffer.from(channelId))
      decipher.setAuthTag(blob.subarray(12, 28))
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')
    } catch {
      throw new AiError('CREDENTIAL_UNAVAILABLE')
    }
  }

  state(channelId: string, stored: StoredCredential): 'none' | 'configured' | 'missing' {
    if (stored.kind === 'none') return 'none'
    try {
      this.resolve(channelId, stored)
      return 'configured'
    } catch (error) {
      if (!(error instanceof AiError)) throw error
      return 'missing'
    }
  }

  private readKey(allowCreate: boolean): Buffer {
    try {
      const key = readFileSync(this.keyFile)
      if (key.length !== 32) throw new AiError('CREDENTIAL_UNAVAILABLE')
      return key
    } catch (error) {
      if (!allowCreate || !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new AiError('CREDENTIAL_UNAVAILABLE')
      try {
        writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
      } catch (writeError) {
        if (!(writeError instanceof Error && 'code' in writeError && writeError.code === 'EEXIST'))
          throw new AiError('CREDENTIAL_UNAVAILABLE')
      }
      return this.readKey(false)
    }
  }
}
