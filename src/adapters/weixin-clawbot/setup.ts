import { z } from 'zod'
import type { QrConnectionSetup } from '../../core/adapter.ts'
import { type Account, accountSchema, apiOrigin, ilink, ilinkOrigin } from './protocol.ts'

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

export const weixinSetup: QrConnectionSetup<Account> = {
  kind: 'qr',
  accountId: (config) => config.selfId,
  async start(signal) {
    const { qrcode, qrcode_img_content } = await ilink(
      new URL('/ilink/bot/get_bot_qrcode?bot_type=3', apiOrigin),
      '生成二维码',
      qrSchema,
      signal,
      { data: { local_token_list: [] } },
    )
    let origin = apiOrigin
    let redirected = 0
    return {
      content: qrcode_img_content,
      async poll(verifyCode) {
        const url = new URL('/ilink/bot/get_qrcode_status', origin)
        url.searchParams.set('qrcode', qrcode)
        if (verifyCode !== undefined) url.searchParams.set('verify_code', verifyCode)
        let result: z.output<typeof statusSchema>
        try {
          result = await ilink(url, '查询二维码', statusSchema, signal, { timeout: 35_000 })
        } catch (error) {
          if (!signal.aborted && error instanceof DOMException && error.name === 'TimeoutError')
            return { status: verifyCode === undefined ? 'waiting' : 'verification' }
          throw error
        }
        switch (result.status) {
          case 'wait':
            return { status: 'waiting' }
          case 'scaned':
            return { status: 'scanned' }
          case 'scaned_but_redirect':
            if (!result.redirect_host || ++redirected > 5) throw new Error('微信扫码区域切换失败')
            origin = ilinkOrigin(`https://${result.redirect_host}`)
            return { status: 'scanned' }
          case 'need_verifycode':
            return { status: 'verification' }
          case 'verify_code_blocked':
          case 'expired':
            return { status: 'expired' }
          case 'binded_redirect':
            return { status: 'already-bound' }
          case 'confirmed':
            return {
              status: 'authorized',
              config: accountSchema.parse({
                selfId: result.ilink_bot_id,
                token: result.bot_token,
                apiBaseUrl: result.baseurl ? ilinkOrigin(result.baseurl) : origin,
              }),
              adminUserId: result.ilink_user_id?.trim() || undefined,
            }
        }
      },
    }
  },
}
