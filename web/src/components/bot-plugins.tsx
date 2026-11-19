import { Badge, Button, Card, CompatibilityInfo, Switch } from '@asabot/panel-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api.ts'
import { invalidatePolicies, pluginPath } from '../lib/management.ts'
import { Link } from '../lib/router.tsx'
import type { BotPluginView, BotView } from '../lib/types.ts'
import { ScopedConfig } from './scoped-config.tsx'

export function BotPlugins({
  bot,
  plugins,
  initialOpen,
}: {
  bot: BotView
  plugins: BotPluginView[]
  initialOpen?: string
}) {
  const [open, setOpen] = useState<string | null>(initialOpen ?? null)
  return (
    <div className="space-y-3">
      {plugins.map((plugin) => (
        <BotPlugin
          key={plugin.name}
          bot={bot}
          plugin={plugin}
          open={open === plugin.name}
          onOpen={() => setOpen(open === plugin.name ? null : plugin.name)}
        />
      ))}
    </div>
  )
}

function BotPlugin({
  bot,
  plugin,
  open,
  onOpen,
}: {
  bot: BotView
  plugin: BotPluginView
  open: boolean
  onOpen: () => void
}) {
  const client = useQueryClient()
  const toggle = useMutation({
    mutationFn: (enabled: boolean | null) => api.botPlugin(bot, plugin.name, { enabled }),
    onSuccess: () => invalidatePolicies(client),
  })
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={pluginPath(plugin.name)} className="text-[14px] font-semibold hover:text-accent">
              {plugin.name}
            </Link>
            <Badge tone={plugin.state === 'active' && plugin.botEnabled ? 'success' : 'neutral'}>
              {plugin.state === 'active' && plugin.botEnabled
                ? '生效中'
                : plugin.state === 'disabled'
                  ? '全局已停用'
                  : plugin.state === 'failed'
                    ? '全局加载失败'
                    : plugin.state === 'loading'
                      ? '全局加载中'
                      : '本机器人停用'}
            </Badge>
          </div>
          {plugin.description && <p className="mt-1 text-[12.5px] text-fg-3">{plugin.description}</p>}
          <div className="mt-2">
            <CompatibilityInfo value={plugin.compatibility} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {plugin.configSchema && (
            <Button variant="ghost" size="sm" aria-expanded={open} onClick={onOpen}>
              <Settings2 className="size-3.5" />
              配置
              <ChevronDown className="size-3.5" />
            </Button>
          )}
          <Switch
            aria-label={`在 ${bot.nickname ?? bot.selfId} 上启用 ${plugin.name}`}
            checked={plugin.overrideEnabled ?? plugin.botDefaultEnabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
          />
        </div>
      </div>
      {plugin.overrideEnabled !== undefined && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[12px] text-fg-3">
          <span>机器人开关已单独设置</span>
          <Button variant="ghost" size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(null)}>
            恢复初始设置
          </Button>
        </div>
      )}
      {open && (
        <div className="border-t border-border p-5">
          <ScopedConfig
            plugin={plugin}
            inherited={plugin.config}
            effective={plugin.effectiveConfig}
            override={plugin.override}
            sources={plugin.configSources}
            save={(config) => api.botPlugin(bot, plugin.name, { config })}
            onSaved={() => invalidatePolicies(client)}
          />
        </div>
      )}
    </Card>
  )
}
