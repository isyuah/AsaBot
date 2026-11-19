import { z } from 'zod'
import { type Adapter, defineAdapter } from '../core/adapter.ts'
import { FeishuAdapter } from './feishu/adapter.ts'
import { feishuCapabilities } from './feishu/bot.ts'
import { feishuSchema } from './feishu/config.ts'
import { OneBotAdapter, onebotCapabilities } from './onebot11/adapter.ts'
import { onebot11Schema } from './onebot11/config.ts'
import { wecomDefinition } from './wecom/index.ts'
import { weixinClawbot } from './weixin-clawbot/index.ts'

const feishuConnection = feishuSchema.omit({ accounts: true }).extend({
  appId: z
    .string()
    .regex(/^cli_[0-9a-fA-F]{16}$/)
    .meta({ title: 'App ID' }),
  appSecret: z.string().min(1).meta({ title: 'App Secret', writeOnly: true }),
})
const onebotConnection = onebot11Schema
  .omit({ connections: true, reverse: true })
  .extend({
    type: z.enum(['forward', 'reverse']).default('forward').meta({ title: '连接方式' }),
    url: z
      .url()
      .refine((value) => /^wss?:/.test(value), '请使用 ws:// 或 wss:// 地址')
      .optional()
      .meta({ title: '正向 WebSocket 地址' }),
    accessToken: z.string().default('').meta({ title: '访问令牌', writeOnly: true }),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'forward' && !value.url)
      ctx.addIssue({ code: 'custom', path: ['url'], message: '正向连接需要 WebSocket 地址' })
  })

function reconfigurable(adapter: Adapter, convert: (config: unknown) => unknown): Adapter {
  return {
    platform: adapter.platform,
    start: () => adapter.start(),
    stop: () => adapter.stop(),
    reconfigure: (config) => adapter.reconfigure(convert(config)),
  }
}
function feishuConfig({ appId, appSecret, ...options }: z.output<typeof feishuConnection>) {
  return { ...options, accounts: [{ appId, appSecret }] }
}
function onebotConfig({ type, url, accessToken, ...options }: z.output<typeof onebotConnection>) {
  return {
    ...options,
    connections: type === 'forward' ? [{ type: 'forward' as const, url: url as string, accessToken }] : [],
    reverse: { enabled: type === 'reverse', accessToken },
  }
}

export const adapters = [
  defineAdapter({
    id: 'feishu',
    platform: 'feishu',
    name: '飞书',
    version: '0.1.0',
    description: '企业自建应用，通过长连接接收消息、事件和卡片回调。',
    connectionTypes: ['long-connection'],
    capabilities: feishuCapabilities,
    configSchema: feishuConnection,
    botBinding: (config) => ({ key: config.appId }),
    create: (config, host) =>
      reconfigurable(new FeishuAdapter(feishuConfig(config), host), (value) =>
        feishuConfig(feishuConnection.parse(value)),
      ),
  }),
  defineAdapter({
    id: 'onebot11',
    platform: 'onebot11',
    name: 'OneBot 11',
    version: '0.1.0',
    description: '连接 NapCat 等 OneBot 11 实现，支持正向连接与反向监听。',
    connectionTypes: ['forward', 'reverse'],
    capabilities: onebotCapabilities,
    configSchema: onebotConnection,
    botBinding: (config) =>
      config.type === 'reverse' ? { key: 'reverse', multiple: true } : { key: `forward:${config.url}` },
    create: (config, host) =>
      reconfigurable(
        new OneBotAdapter(onebotConfig(config), host, { ignoreSelf: host.ignoreSelf }),
        (value) => onebotConfig(onebotConnection.parse(value)),
      ),
  }),
  wecomDefinition,
  weixinClawbot,
]
