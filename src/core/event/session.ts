import type { Bot, SendResult } from '../bot.ts'
import type { Message, Sendable } from '../message/index.ts'
import { isSegment, normalizeSendable, plainText, seg } from '../message/index.ts'
import { formatTarget } from '../target.ts'
import type { LruSet } from '../utils/lru.ts'
import type { DialogueOptions, PromptOptions, Session, SessionServices } from './types.ts'

type Wait = (text?: Sendable, options?: PromptOptions) => Promise<Session | null>
type RunDialogue = <T>(work: (wait: Wait) => Promise<T>) => Promise<T>

export function dialogueMethods(run: RunDialogue): Pick<Session, 'prompt' | 'confirm' | 'choose'> {
  const prompt = (text?: Sendable, options: PromptOptions = {}): Promise<Session | null> =>
    run(async (wait) => {
      let next = text
      let retries = options.retries ?? 2
      while (true) {
        const reply = await wait(next, options)
        if (reply === null || options.validate === undefined) return reply
        if (/^(?:取消|cancel)$/i.test(reply.text.trim())) return null
        const result = await options.validate(reply)
        if (result === true) return reply
        if (retries-- <= 0) return null
        next = result
      }
    })

  const confirm = (text: Sendable, options?: DialogueOptions): Promise<boolean | null> =>
    run(async (wait) => {
      let next: Sendable | undefined = text
      let retries = options?.retries ?? 2
      while (true) {
        const reply = await wait(next, options)
        if (reply === null) return null
        const value = reply.text.trim().toLowerCase()
        if (value === '取消' || value === 'cancel') return null
        if (['是', '是的', '好', '好的', '确认', '确定', 'y', 'yes', 'ok'].includes(value)) return true
        if (['否', '不', '不要', '不是', 'n', 'no'].includes(value)) return false
        if (retries-- <= 0) return null
        next = '请回复“是”或“否”'
      }
    })

  function choose(text: Sendable, choices: string[], options?: DialogueOptions): Promise<string | null>
  function choose<T>(
    text: Sendable,
    choices: { label: string; value: T }[],
    options?: DialogueOptions,
  ): Promise<T | null>
  function choose<T>(
    text: Sendable,
    choices: (string | { label: string; value: T })[],
    options?: DialogueOptions,
  ): Promise<string | T | null> {
    return run(async (wait) => {
      const entries = choices.map((choice) =>
        typeof choice === 'string' ? { label: choice, value: choice } : choice,
      )
      let next: Sendable = [
        ...normalizeSendable(text),
        seg.text(`\n${entries.map((item, index) => `${index + 1}. ${item.label}`).join('\n')}`),
      ]
      let retries = options?.retries ?? 2
      while (true) {
        const reply = await wait(next, options)
        if (reply === null) return null
        const value = reply.text.trim()
        if (/^(?:取消|cancel)$/i.test(value)) return null
        const byNumber = /^\d+$/.test(value) ? entries[Number(value) - 1] : undefined
        const selected = byNumber ?? entries.find((item) => item.label === value)
        if (selected !== undefined) return selected.value
        if (retries-- <= 0) return null
        next = `请回复 1-${entries.length} 的编号`
      }
    })
  }
  return { prompt, confirm, choose }
}

/** 移除消息开头的引用、空白和对当前机器人的提及，返回新消息数组。 */
export function stripLeadingMention(message: Message, selfId: string): Message {
  const result = [...message]
  if (result[0]?.type === 'reply') {
    result.shift()
  }
  while (result.length > 0) {
    const first = result[0]
    if (first && isSegment(first, 'text')) {
      const originalText = first.data.text
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
    if (first && isSegment(first, 'at') && first.data.id === selfId) {
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
  isBotAdmin: boolean
  sentMessageIds?: LruSet<string>
}

export type SessionInit = SessionFields &
  ({ messageType: 'private'; groupId?: undefined } | { messageType: 'group'; groupId: string })

/** 根据适配器提供的消息字段和对话服务构建 Session。 */
export function createSession(init: SessionInit, services: SessionServices): Session {
  const isReplyToSelf = init.message.some(
    (segment) => isSegment(segment, 'reply') && init.sentMessageIds?.has(segment.data.id) === true,
  )
  const hasMention = init.message.some(
    (segment) => isSegment(segment, 'at') && segment.data.id === init.selfId,
  )
  const toMe = init.messageType === 'private' || hasMention || isReplyToSelf
  const target = {
    platform: init.platform,
    selfId: init.selfId,
    type: init.messageType,
    id: init.groupId ?? init.userId,
  }
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
    channelKey: formatTarget(target),
    target,
    message: init.message,
    text: plainText(init.message),
    sender: init.sender,
    toMe,
    isSuperuser: init.isSuperuser,
    isBotAdmin: init.isBotAdmin,
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
    async sendForward(nodes) {
      return init.bot.sendForward(
        { type: init.messageType, id: init.messageType === 'group' ? init.groupId : init.userId },
        nodes,
      )
    },
    ...dialogueMethods((work) => work((text, options) => services.prompt(session, text, options))),
  }
  return session
}
