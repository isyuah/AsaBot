import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import QRCode from 'qrcode'
import { z } from 'zod'
import type { QrConnectionSetup, QrSetupChallenge } from '../core/adapter.ts'
import type { App } from '../core/app.ts'
import { connectionSchema } from '../core/connections.ts'
import { QrSetupError } from '../core/errors.ts'
import { actorIdentitySchema, botIdentitySchema } from '../core/identity.ts'
import {
  ConnectionSetupError,
  type ConnectionSetupSaveInput,
  type SettingsService,
  type SetupAccount,
} from './settings.ts'

export const connectionSetupInput = z.strictObject({
  adapter: connectionSchema.shape.adapter,
  connectionId: connectionSchema.shape.id.optional(),
})
export const verificationInput = z.strictObject({ code: z.string().trim().min(1).max(64) })

type SetupState =
  | { status: 'starting' | 'scanned' | 'expired' | 'already-bound' }
  | { status: 'failed'; detail?: string }
  | { status: 'waiting'; image: string }
  | { status: 'verification'; retry: boolean }
  | { status: 'authorized'; selfId: string; replaces?: string; missingAdmin: boolean }
  | { status: 'saved'; connectionId: string }

interface Draft {
  id: string
  owner: string
  adapter: string
  connectionId: string
  previousAccount?: SetupAccount
  expiresAt: number
  controller: AbortController
  timer: NodeJS.Timeout
  state: SetupState
  challenge?: QrSetupChallenge
  account?: SetupAccount & { adminUserId?: string }
  saving?: Promise<{ connectionId: string }>
}

const lifetime = 5 * 60_000

export class ConnectionSetups {
  private readonly app: App
  private readonly settings: SettingsService
  private readonly drafts = new Map<string, Draft>()

  constructor(app: App, settings: SettingsService) {
    this.app = app
    this.settings = settings
  }

  start(owner: { token: string; expiresAt: number }, input: z.output<typeof connectionSetupInput>) {
    const { adapter, connectionId } = input
    const definition = this.app.connections.definition(adapter)
    const { setup } = definition
    if (!setup) throw new ConnectionSetupError(400, '此适配器不支持扫码接入')
    const existing = connectionId && this.app.config.connections.find((record) => record.id === connectionId)
    if (connectionId && (!existing || existing.adapter !== adapter))
      throw new ConnectionSetupError(404, '找不到对应的连接')
    if (this.drafts.size >= 64 || this.activeCount(owner.token) >= 4)
      throw new ConnectionSetupError(429, '进行中的扫码过多，请取消其他扫码后重试')

    const config = existing ? definition.configSchema.parse(existing.config) : undefined
    const id = randomUUID()
    const expiresAt = Math.min(Date.now() + lifetime, owner.expiresAt)
    const draft: Draft = {
      id,
      owner: owner.token,
      adapter,
      connectionId: connectionId ?? randomUUID(),
      ...(existing && { previousAccount: { selfId: setup.accountId(config), config } }),
      expiresAt,
      controller: new AbortController(),
      timer: setTimeout(() => this.drop(id), Math.max(0, expiresAt - Date.now())).unref(),
      state: { status: 'starting' },
    }
    this.drafts.set(id, draft)
    void this.poll(draft, setup)
    return this.view(draft)
  }

  status(owner: string, id: string) {
    return this.view(this.require(owner, id))
  }

  verify(owner: string, id: string, code: string) {
    const draft = this.require(owner, id)
    if (draft.state.status !== 'verification') throw new ConnectionSetupError(409, '当前不需要验证码')
    draft.state = { status: 'scanned' }
    const setup = this.app.connections.definition(draft.adapter).setup
    if (!setup) throw new Error('Missing QR provider')
    void this.poll(draft, setup, code)
    return this.view(draft)
  }

  save(owner: string, id: string, options: ConnectionSetupSaveInput) {
    const draft = this.require(owner, id)
    if (draft.state.status === 'saved') return Promise.resolve({ connectionId: draft.connectionId })
    if (draft.saving) return draft.saving
    if (!draft.account) throw new ConnectionSetupError(409, '请先完成扫码授权')
    draft.saving = this.settings
      .saveConnectionSetup({
        id: draft.connectionId,
        adapter: draft.adapter,
        previousAccount: draft.previousAccount,
        account: draft.account,
        options,
        signal: draft.controller.signal,
      })
      .then(() => {
        this.finish(draft, { status: 'saved', connectionId: draft.connectionId })
        return { connectionId: draft.connectionId }
      })
      .finally(() => {
        draft.saving = undefined
      })
    return draft.saving
  }

  cancel(owner: string, id: string): void {
    const draft = this.require(owner, id)
    if (draft.state.status === 'saved') return
    if (draft.saving) throw new ConnectionSetupError(409, '正在保存连接')
    this.drop(id)
  }

  revoke(owner?: string): void {
    for (const draft of this.drafts.values()) if (!owner || draft.owner === owner) this.drop(draft.id)
  }

  private activeCount(owner: string): number {
    return [...this.drafts.values()].filter(
      (draft) =>
        draft.owner === owner &&
        ['starting', 'waiting', 'scanned', 'verification', 'authorized'].includes(draft.state.status),
    ).length
  }

  private require(owner: string, id: string): Draft {
    const draft = this.drafts.get(id)
    if (!draft || draft.owner !== owner || draft.expiresAt <= Date.now())
      throw new ConnectionSetupError(404, '扫码已结束，请重新扫码')
    return draft
  }

  private view(draft: Draft) {
    return { id: draft.id, expiresAt: draft.expiresAt, ...draft.state }
  }

  private drop(id: string): void {
    const draft = this.drafts.get(id)
    if (!draft) return
    clearTimeout(draft.timer)
    this.finish(draft, { status: 'expired' })
    this.drafts.delete(id)
  }

  private finish(draft: Draft, state: SetupState): void {
    draft.state = state
    draft.challenge = undefined
    draft.account = undefined
    draft.previousAccount = undefined
    draft.controller.abort()
  }

  private async poll(draft: Draft, setup: QrConnectionSetup, code?: string): Promise<void> {
    const signal = draft.controller.signal
    try {
      if (!draft.challenge) {
        const challenge = await setup.start(signal)
        signal.throwIfAborted()
        const image = await QRCode.toDataURL(challenge.content, { margin: 4, scale: 6 })
        signal.throwIfAborted()
        draft.challenge = challenge
        draft.state = { status: 'waiting', image }
      }
      const challenge = draft.challenge
      while (!signal.aborted) {
        const update = await challenge.poll(code)
        signal.throwIfAborted()
        switch (update.status) {
          case 'verification':
            draft.state = { status: 'verification', retry: update.retry }
            return
          case 'authorized': {
            const definition = this.app.connections.definition(draft.adapter)
            const config = definition.configSchema.parse(update.config)
            const selfId = botIdentitySchema.shape.selfId.parse(setup.accountId(config))
            const adminUserId = actorIdentitySchema.shape.userId.optional().parse(update.adminUserId)
            const previous = draft.previousAccount?.selfId
            draft.challenge = undefined
            draft.account = { selfId, config: update.config, adminUserId }
            draft.state = {
              status: 'authorized',
              selfId,
              ...(previous && previous !== selfId && { replaces: previous }),
              missingAdmin: previous !== selfId && !adminUserId,
            }
            return
          }
          case 'expired':
          case 'already-bound':
            this.finish(draft, { status: update.status })
            return
          case 'scanned':
            draft.state = { status: 'scanned' }
            break
        }
        code = undefined
        await sleep(750, undefined, { signal, ref: false })
      }
    } catch (error) {
      if (signal.aborted) return
      const detail = error instanceof QrSetupError ? error.message : undefined
      this.app.logger.warn(
        { adapter: draft.adapter, stage: draft.state.status, detail },
        'Connection setup failed',
      )
      this.finish(draft, { status: 'failed', detail })
    }
  }
}
