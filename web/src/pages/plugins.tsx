import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  FlaskConical,
  MoreHorizontal,
  Package,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  Settings2,
  TerminalSquare,
  Users,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SchemaForm } from '../components/schema-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/dialog.tsx'
import { Input } from '../components/ui/input.tsx'
import { Menu, MenuItem, Segmented, TabPanel, Tabs, Tooltip } from '../components/ui/misc.tsx'
import { Badge, Card, EmptyState, PageHeader, Skeleton, type Tone } from '../components/ui/primitives.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { ApiError, api } from '../lib/api.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { navigate } from '../lib/router.tsx'
import type { PluginStateName, PluginView } from '../lib/types.ts'
import { playgroundDraft } from '../lib/ui-state.ts'
import { cn } from '../lib/utils.ts'

const stateMeta: Record<PluginStateName, { label: string; tone: Tone }> = {
  active: { label: '运行中', tone: 'success' },
  loading: { label: '加载中', tone: 'warning' },
  failed: { label: '加载失败', tone: 'danger' },
  disabled: { label: '已停用', tone: 'neutral' },
}

type Filter = 'all' | 'active' | 'disabled' | 'failed'

const skeletonKeys = ['a', 'b', 'c', 'd', 'e', 'f']

function usePluginMutations() {
  const client = useQueryClient()
  const update = (plugin: PluginView) =>
    client.setQueryData<PluginView[]>(['plugins'], (list) =>
      list?.map((item) => (item.name === plugin.name ? plugin : item)),
    )
  const action = useMutation({
    mutationFn: ({ name, action }: { name: string; action: 'enable' | 'disable' | 'reload' }) =>
      api.pluginAction(name, action),
    onMutate: ({ name, action }) => {
      // Optimistic toggle so the switch responds instantly; the server response (or a push frame) reconciles it.
      if (action !== 'reload')
        client.setQueryData<PluginView[]>(['plugins'], (list) =>
          list?.map((item) => (item.name === name ? { ...item, enabled: action === 'enable' } : item)),
        )
    },
    onSuccess: (plugin, { action }) => {
      update(plugin)
      void client.invalidateQueries({ queryKey: ['overview'] })
      if (action === 'reload') toast.success(`已重载 ${plugin.name}`)
      else if (plugin.state === 'failed')
        toast.error(`${plugin.name} 启用失败`, { description: plugin.error })
    },
    onError: () => void client.invalidateQueries({ queryKey: ['plugins'] }),
  })
  return { action, update }
}

export function PluginsPage() {
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins })
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const { action } = usePluginMutations()

  const list = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (plugins.data ?? []).filter(
      (plugin) =>
        (filter === 'all' || plugin.state === filter) &&
        (!keyword ||
          plugin.name.toLowerCase().includes(keyword) ||
          plugin.description?.toLowerCase().includes(keyword)),
    )
  }, [plugins.data, filter, query])

  const counts = useMemo(() => {
    const data = plugins.data ?? []
    return {
      all: data.length,
      active: data.filter((plugin) => plugin.state === 'active').length,
      disabled: data.filter((plugin) => plugin.state === 'disabled').length,
      failed: data.filter((plugin) => plugin.state === 'failed').length,
    }
  }, [plugins.data])

  const current = plugins.data?.find((plugin) => plugin.name === selected)

  return (
    <>
      <PageHeader
        title="插件"
        description={
          plugins.data
            ? `共 ${counts.all} 个插件，${counts.active} 个正在运行`
            : '管理插件的启停、配置和群开关'
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            {
              value: 'all',
              label: (
                <>
                  全部 <Count n={counts.all} />
                </>
              ),
            },
            {
              value: 'active',
              label: (
                <>
                  运行中 <Count n={counts.active} />
                </>
              ),
            },
            {
              value: 'disabled',
              label: (
                <>
                  已停用 <Count n={counts.disabled} />
                </>
              ),
            },
            {
              value: 'failed',
              label: (
                <>
                  失败 <Count n={counts.failed} />
                </>
              ),
            },
          ]}
        />
        <Input
          icon={<Search />}
          placeholder="搜索插件"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ml-auto w-56"
        />
      </div>

      {!plugins.data ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {skeletonKeys.map((key) => (
            <Skeleton key={key} className="h-[150px] rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Puzzle />}
            title={query || filter !== 'all' ? '没有符合条件的插件' : '还没有插件'}
            description="把插件文件放进 plugins/ 目录，保存后会自动加载。"
          />
        </Card>
      ) : (
        <motion.div
          key={filter}
          variants={stagger}
          initial="initial"
          animate="animate"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {list.map((plugin) => (
            <PluginCard
              key={plugin.name}
              plugin={plugin}
              onOpen={() => setSelected(plugin.name)}
              onToggle={(enabled) =>
                action.mutate({ name: plugin.name, action: enabled ? 'enable' : 'disable' })
              }
              onReload={() => action.mutate({ name: plugin.name, action: 'reload' })}
            />
          ))}
        </motion.div>
      )}

      <PluginSheet
        plugin={current}
        open={current !== undefined}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </>
  )
}

function Count({ n }: { n: number }) {
  return <span className="ml-0.5 text-fg-3 tabular">{n}</span>
}

function PluginCard({
  plugin,
  onOpen,
  onToggle,
  onReload,
}: {
  plugin: PluginView
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  onReload: () => void
}) {
  const meta = stateMeta[plugin.state]
  const visibleCommands = plugin.commands.filter((command) => !command.hidden).length
  return (
    <motion.div variants={staggerItem} layout whileHover={{ y: -2 }} transition={softSpring}>
      <Card
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('[data-card-control]')) onOpen()
        }}
        onKeyDown={(event) => event.key === 'Enter' && event.target === event.currentTarget && onOpen()}
        className="group flex h-full cursor-pointer flex-col p-4 transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-pop"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-border transition-colors',
              plugin.state === 'active' ? 'bg-accent-soft text-accent-soft-fg' : 'bg-surface-2 text-fg-3',
            )}
          >
            <Package className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold tracking-[-0.01em]">{plugin.name}</span>
              {plugin.version && <span className="font-mono text-[11px] text-fg-3">v{plugin.version}</span>}
            </div>
            <div className="text-[11.5px] text-fg-3">{plugin.source === 'builtin' ? '内置' : '插件目录'}</div>
          </div>
          {/* Clicks inside the controls must not open the drawer (see the card onClick). */}
          <div className="flex items-center gap-1" data-card-control>
            <Menu
              trigger={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="更多操作"
                  className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              }
            >
              <MenuItem icon={<RotateCw />} onSelect={onReload}>
                重载
              </MenuItem>
              <MenuItem icon={<Settings2 />} onSelect={onOpen}>
                详情与配置
              </MenuItem>
            </Menu>
            <Switch aria-label={`启用 ${plugin.name}`} checked={plugin.enabled} onCheckedChange={onToggle} />
          </div>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {plugin.state === 'failed' && plugin.error ? (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={softSpring}
              className="mt-3 flex min-h-[38px] gap-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-[12px] leading-relaxed text-danger"
            >
              <AlertTriangle className="mt-[3px] size-3.5 shrink-0" />
              <span className="line-clamp-2 break-all">{plugin.error}</span>
            </motion.div>
          ) : (
            <motion.p
              key="description"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mt-3 line-clamp-2 min-h-[38px] text-[13px] leading-relaxed text-fg-2"
            >
              {plugin.description || '没有描述'}
            </motion.p>
          )}
        </AnimatePresence>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <Badge tone={meta.tone} dot pulse={plugin.state === 'loading'}>
            {meta.label}
          </Badge>
          <span className="flex items-center gap-1 text-[12px] text-fg-3">
            <TerminalSquare className="size-3.5" />
            {visibleCommands} 条命令
          </span>
        </div>
      </Card>
    </motion.div>
  )
}

type SheetTab = 'overview' | 'config' | 'commands' | 'groups'

function PluginSheet({
  plugin,
  open,
  onOpenChange,
}: {
  plugin: PluginView | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tab, setTab] = useState<SheetTab>('overview')
  const { action } = usePluginMutations()
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setTab('overview')
      }}
      title={
        plugin && (
          <span className="flex items-center gap-2">
            {plugin.name}
            <Badge tone={stateMeta[plugin.state].tone} dot>
              {stateMeta[plugin.state].label}
            </Badge>
          </span>
        )
      }
      subtitle={plugin?.description}
      headerExtra={
        plugin && (
          <>
            <Tooltip content="重载插件">
              <Button
                variant="ghost"
                size="icon"
                aria-label="重载插件"
                loading={action.isPending && action.variables?.action === 'reload'}
                onClick={() => action.mutate({ name: plugin.name, action: 'reload' })}
              >
                <RotateCw className="size-4" />
              </Button>
            </Tooltip>
            <Switch
              aria-label="启用插件"
              checked={plugin.enabled}
              onCheckedChange={(enabled) =>
                action.mutate({ name: plugin.name, action: enabled ? 'enable' : 'disable' })
              }
            />
          </>
        )
      }
    >
      {plugin && (
        <Tabs
          value={tab}
          onChange={setTab}
          className="flex h-full flex-col"
          tabs={[
            { value: 'overview', label: '概览' },
            { value: 'config', label: '配置' },
            { value: 'commands', label: '命令', count: plugin.commands.length },
            { value: 'groups', label: '群开关' },
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
              <TabPanel value="overview" forceMount hidden={tab !== 'overview'}>
                {tab === 'overview' && <OverviewTab plugin={plugin} />}
              </TabPanel>
              <TabPanel value="config" forceMount hidden={tab !== 'config'}>
                {tab === 'config' && <ConfigTab plugin={plugin} />}
              </TabPanel>
              <TabPanel value="commands" forceMount hidden={tab !== 'commands'}>
                {tab === 'commands' && <CommandsTab plugin={plugin} />}
              </TabPanel>
              <TabPanel value="groups" forceMount hidden={tab !== 'groups'}>
                {tab === 'groups' && <GroupsTab plugin={plugin} />}
              </TabPanel>
            </motion.div>
          </AnimatePresence>
        </Tabs>
      )}
    </Sheet>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border py-3 last:border-0">
      <dt className="shrink-0 text-[13px] text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] break-all text-fg">{children}</dd>
    </div>
  )
}

function OverviewTab({ plugin }: { plugin: PluginView }) {
  return (
    <div className="space-y-5">
      {plugin.state === 'failed' && plugin.error && (
        <div className="flex gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">加载失败</div>
            <p className="mt-0.5 leading-relaxed break-all">{plugin.error}</p>
          </div>
        </div>
      )}
      <dl>
        <InfoRow label="状态">{stateMeta[plugin.state].label}</InfoRow>
        <InfoRow label="全局开关">{plugin.enabled ? '已启用' : '已停用'}</InfoRow>
        <InfoRow label="版本">
          {plugin.version ? <span className="font-mono">v{plugin.version}</span> : '—'}
        </InfoRow>
        <InfoRow label="来源">{plugin.source === 'builtin' ? '内置插件' : '插件目录'}</InfoRow>
        {plugin.path && (
          <InfoRow label="文件">
            <span className="font-mono text-[12px] text-fg-2">{plugin.path}</span>
          </InfoRow>
        )}
        <InfoRow label="命令">{plugin.commands.length} 条</InfoRow>
        <InfoRow label="可配置">{plugin.configSchema ? '是' : '否'}</InfoRow>
      </dl>
    </div>
  )
}

/** Server issue paths may be prefixed with plugins.<name>.config; the form keys fields by the path inside config. */
function normalizeIssues(plugin: string, error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  const prefixes = [`plugins.${plugin}.config.`, `plugins.${plugin}.config`, 'config.', 'config']
  return Object.fromEntries(
    error.issues.map((issue) => {
      const prefix = prefixes.find((item) => issue.path.startsWith(item))
      return [prefix ? issue.path.slice(prefix.length) : issue.path, issue.message]
    }),
  )
}

function ConfigTab({ plugin }: { plugin: PluginView }) {
  const { update } = usePluginMutations()
  const save = useMutation({
    mutationFn: (config: unknown) => api.pluginConfig(plugin.name, config),
    meta: { silent: true },
    onSuccess: (next) => {
      update(next)
      toast.success('配置已保存，插件已重载')
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.status === 400)) toast.error(error.message)
    },
  })
  if (!plugin.configSchema)
    return (
      <EmptyState
        icon={<Settings2 />}
        title="没有可配置项"
        description="插件没有声明 config schema。"
        className="py-10"
      />
    )
  return (
    <SchemaForm
      schema={plugin.configSchema}
      value={plugin.config}
      issues={save.error ? normalizeIssues(plugin.name, save.error) : {}}
      saving={save.isPending}
      onSubmit={(value) => save.mutate(value)}
    />
  )
}

function CommandsTab({ plugin }: { plugin: PluginView }) {
  if (plugin.commands.length === 0)
    return <EmptyState icon={<TerminalSquare />} title="这个插件没有注册命令" className="py-10" />
  return (
    <ul className="space-y-2">
      {plugin.commands.map((command) => (
        <li key={command.path} className="group rounded-xl border border-border px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <code className="font-mono text-[13px] font-medium text-fg">{command.usage}</code>
              {command.description && <p className="mt-1 text-[12.5px] text-fg-3">{command.description}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {command.aliases.map((alias) => (
                  <Badge key={alias}>别名 {alias}</Badge>
                ))}
                {command.permission && <Badge tone="warning">需要权限</Badge>}
                {command.scope !== 'all' && (
                  <Badge tone="info">{command.scope === 'group' ? '仅群聊' : '仅私聊'}</Badge>
                )}
                {command.hidden && <Badge>隐藏</Badge>}
              </div>
            </div>
            <Button
              variant="soft"
              size="sm"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => {
                playgroundDraft.set(`/${command.path} `)
                navigate('/playground')
              }}
            >
              <FlaskConical className="size-3.5" />
              试用
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function GroupsTab({ plugin }: { plugin: PluginView }) {
  const client = useQueryClient()
  const groups = useQuery({
    queryKey: ['pluginGroups', plugin.name],
    queryFn: () => api.pluginGroups(plugin.name),
  })
  const [groupId, setGroupId] = useState('')
  const [platform] = useState('onebot11')
  const set = useMutation({
    mutationFn: ({ groupKey, enabled }: { groupKey: string; enabled: boolean }) =>
      api.setPluginGroup(plugin.name, groupKey, enabled),
    onMutate: ({ groupKey, enabled }) => {
      client.setQueryData<{ groupKey: string; enabled: boolean }[]>(
        ['pluginGroups', plugin.name],
        (list = []) =>
          list.some((item) => item.groupKey === groupKey)
            ? list.map((item) => (item.groupKey === groupKey ? { groupKey, enabled } : item))
            : [...list, { groupKey, enabled }],
      )
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ['pluginGroups', plugin.name] }),
  })

  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-fg-3">
        默认在所有群生效。在这里关闭后，插件在该群的命令、监听器和中间件都会被跳过；私聊不受影响。
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const id = groupId.trim()
          if (!/^\d+$/.test(id)) return toast.error('请输入数字群号')
          set.mutate({ groupKey: `${platform}:${id}`, enabled: false })
          setGroupId('')
        }}
      >
        <Input
          icon={<Users />}
          placeholder="群号，例如 1021765523"
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
          className="flex-1"
        />
        <Button type="submit" variant="secondary">
          <Plus className="size-4" />
          在该群关闭
        </Button>
      </form>
      {groups.isPending ? (
        <Skeleton className="h-24" />
      ) : (groups.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="没有单独设置的群"
          description="当前在所有群都生效。"
          className="py-8"
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          <AnimatePresence initial={false}>
            {groups.data?.map((item) => (
              <motion.li
                key={item.groupKey}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={softSpring}
                className="flex items-center justify-between px-4 py-3"
              >
                <div>
                  <div className="font-mono text-[13px] text-fg">
                    {item.groupKey.split(':').slice(1).join(':')}
                  </div>
                  <div className="text-[11.5px] text-fg-3">{item.groupKey.split(':')[0]}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn('text-[12.5px]', item.enabled ? 'text-success' : 'text-fg-3')}>
                    {item.enabled ? '已开启' : '已关闭'}
                  </span>
                  <Switch
                    aria-label={`${item.groupKey} 开关`}
                    checked={item.enabled}
                    onCheckedChange={(enabled) => set.mutate({ groupKey: item.groupKey, enabled })}
                  />
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  )
}
