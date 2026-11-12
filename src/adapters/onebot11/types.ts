import type { Message, Segment } from '../../core/message/index.ts'

export interface OneBotConnectionConfig {
  type: 'forward'
  url: string
  accessToken?: string
}

export interface OneBot11Config {
  apiTimeout: number
  reconnect: { minDelay: number; maxDelay: number }
  connections: OneBotConnectionConfig[]
}

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

export type OneBotMessage = string | Segment[] | Message

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
