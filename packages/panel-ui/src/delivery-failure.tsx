import type { DeliveryFailure } from './types.ts'
import { Badge } from './ui/primitives.tsx'

const labels = { not_sent: '未送达', unknown: '结果未知', partial: '部分送达' }

export function DeliveryFailureDetails({ failure }: { failure: DeliveryFailure }) {
  const { target, code, platformCode, confirmedMessageIds } = failure
  const destination = [target.platform, target.selfId, target.id, target.thread?.id]
    .filter(Boolean)
    .join(' / ')
  return (
    <div className="space-y-1.5 text-[12px] text-fg-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={failure.outcome === 'not_sent' ? 'neutral' : 'warning'}>{labels[failure.outcome]}</Badge>
        <code className="break-all font-mono">
          {code}
          {platformCode === undefined ? '' : ` · ${platformCode}`}
        </code>
      </div>
      <p className="break-all">
        {target.type === 'group' ? '群聊' : '私聊'} <code className="font-mono">{destination}</code>
      </p>
      {!!confirmedMessageIds?.length && (
        <p className="break-all">
          已确认消息 <code className="font-mono">{confirmedMessageIds.join('、')}</code>
        </p>
      )}
    </div>
  )
}
