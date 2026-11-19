import { AlertTriangle } from 'lucide-react'
import { Badge } from './ui/primitives.tsx'

export function CompatibilityInfo({
  value,
}: {
  value?: { declared: boolean; required: readonly { name: string }[]; optional: readonly { name: string }[] }
}) {
  if (!value) return <Badge>暂无能力记录</Badge>
  if (!value.declared) return <Badge>未声明能力要求</Badge>
  if (!value.required.length && !value.optional.length) return <Badge tone="success">能力匹配</Badge>
  return (
    <div className="space-y-1 text-[12px]">
      {value.required.length > 0 && (
        <p className="flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          缺少必须能力：{value.required.map((item) => item.name).join('、')}
        </p>
      )}
      {value.optional.length > 0 && (
        <p className="text-fg-3">缺少可选能力：{value.optional.map((item) => item.name).join('、')}</p>
      )}
      <p className="text-fg-3">仍可启用；相关功能可能不可用或降级。</p>
    </div>
  )
}
