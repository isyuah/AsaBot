import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  Users,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ScopedConfig } from '../components/scoped-config.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/dialog.tsx'
import { Input } from '../components/ui/input.tsx'
import { TabPanel, Tabs } from '../components/ui/misc.tsx'
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { Select } from '../components/ui/select.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { api } from '../lib/api.ts'
import { groupPath } from '../lib/groups.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { isValidId, platformName } from '../lib/platform.ts'
import { navigate, usePath } from '../lib/router.tsx'
import type { AccessEntry, GroupDetail, GroupView } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

/** `/groups/<encoded key>` opens that group's sheet, so other pages can deep-link to it. */
function selectedKey(path: string): string | null {
  const match = /^\/groups\/(.+)$/.exec(path)
  return match ? decodeURIComponent(match[1] as string) : null
}

export function GroupsPage() {
  const client = useQueryClient()
  const path = usePath()
  const selected = selectedKey(path)
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.groups() })
  const refresh = useMutation({
    mutationFn: () => api.groups(true),
    onSuccess: (data) => client.setQueryData(['groups'], data),
  })
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState('')
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots })
  const [selectedBot, setSelectedBot] = useState('')
  const effectiveBot =
    bots.data?.find((bot) => `${bot.platform}:${bot.selfId}` === selectedBot) ?? bots.data?.[0]

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (groups.data ?? [])
      .filter(
        (group) =>
          !keyword ||
          group.groupId.toLowerCase().includes(keyword) ||
          group.name?.toLowerCase().includes(keyword),
      )
      .sort((a, b) => ruleCount(b) - ruleCount(a) || (a.name ?? a.groupId).localeCompare(b.name ?? b.groupId))
  }, [groups.data, query])

  return (
    <>
      <PageHeader
        title="群组"
        description="按群设置插件开关、配置覆盖、命令开关和访问控制。列表来自在线机器人的群，以及设置过规则的群"
        actions={
          <Button variant="secondary" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className="size-3.5" />
            刷新群列表
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          icon={<Search />}
          placeholder="搜索群名或群 ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-72"
        />
        <form
          className="ml-auto flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const id = adding.trim()
            if (!isValidId(id)) return toast.error('请输入群 ID')
            if (!effectiveBot) return toast.error('请先添加机器人')
            setAdding('')
            navigate(groupPath(`${effectiveBot.platform}:${effectiveBot.selfId}:group:${id}`))
          }}
        >
          <Select
            aria-label="机器人"
            value={effectiveBot ? `${effectiveBot.platform}:${effectiveBot.selfId}` : ''}
            onValueChange={setSelectedBot}
            options={(bots.data ?? []).map((bot) => ({
              value: `${bot.platform}:${bot.selfId}`,
              label: `${bot.nickname || bot.selfId} · ${bot.platform}`,
            }))}
          />
          <Input
            icon={<Users />}
            placeholder="按群 ID 打开"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            className="w-44"
          />
          <Button type="submit" variant="secondary" size="icon" aria-label="打开">
            <Plus className="size-4" />
          </Button>
        </form>
      </div>
      {groups.error && !groups.data ? (
        <Card>
          <ErrorState
            error={groups.error}
            onRetry={() => void groups.refetch()}
            retrying={groups.isFetching}
          />
        </Card>
      ) : !groups.data ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title={query ? '没有匹配的群' : '还没有群'}
            description={query ? undefined : '机器人上线后会列出它所在的群；也可以在右上角按群 ID 直接打开。'}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <motion.ul
            variants={stagger}
            initial="initial"
            animate="animate"
            className="divide-y divide-border"
          >
            {filtered.map((group) => (
              <motion.li key={group.groupKey} variants={staggerItem}>
                <GroupRow group={group} />
              </motion.li>
            ))}
          </motion.ul>
        </Card>
      )}
      <GroupSheet groupKey={selected} known={groups.data} onClose={() => navigate('/groups')} />
    </>
  )
}

function ruleCount(group: GroupView): number {
  return group.rules.plugins + group.rules.configs + group.rules.commands + (group.access ? 1 : 0)
}

function GroupRow({ group }: { group: GroupView }) {
  const title = group.name ?? group.groupId
  return (
    <button
      type="button"
      onClick={() => navigate(groupPath(group.groupKey))}
      className="group flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2/60"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-[13px] font-medium text-fg-2">
        {title.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium">{title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-3">
          <span className="font-mono">{group.groupId}</span>
          <span>{platformName(group.platform)}</span>
          {group.bots.length > 0 ? <span>机器人 {group.selfId}</span> : <span>机器人不在群内</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {group.access === 'block' && <Badge tone="danger">已屏蔽</Badge>}
        {group.access === 'allow' && <Badge tone="success">白名单</Badge>}
        {group.rules.plugins > 0 && <Badge>{group.rules.plugins} 个插件开关</Badge>}
        {group.rules.configs > 0 && <Badge tone="accent">{group.rules.configs} 个配置覆盖</Badge>}
        {group.rules.commands > 0 && <Badge>{group.rules.commands} 条命令停用</Badge>}
        <ChevronRight className="size-4 text-fg-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  )
}

type GroupTab = 'plugins' | 'commands' | 'access'

function GroupSheet({
  groupKey,
  known,
  onClose,
}: {
  groupKey: string | null
  known: GroupView[] | undefined
  onClose: () => void
}) {
  const [tab, setTab] = useState<GroupTab>('plugins')
  const detail = useQuery({
    queryKey: ['group', groupKey],
    queryFn: () => api.group(groupKey as string),
    enabled: groupKey !== null,
  })
  const group = detail.data?.group ?? known?.find((item) => item.groupKey === groupKey)
  return (
    <Sheet
      open={groupKey !== null}
      onOpenChange={(open) => !open && onClose()}
      title={group?.name ?? group?.groupId ?? groupKey ?? ''}
      subtitle={
        group ? (
          <span className="flex items-center gap-2">
            <span className="font-mono">{group.groupId}</span>
            <span>{platformName(group.platform)}</span>
          </span>
        ) : undefined
      }
    >
      {groupKey !== null &&
        (detail.error && !detail.data ? (
          <ErrorState
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
            className="py-16"
          />
        ) : !detail.data ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-10" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <Tabs
            value={tab}
            onChange={setTab}
            className="flex h-full flex-col"
            tabs={[
              { value: 'plugins', label: '插件', count: detail.data.plugins.length },
              { value: 'commands', label: '命令', count: detail.data.commands.length },
              { value: 'access', label: '访问控制' },
            ]}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.16 }}
                className="px-6 py-5"
              >
                <TabPanel value="plugins" forceMount hidden={tab !== 'plugins'}>
                  {tab === 'plugins' && <PluginsTab detail={detail.data} groupKey={groupKey} />}
                </TabPanel>
                <TabPanel value="commands" forceMount hidden={tab !== 'commands'}>
                  {tab === 'commands' && <CommandsTab detail={detail.data} groupKey={groupKey} />}
                </TabPanel>
                <TabPanel value="access" forceMount hidden={tab !== 'access'}>
                  {tab === 'access' && <AccessTab group={detail.data.group} />}
                </TabPanel>
              </motion.div>
            </AnimatePresence>
          </Tabs>
        ))}
    </Sheet>
  )
}

function useGroupInvalidation(groupKey: string) {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: ['group', groupKey] })
    void client.invalidateQueries({ queryKey: ['groups'] })
    void client.invalidateQueries({ queryKey: ['pluginGroups'] })
    void client.invalidateQueries({ queryKey: ['commands'] })
  }
}

function PluginsTab({ detail, groupKey }: { detail: GroupDetail; groupKey: string }) {
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins })
  const [open, setOpen] = useState<string | null>(null)
  const invalidate = useGroupInvalidation(groupKey)
  const client = useQueryClient()
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.setPluginGroup(name, groupKey, { enabled }),
    onMutate: ({ name, enabled }) => {
      client.setQueryData<GroupDetail>(['group', groupKey], (current) =>
        current
          ? {
              ...current,
              plugins: current.plugins.map((item) => (item.name === name ? { ...item, enabled } : item)),
            }
          : current,
      )
    },
    onSettled: invalidate,
  })
  if (detail.plugins.length === 0)
    return <EmptyState icon={<Settings2 />} title="没有已加载的插件" className="py-10" />
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-fg-3">
        插件开关与配置仅应用于这台机器人的当前群。配置按全局、机器人、群组逐层继承，保存覆盖后立即生效。
      </p>
      <ul className="space-y-2">
        {detail.plugins.map((item) => {
          const plugin = plugins.data?.find((candidate) => candidate.name === item.name)
          const expanded = open === item.name
          return (
            <li key={item.name} className="overflow-hidden rounded-xl border border-border">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium">{item.name}</span>
                    {item.override && <Badge tone="accent">配置已覆盖</Badge>}
                  </div>
                  {plugin?.description && (
                    <div className="mt-0.5 truncate text-[12px] text-fg-3">{plugin.description}</div>
                  )}
                </div>
                {item.configurable && (
                  <Button variant="ghost" size="sm" onClick={() => setOpen(expanded ? null : item.name)}>
                    <Settings2 className="size-3.5" />
                    配置
                    <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={softSpring}>
                      <ChevronRight className="size-3.5" />
                    </motion.span>
                  </Button>
                )}
                <Switch
                  aria-label={`在这个群启用 ${item.name}`}
                  checked={item.enabled}
                  onCheckedChange={(enabled) => toggle.mutate({ name: item.name, enabled })}
                />
              </div>
              <AnimatePresence initial={false}>
                {expanded && plugin && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={softSpring}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-border bg-surface-2/40 px-4 py-4">
                      <ScopedConfig
                        plugin={plugin}
                        inherited={item.inheritedConfig}
                        effective={item.effectiveConfig}
                        override={item.override}
                        sources={item.configSources ?? {}}
                        save={(config) => api.setPluginGroup(plugin.name, groupKey, { config })}
                        onSaved={invalidate}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CommandsTab({ detail, groupKey }: { detail: GroupDetail; groupKey: string }) {
  const invalidate = useGroupInvalidation(groupKey)
  const client = useQueryClient()
  const [query, setQuery] = useState('')
  const toggle = useMutation({
    mutationFn: ({ path, enabled }: { path: string; enabled: boolean }) =>
      api.setCommandGroup(path, groupKey, enabled),
    onMutate: ({ path, enabled }) => {
      client.setQueryData<GroupDetail>(['group', groupKey], (current) =>
        current
          ? {
              ...current,
              commands: current.commands.map((item) => (item.path === path ? { ...item, enabled } : item)),
            }
          : current,
      )
    },
    onSettled: invalidate,
  })
  const keyword = query.trim().toLowerCase()
  const list = detail.commands.filter((item) => !keyword || item.path.toLowerCase().includes(keyword))
  if (detail.commands.length === 0)
    return <EmptyState icon={<TerminalSquare />} title="没有已注册的命令" className="py-10" />
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-fg-3">在这个群停用的命令等于不存在，消息会交给其他处理器。</p>
        <Input
          icon={<Search />}
          placeholder="搜索命令"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-44"
        />
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {list.map((item) => (
          <li
            key={item.path}
            className={cn(
              'flex items-center gap-3 px-4 py-2.5 transition-opacity',
              !item.enabled && 'opacity-60',
            )}
          >
            <code className={cn('font-mono text-[13px]', !item.enabled && 'line-through')}>/{item.path}</code>
            <span className="text-[12px] text-fg-3">{item.owner}</span>
            <Switch
              aria-label={`在这个群启用 /${item.path}`}
              checked={item.enabled}
              onCheckedChange={(enabled) => toggle.mutate({ path: item.path, enabled })}
              className="ml-auto"
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function AccessTab({ group }: { group: GroupView }) {
  const client = useQueryClient()
  const invalidate = useGroupInvalidation(group.groupKey)
  const entry = (list: 'block' | 'allow'): AccessEntry => ({
    list,
    subject: 'group',
    key: `${group.platform}:${group.groupId}`,
  })
  const run = useMutation({
    mutationFn: async ({ add, remove }: { add?: AccessEntry; remove?: AccessEntry }) => {
      if (remove) await api.removeAcl(remove)
      if (add) await api.addAcl(add)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['acl'] })
      invalidate()
    },
  })
  const current = group.access
  const options: { list: 'block' | 'allow'; title: string; description: string; icon: ReactNode }[] = [
    {
      list: 'block',
      title: '屏蔽这个群',
      description: '这个群发来的所有事件都会被忽略（超管除外）。',
      icon: <Ban className="size-4" />,
    },
    {
      list: 'allow',
      title: '加入白名单',
      description: '群白名单非空时，只有名单中的群能使用机器人；私聊不受影响。',
      icon: <CheckCircle2 className="size-4" />,
    },
  ]
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-3">
        访问控制按平台和群共享，会同时影响其他机器人收到的这个群的事件。
      </p>
      {options.map((option) => {
        const active = current === option.list
        return (
          <div
            key={option.list}
            className={cn(
              'flex items-center gap-4 rounded-xl border px-4 py-3.5 transition-colors',
              active
                ? option.list === 'block'
                  ? 'border-danger/40 bg-danger-soft/40'
                  : 'border-success/40 bg-success-soft/40'
                : 'border-border',
            )}
          >
            <span className={cn(option.list === 'block' ? 'text-danger' : 'text-success')}>
              {option.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{option.title}</div>
              <p className="mt-0.5 text-[12px] text-fg-3">{option.description}</p>
            </div>
            <Button
              variant={active ? 'ghost' : 'secondary'}
              size="sm"
              loading={run.isPending && run.variables?.add?.list === option.list}
              onClick={() =>
                run.mutate(
                  active
                    ? { remove: entry(option.list) }
                    : { add: entry(option.list), ...(current ? { remove: entry(current) } : {}) },
                )
              }
            >
              {active ? '取消' : option.list === 'block' ? '屏蔽' : '加入'}
            </Button>
          </div>
        )
      })}
      <p className="flex items-center gap-1.5 pt-1 text-[12px] text-fg-3">
        <ShieldCheck className="size-3.5" />
        完整的名单在“访问控制”页面管理。
      </p>
    </div>
  )
}
