import type { Message, Segment } from '../../core/message/index.ts'

/** OneBot 正向 WebSocket 连接地址和可选访问令牌。 */
export interface OneBotConnectionConfig {
  type: 'forward'
  url: string
  accessToken?: string
}

/** OneBot 适配器的连接、重连、超时和发送队列配置。 */
export interface OneBot11Config {
  apiTimeout: number
  reconnect: { minDelay: number; maxDelay: number }
  connections: OneBotConnectionConfig[]
  reverse: { enabled: boolean; accessToken: string }
  sendQueue: { interval: number; jitter: number; maxPending: number }
}

/** OneBot WebSocket 请求、响应或事件帧。 */
export interface OneBotFrame {
  action?: string
  params?: Record<string, unknown>
  echo?: string
  status?: 'ok' | 'async' | 'failed' | string
  retcode?: number
  data?: unknown
  message?: unknown
  wording?: string
  post_type?: string
  [key: string]: unknown
}

/** OneBot API 接受的文本或消息段列表。 */
export type OneBotMessage = string | Segment[] | Message

/** OneBot 收到或发送的私聊、群消息事件帧。 */
export interface OneBotMessageEvent extends OneBotFrame {
  post_type: 'message' | 'message_sent'
  message_type: 'private' | 'group'
  message_id: number | string
  user_id: number | string
  group_id?: number | string
  message: string | Segment[]
  raw_message?: string
  sender?: {
    user_id?: number | string
    nickname?: string
    card?: string
    role?: string
    [key: string]: unknown
  }
  time?: number
  self_id?: number | string
}
