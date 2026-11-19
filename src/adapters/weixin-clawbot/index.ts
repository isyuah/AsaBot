import { defineAdapter } from '../../core/adapter.ts'
import { WeixinAdapter } from './adapter.ts'
import { weixinCapabilities } from './bot.ts'
import { accountSchema, platform } from './protocol.ts'
import { weixinSetup } from './setup.ts'

export { isWeixinClawBot, type WeixinBot } from './bot.ts'

export const weixinClawbot = defineAdapter({
  id: platform,
  platform,
  name: '微信 ClawBot',
  version: '0.1.0',
  description: '用微信扫码授权，通过 iLink 长轮询收发私聊消息。',
  connectionTypes: ['long-polling'],
  capabilities: weixinCapabilities,
  configSchema: accountSchema,
  accountId: (config) => config.selfId,
  setup: weixinSetup,
  create: (config, host) => new WeixinAdapter(config, host),
})
