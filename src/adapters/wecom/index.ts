import { defineAdapter } from '../../core/adapter.ts'
import { WecomAdapter } from './adapter.ts'
import { wecomCapabilities } from './bot.ts'
import { platform, wecomSchema } from './config.ts'

export { WecomAdapter, type WecomAdapterOptions } from './adapter.ts'
export { isWecomBot, isWecomSession, type WecomBot, type WecomSession, type WecomStream } from './bot.ts'
export { type WecomCardSegment, type WecomTemplateCard, wecom } from './cards.ts'
export { type WecomConfig, wecomSchema } from './config.ts'
export {
  isWecomCardAction,
  isWecomEnterChat,
  isWecomFeedback,
  type WecomCardActionEvent,
  type WecomEnterChatEvent,
  type WecomFeedbackEvent,
} from './events.ts'
export type { WecomHandlers, WecomTransport } from './transport.ts'

export const wecomDefinition = defineAdapter({
  id: platform,
  platform,
  name: '企业微信',
  version: '0.1.0',
  description: '企业微信智能机器人，使用 BotID 和 Secret 建立长连接。',
  connectionTypes: ['long-connection'],
  capabilities: wecomCapabilities,
  configSchema: wecomSchema,
  accountId: (config) => config.botId,
  create: (config, host) => new WecomAdapter(config, host),
})
