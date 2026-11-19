import { Button, SchemaForm } from '@asabot/panel-ui'
import { useMutation } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '../lib/api.ts'
import type { PluginView } from '../lib/types.ts'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function difference(
  value: Record<string, unknown>,
  inherited: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (JSON.stringify(item) === JSON.stringify(inherited[key])) continue
    result[key] = object(item) && object(inherited[key]) ? difference(item, inherited[key]) : item
  }
  return result
}
const sourceLabels: Record<string, string> = {
  global: '全局配置',
  bot: '机器人覆盖',
  group: '群组覆盖',
  default: '插件默认值',
}

export function ScopedConfig({
  plugin,
  inherited,
  effective,
  override,
  sources,
  save: persist,
  onSaved,
}: {
  plugin: PluginView
  inherited: unknown
  effective: unknown
  override?: Record<string, unknown>
  sources: Record<string, string>
  save: (config: Record<string, unknown> | null) => Promise<unknown>
  onSaved: () => void
}) {
  const save = useMutation({
    mutationFn: persist,
    onSuccess: (_, value) => {
      toast.success(value === null ? '已恢复继承配置' : '配置覆盖已保存')
      onSaved()
    },
  })
  const issues =
    save.error instanceof ApiError
      ? Object.fromEntries(
          save.error.issues.map((issue) => [
            issue.path.replace(`plugins.${plugin.name}.config`, '').replace(/^\./, ''),
            issue.message,
          ]),
        )
      : {}
  if (!plugin.configSchema || !object(effective) || !object(inherited))
    return <p className="text-sm text-fg-3">这个插件没有可用的对象配置，可在插件详情中检查全局配置。</p>
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-fg-3">
        <span>{override ? `已覆盖：${Object.keys(override).join('、')}` : '当前继承上级配置'}</span>
        {override && (
          <Button variant="ghost" size="sm" loading={save.isPending} onClick={() => save.mutate(null)}>
            <RotateCcw className="size-3.5" />
            恢复继承
          </Button>
        )}
      </div>
      <SchemaForm
        schema={plugin.configSchema}
        value={effective}
        issues={issues}
        saving={save.isPending}
        note="只保存修改的字段，立即生效"
        submitLabel="保存覆盖"
        onSubmit={(value) => {
          const diff = difference(value as Record<string, unknown>, inherited)
          save.mutate(Object.keys(diff).length ? diff : null)
        }}
      />
      <details className="rounded-lg border border-border px-3 py-2 text-[12.5px]">
        <summary className="cursor-pointer text-fg-2">字段来源</summary>
        <dl className="mt-2 divide-y divide-border">
          {Object.entries(sources).map(([path, source]) => (
            <div className="flex justify-between gap-3 py-2" key={path}>
              <dt className="break-all font-mono text-fg-2">{path}</dt>
              <dd className="shrink-0 text-fg-3">{sourceLabels[source] ?? source}</dd>
            </div>
          ))}
        </dl>
      </details>
      {save.error && (
        <p role="alert" className="text-[13px] text-danger">
          {save.error.message}
        </p>
      )}
    </div>
  )
}
