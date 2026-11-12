import type { Bot, SendResult } from '../bot.ts'
import type { Message, Sendable } from '../message/index.ts'
import { normalizeSendable, plainText, seg } from '../message/index.ts'
import type { LruSet } from '../utils/lru.ts'
import type { Session } from './types.ts'

export function stripLeadingMention(message: Message, selfId: string): Message {
  const result = [...message]
  if (result[0]?.type === 'reply') {
    result.shift()
  }
  while (result.length > 0) {
    const first = result[0]
    if (first?.type === 'text') {
      const originalText = String(first.data.text)
      const text = originalText.replace(/^\s+/, '')
      if (text.length === 0) {
        result.shift()
        continue
      }
      if (text !== originalText) {
        result[0] = { type: 'text', data: { text } }
      }
      break
    }
    if (first?.type === 'at' && first.data.qq === selfId) {
      result.shift()
      continue
    }
    break
  }
  return result
}

interface SessionFields {
  id: string
  platform: string
  selfId: string
  time: number
  raw: unknown
  bot: Bot
  messageId: string
  userId: string
  message: Message
  sender: Session['sender']
  isSuperuser: boolean
  sentMessageIds?: LruSet<string>
}

export type SessionInit = SessionFields &
  ({ messageType: 'private'; groupId?: undefined } | { messageType: 'group'; groupId: string })

export function createSession(init: SessionInit): Session {
  const isReplyToSelf = init.message.some(
    (segment) => segment.type === 'reply' && init.sentMessageIds?.has(String(segment.data.id)) === true,
  )
  const hasMention = init.message.some((segment) => segment.type === 'at' && segment.data.qq === init.selfId)
  const toMe = init.messageType === 'private' || hasMention || isReplyToSelf
  const session: Session = {
    id: init.id,
    platform: init.platform,
    selfId: init.selfId,
    time: init.time,
    kind: 'message',
    name: `message.${init.messageType}`,
    raw: init.raw,
    bot: init.bot,
    messageType: init.messageType,
    messageId: init.messageId,
    userId: init.userId,
    ...(init.groupId === undefined ? {} : { groupId: init.groupId }),
    channelKey: `${init.platform}:${init.selfId}:${init.messageType}:${init.groupId ?? init.userId}`,
    message: init.message,
    text: plainText(init.message),
    sender: init.sender,
    toMe,
    isSuperuser: init.isSuperuser,
    async send(content: Sendable): Promise<SendResult> {
      return init.messageType === 'group'
        ? init.bot.sendGroup(init.groupId, content)
        : init.bot.sendPrivate(init.userId, content)
    },
    async reply(content: Sendable, options = {}): Promise<SendResult> {
      const quote = options.quote ?? true
      const at = options.at ?? false
      const prefix: Message = []
      if (quote) {
        prefix.push(seg.reply(init.messageId))
      }
      if (at && init.messageType === 'group') {
        prefix.push(seg.at(init.userId))
      }
      return session.send([...prefix, ...normalizeSendable(content)])
    },
  }
  return session
}
