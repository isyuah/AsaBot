import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { QrConnectionSetup } from '../../core/adapter.ts'
import { QrSetupError } from '../../core/errors.ts'
import { accountSchema, apiOrigin, IlinkError, ilink, ilinkOrigin } from './protocol.ts'

const qrSchema = z.object({
  qrcode: z.string().min(1).max(4096),
  qrcode_img_content: z.string().min(1).max(2048),
})
const statusSchema = z.object({
  status: z.enum([
    'wait',
    'scaned',
    'scaned_but_redirect',
    'need_verifycode',
    'confirmed_but_need_verifycode',
    'verify_code_blocked',
    'expired',
    'binded_redirect',
    'confirmed',
  ]),
  redirect_host: z.string().optional(),
  bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().max(512).optional(),
  baseurl: z.string().optional(),
})

function throwSetupError(error: unknown): never {
  if (error instanceof IlinkError)
    throw new QrSetupError(error.retryable ? `${error.message}。请检查 AsaBot 的网络后重试。` : error.message)
  if (error instanceof DOMException && error.name === 'TimeoutError')
    throw new QrSetupError('连接微信超时，请检查 AsaBot 的网络后重试。')
  throw error
}

async function pollStatus(url: URL, signal: AbortSignal): Promise<z.output<typeof statusSchema>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ilink(url, '查询二维码', statusSchema, signal, { timeout: 35_000 })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof DOMException && error.name === 'TimeoutError') return { status: 'wait' }
      if (!(error instanceof IlinkError) || !error.retryable || attempt >= 3) throwSetupError(error)
      await sleep(1000 * 2 ** attempt, undefined, { signal, ref: false })
    }
  }
}

function setupOrigin(value: string, label: string): string {
  try {
    return ilinkOrigin(value)
  } catch {
    throw new QrSetupError(`微信返回的${label}地址不受支持。`)
  }
}

export const weixinSetup: QrConnectionSetup = {
  kind: 'qr',
  async start(signal) {
    const { qrcode, qrcode_img_content } = await ilink(
      new URL('/ilink/bot/get_bot_qrcode?bot_type=3', apiOrigin),
      '生成二维码',
      qrSchema,
      signal,
      { data: { local_token_list: [] } },
    ).catch(throwSetupError)
    let origin = apiOrigin
    let redirected = 0
    let pendingCode: string | undefined
    return {
      content: qrcode_img_content,
      async poll(verifyCode) {
        if (verifyCode !== undefined) pendingCode = verifyCode
        const url = new URL('/ilink/bot/get_qrcode_status', origin)
        url.searchParams.set('qrcode', qrcode)
        if (pendingCode !== undefined) url.searchParams.set('verify_code', pendingCode)
        const result = await pollStatus(url, signal)
        switch (result.status) {
          case 'wait':
            return { status: 'waiting' }
          case 'scaned':
            pendingCode = undefined
            return { status: 'scanned' }
          case 'scaned_but_redirect':
            if (result.redirect_host) {
              if (++redirected > 5) throw new QrSetupError('微信扫码区域反复切换，请刷新二维码后重试。')
              origin = setupOrigin(`https://${result.redirect_host}`, '扫码区域')
            }
            return { status: 'scanned' }
          case 'need_verifycode':
          case 'confirmed_but_need_verifycode': {
            const retry = pendingCode !== undefined
            pendingCode = undefined
            return { status: 'verification', retry }
          }
          case 'verify_code_blocked':
          case 'expired':
            return { status: 'expired' }
          case 'binded_redirect':
            return { status: 'already-bound' }
          case 'confirmed': {
            const account = accountSchema.safeParse({
              selfId: result.ilink_bot_id,
              token: result.bot_token,
              apiBaseUrl: result.baseurl ? setupOrigin(result.baseurl, '授权服务') : origin,
            })
            if (!account.success) {
              const labels = { selfId: '机器人 ID', token: '登录令牌', apiBaseUrl: '授权服务地址' }
              const fields = Object.entries(labels)
                .filter(([field]) => account.error.issues.some((issue) => issue.path[0] === field))
                .map(([, label]) => label)
              throw new QrSetupError(`微信已确认扫码，但未返回有效的${fields.join('、')}。`)
            }
            return {
              status: 'authorized',
              config: account.data,
              adminUserId: result.ilink_user_id?.trim() || undefined,
            }
          }
        }
      },
    }
  },
}
