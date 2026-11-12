import type { z } from 'zod'
import { VirtualAdapter } from '../adapters/virtual/index.ts'
import type { App } from '../core/app.ts'
import { botActions } from '../core/bot.ts'
import type { DispatchTrace } from '../core/dispatch/trace.ts'
import { type LogRecord, subscribeLogs } from '../core/logger.ts'
import { plainText } from '../core/message/index.ts'
import type { playgroundEventSchema, playgroundSchema } from './schemas.ts'

export class Playground {
  private readonly app: App
  private readonly virtual: VirtualAdapter

  constructor(app: App) {
    this.app = app
    this.virtual = new VirtualAdapter(app, {
      selfId: 'playground',
      capabilities: { actions: [...botActions.filter((action) => action !== 'call'), 'getAvatarUrl'] },
    })
    app.apiInterceptors.wrap(this.virtual.bot)
    app.excludeBotFromStats(this.virtual.bot)
  }

  run(input: z.output<typeof playgroundSchema>) {
    return this.virtual.run(
      () =>
        this.collect(async () => {
          const result = await this.virtual.dispatchMessage(input.message ?? input.text ?? '', {
            user: input.user.id,
            nickname: input.user.nickname,
            role: input.user.role,
            superuser: input.user.superuser ?? false,
            group: input.group,
          })
          return { eventId: result.eventId, messageId: result.messageId }
        }),
      input.capabilities,
    )
  }

  event(input: z.output<typeof playgroundEventSchema>) {
    return this.virtual.run(() =>
      this.collect(async () => {
        const fields = input.fields ?? {}
        const userId = fields.userId ?? input.user.id
        const groupId = fields.groupId ?? input.group ?? '10'
        const optionalGroup = fields.groupId ?? input.group ?? undefined
        const operator = fields.operatorId === undefined ? {} : { operatorId: fields.operatorId }
        let eventId: string
        switch (input.name) {
          case 'notice.member.join':
            eventId = await this.virtual.emitNotice({
              name: input.name,
              userId,
              groupId,
              ...operator,
              joinType: fields.joinType ?? 'approve',
            })
            break
          case 'notice.member.leave':
            eventId = await this.virtual.emitNotice({
              name: input.name,
              userId,
              groupId,
              ...operator,
              reason: fields.reason ?? 'leave',
            })
            break
          case 'notice.member.mute':
            eventId = await this.virtual.emitNotice({
              name: input.name,
              userId,
              groupId,
              ...operator,
              duration: fields.duration ?? 60_000,
            })
            break
          case 'notice.poke':
            eventId = await this.virtual.emitNotice({
              name: input.name,
              userId,
              targetId: fields.targetId ?? this.virtual.bot.selfId,
              ...(optionalGroup === undefined ? {} : { groupId: optionalGroup }),
              ...operator,
            })
            break
          case 'notice.message.recall':
            eventId = await this.virtual.emitNotice({
              name: input.name,
              userId,
              messageId: fields.messageId ?? '1',
              ...(optionalGroup === undefined ? {} : { groupId: optionalGroup }),
              ...operator,
            })
            break
          case 'request.friend':
            eventId = await this.virtual.emitRequest({
              name: input.name,
              userId,
              comment: fields.comment ?? '',
            })
            break
          case 'request.group.join':
          case 'request.group.invite':
            eventId = await this.virtual.emitRequest({
              name: input.name,
              userId,
              groupId,
              comment: fields.comment ?? '',
            })
            break
        }
        // Notices and requests have no message ID, so the response carries no `incoming` (DESIGN §24.11).
        return { eventId }
      }),
    )
  }

  private async collect(dispatch: () => Promise<{ eventId: string; messageId?: string }>) {
    const sendsStart = this.virtual.bot.sends.length
    const actionsStart = this.virtual.bot.actions.length
    const logs: LogRecord[] = []
    const traces: DispatchTrace[] = []
    const links: [string, string][] = []
    const stopLogs = subscribeLogs((record) => logs.push(record))
    const stopTraces = this.app.subscribeDispatch((event) => {
      if (event.name === 'dispatch.trace' && 'trace' in event) traces.push(event.trace)
    })
    const stopLinks = this.app.dispatcher.subscribeTraceLinks((cause, related) =>
      links.push([cause, related]),
    )
    try {
      const incoming = await dispatch()
      const eventIds = new Set([incoming.eventId])
      let changed = true
      while (changed) {
        changed = false
        for (const [cause, related] of links) {
          if (eventIds.has(cause) && !eventIds.has(related)) {
            eventIds.add(related)
            changed = true
          }
        }
      }
      const selected = traces.filter((trace) => eventIds.has(trace.eventId))
      for (const id of eventIds) {
        if (selected.some((trace) => trace.eventId === id)) continue
        const active = this.app.dispatcher.activeTrace(id)
        if (active) selected.push(active)
      }
      return {
        ...(incoming.messageId === undefined ? {} : { incoming: { messageId: incoming.messageId } }),
        replies: this.virtual.bot.sends
          .slice(sendsStart)
          .filter((send) => send.eventId !== undefined && eventIds.has(send.eventId))
          .map(({ messageId, message }) => ({ messageId, message, text: plainText(message) })),
        actions: this.virtual.bot.actions
          .slice(actionsStart)
          .filter((action) => action.eventId !== undefined && eventIds.has(action.eventId))
          .map(({ action, params }) => ({ action, params })),
        traces: selected,
        logs: logs.filter((record) => record.eventId !== undefined && eventIds.has(record.eventId)),
      }
    } finally {
      stopLogs()
      stopTraces()
      stopLinks()
    }
  }
}
