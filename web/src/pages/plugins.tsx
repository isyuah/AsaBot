import {
  Badge,
  Button,
  Card,
  CompatibilityInfo,
  cn,
  EmptyState,
  ErrorState,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  PageHeader,
  PageTabs,
  SchemaForm,
  Segmented,
  Select,
  Skeleton,
  Switch,
  softSpring,
  stagger,
  staggerItem,
  type Tone,
  Tooltip,
} from '@asabot/panel-ui'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpCircle,
  Bot as BotIcon,
  FileUp,
  FlaskConical,
  MoreHorizontal,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Store,
  TerminalSquare,
  Trash2,
  Users,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PackageMarket } from '../components/market.tsx'
import { hasUpdate, UninstallDialog, UpdateButton, UploadDialog } from '../components/plugin-manage.tsx'
import { ApiError, api } from '../lib/api.ts'
import { groupPath } from '../lib/groups.ts'
import { botPath, invalidatePolicies, pluginPath } from '../lib/management.ts'
import { isValidId } from '../lib/platform.ts'
import { Link, navigate, usePath } from '../lib/router.tsx'
import type { BotView, PluginGroupSetting, PluginStateName, PluginView } from '../lib/types.ts'
import { playgroundDraft } from '../lib/ui-state.ts'

const stateMeta: Record<PluginStateName, { label: string; tone: Tone }> = {
  active: { label: '运行中', tone: 'success' },
  loading: { label: '加载中', tone: 'warning' },
  failed: { label: '加载失败', tone: 'danger' },
  disabled: { label: '已停用', tone: 'neutral' },
}

type Filter = 'all' | 'active' | 'disabled' | 'failed'

function sourceLabel(plugin: PluginView): string {
  if (plugin.source === 'builtin') return '内置'
  if (plugin.source === 'package') return `npm · ${plugin.package?.name ?? plugin.name}`
  return '本地文件'
}

const skeletonKeys = ['a', 'b', 'c', 'd', 'e', 'f']

function cachePlugin(client: QueryClient, plugin: PluginView) {
  client.setQueryData<PluginView[]>(['plugins'], (list) =>
    list?.map((item) => (item.name === plugin.name ? plugin : item)),
  )
}

function usePluginMutations() {
  const client = useQueryClient()
  const update = (plugin: PluginView) => cachePlugin(client, plugin)
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
  const [view, setView] = useState<'installed' | 'market'>('installed')
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState<PluginView | null>(null)
  const { action } = usePluginMutations()
  const client = useQueryClient()
  const rescan = useMutation({
    mutationFn: api.rescanPlugins,
    onSuccess: ({ added, removed, plugins: next }) => {
      client.setQueryData(['plugins'], next)
      void client.invalidateQueries({ queryKey: ['commands'] })
      toast.success(
        added.length === 0 && removed.length === 0
          ? '没有发现变化'
          : [
              added.length > 0 && `新增 ${added.join('、')}`,
              removed.length > 0 && `移除 ${removed.join('、')}`,
            ]
              .filter(Boolean)
              .join('；'),
      )
    },
  })

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
    const data = plugins.data
    if (!data) return undefined
    return {
      all: data.length,
      active: data.filter((plugin) => plugin.state === 'active').length,
      disabled: data.filter((plugin) => plugin.state === 'disabled').length,
      failed: data.filter((plugin) => plugin.state === 'failed').length,
    }
  }, [plugins.data])

  return (
    <>
      <PageHeader
        title="插件"
        description={
          counts ? `共 ${counts.all} 个插件，${counts.active} 个正在运行` : '管理插件的启停、配置和群开关'
        }
        actions={
          <>
            <Tooltip content="发现插件目录中新增或删除的插件">
              <Button loading={false} onClick={() => rescan.mutate()} disabled={rescan.isPending}>
                <motion.span
                  animate={rescan.isPending ? { rotate: 360 } : { rotate: 0 }}
                  transition={
                    rescan.isPending
                      ? { duration: 0.9, repeat: Number.POSITIVE_INFINITY, ease: 'linear' }
                      : softSpring
                  }
                  className="inline-flex"
                >
                  <RefreshCw className="size-3.5" />
                </motion.span>
                重新扫描
              </Button>
            </Tooltip>
            <Button variant="primary" onClick={() => setUploading(true)}>
              <FileUp className="size-3.5" />
              上传插件
            </Button>
          </>
        }
      />
      <PageTabs
        className="mb-5"
        value={view}
        onChange={setView}
        tabs={[
          {
            value: 'installed',
            label: (
              <>
                已安装 <Count n={counts?.all} />
              </>
            ),
          },
          {
            value: 'market',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Store className="size-3.5" />
                插件市场
              </span>
            ),
          },
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        {view === 'market' ? (
          <motion.div
            key="market"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={softSpring}
          >
            <PackageMarket />
          </motion.div>
        ) : (
          <motion.div
            key="installed"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={softSpring}
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  {
                    value: 'all',
                    label: (
                      <>
                        全部 <Count n={counts?.all} />
                      </>
                    ),
                  },
                  {
                    value: 'active',
                    label: (
                      <>
                        运行中 <Count n={counts?.active} />
                      </>
                    ),
                  },
                  {
                    value: 'disabled',
                    label: (
                      <>
                        已停用 <Count n={counts?.disabled} />
                      </>
                    ),
                  },
                  {
                    value: 'failed',
                    label: (
                      <>
                        失败 <Count n={counts?.failed} />
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

            {plugins.error && !plugins.data ? (
              <Card>
                <ErrorState
                  error={plugins.error}
                  onRetry={() => void plugins.refetch()}
                  retrying={plugins.isFetching}
                />
              </Card>
            ) : !plugins.data ? (
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
                  description="上传插件、从插件市场安装，或把插件文件放进插件目录后点“重新扫描”。"
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
                    onOpen={() => navigate(pluginPath(plugin.name))}
                    onToggle={(enabled) =>
                      action.mutate({ name: plugin.name, action: enabled ? 'enable' : 'disable' })
                    }
                    onReload={() => action.mutate({ name: plugin.name, action: 'reload' })}
                    onUninstall={() => setRemoving(plugin)}
                  />
                ))}
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <UploadDialog open={uploading} onOpenChange={setUploading} />
      <UninstallDialog
        plugin={removing}
        onClose={() => {
          setRemoving(null)
        }}
      />
    </>
  )
}

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null
  return <span className="ml-0.5 text-fg-3 tabular">{n}</span>
}

function PluginCard({
  plugin,
  onOpen,
  onToggle,
  onReload,
  onUninstall,
}: {
  plugin: PluginView
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  onReload: () => void
  onUninstall: () => void
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
            <div className="truncate text-[11.5px] text-fg-3">{sourceLabel(plugin)}</div>
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
              {plugin.removable && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 />} danger onSelect={onUninstall}>
                    卸载
                  </MenuItem>
                </>
              )}
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
          {hasUpdate(plugin) && (
            <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-info">
              <ArrowUpCircle className="size-3.5" />v{plugin.package?.latest}
            </span>
          )}
        </div>
      </Card>
    </motion.div>
  )
}

export function PluginDetailPage() {
  const parts = usePath().split('/').filter(Boolean).map(decodeURIComponent)
  const name = parts[1] ?? ''
  const tab = parts[2] ?? 'overview'
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins })
  const [removing, setRemoving] = useState<PluginView | null>(null)
  const { action } = usePluginMutations()
  if (plugins.error) return <ErrorState error={plugins.error} onRetry={() => void plugins.refetch()} />
  if (!plugins.data) return <Skeleton className="h-64 rounded-xl" />
  const plugin = plugins.data.find((item) => item.name === name)
  if (!plugin)
    return (
      <EmptyState
        icon={<Puzzle />}
        title="插件不存在或已卸载"
        action={<Button onClick={() => navigate('/plugins')}>返回插件列表</Button>}
      />
    )
  return (
    <>
      <Link
        to="/plugins"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg"
      >
        <ArrowLeft className="size-3.5" />
        插件列表
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {plugin.name}
            <Badge tone={stateMeta[plugin.state].tone} dot>
              {stateMeta[plugin.state].label}
            </Badge>
          </span>
        }
        description={plugin.description}
        actions={
          <>
            <Button loading={action.isPending} onClick={() => action.mutate({ name, action: 'reload' })}>
              <RotateCw className="size-3.5" />
              重载
            </Button>
            <Switch
              aria-label="全局启用插件"
              checked={plugin.enabled}
              disabled={name === 'admin' || action.isPending}
              onCheckedChange={(enabled) => action.mutate({ name, action: enabled ? 'enable' : 'disable' })}
            />
          </>
        }
      />
      <div className="mb-5 flex flex-wrap gap-4 text-[13px]">
        <Link to={`/logs?plugin=${encodeURIComponent(name)}`} className="text-accent">
          查看日志
        </Link>
        <Link to={`/tasks?plugin=${encodeURIComponent(name)}`} className="text-accent">
          查看任务
        </Link>
      </div>
      <PageTabs
        value={tab}
        onChange={(value) => navigate(pluginPath(name, value))}
        tabs={[
          { value: 'overview', label: '概览' },
          { value: 'config', label: '全局配置' },
          { value: 'commands', label: '命令' },
          { value: 'bots', label: '机器人' },
          { value: 'groups', label: '群组' },
        ]}
        className="mb-5 overflow-x-auto"
      />
      <Card className="p-5 sm:p-6">
        {tab === 'overview' && (
          <>
            <OverviewTab plugin={plugin} onUninstall={() => setRemoving(plugin)} />
            <CapabilityRequirements plugin={plugin} />
          </>
        )}
        {tab === 'config' && (
          <>
            <p className="mb-4 text-[13px] text-fg-3">
              这里的配置是默认值，机器人与群组可分别覆盖。
              <Link to={pluginPath(name, 'bots')} className="ml-1 text-accent">
                查看机器人覆盖
              </Link>
            </p>
            <ConfigTab plugin={plugin} />
          </>
        )}
        {tab === 'commands' && <CommandsTab plugin={plugin} />}
        {tab === 'bots' && <PluginBots plugin={plugin} />}
        {tab === 'groups' && <GroupsTab plugin={plugin} />}
      </Card>
      <UninstallDialog plugin={removing} onClose={() => setRemoving(null)} />
    </>
  )
}

function CapabilityRequirements({ plugin }: { plugin: PluginView }) {
  return (
    <section className="mt-6 border-t border-border pt-5">
      <h2 className="text-sm font-semibold">机器人能力要求</h2>
      {!plugin.capabilities ? (
        <p className="mt-2 text-[13px] text-fg-3">插件未声明能力要求。</p>
      ) : (
        <>
          <p className="mt-2 text-[12.5px] text-fg-3">
            能力缺失会提示，不影响启用。各机器人的匹配情况可在“机器人”中查看。
          </p>
          {(['required', 'optional'] as const).map((kind) => (
            <div className="mt-4" key={kind}>
              <h3 className="mb-2 text-[12px] text-fg-3">{kind === 'required' ? '必须能力' : '可选能力'}</h3>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(plugin.capabilities?.[kind] ?? {}).flatMap(([category, names]) =>
                  names.map((name) => (
                    <Badge key={`${category}:${name}`}>
                      <span className="text-fg-3">{category}</span>
                      {name}
                    </Badge>
                  )),
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

function PluginBots({ plugin }: { plugin: PluginView }) {
  const client = useQueryClient()
  const saveDefault = useMutation({
    mutationFn: (enabled: boolean) => api.pluginBotDefault(plugin.name, enabled),
    onSuccess: (next) => cachePlugin(client, next),
  })
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <div>
          <h2 className="text-sm font-semibold">
            <label htmlFor="new-bot-plugin-default" className="cursor-pointer">
              新机器人默认启用
            </label>
          </h2>
          <p className="mt-1 text-[13px] text-fg-3">仅影响之后首次接入的机器人。</p>
        </div>
        <Switch
          id="new-bot-plugin-default"
          className="ml-auto"
          checked={saveDefault.isPending ? saveDefault.variables : plugin.defaultOnNewBots}
          disabled={saveDefault.isPending}
          onCheckedChange={(enabled) => saveDefault.mutate(enabled)}
        />
      </div>
      {!plugin.enabled && <p className="text-[13px] text-fg-3">重新全局启用后，会按各机器人的开关生效。</p>}
      <BotApplications plugin={plugin} />
    </div>
  )
}

function BotApplications({ plugin }: { plugin: PluginView }) {
  const client = useQueryClient()
  const applications = useQuery({
    queryKey: ['pluginBots', plugin.name],
    queryFn: () => api.pluginBots(plugin.name),
  })
  const toggle = useMutation({
    mutationFn: ({ bot, enabled }: { bot: BotView; enabled: boolean }) =>
      api.botPlugin(bot, plugin.name, { enabled }),
    onSuccess: () => invalidatePolicies(client),
  })
  if (applications.error)
    return <ErrorState error={applications.error} onRetry={() => void applications.refetch()} />
  if (!applications.data) return <Skeleton className="h-32" />
  if (!applications.data.length)
    return (
      <EmptyState
        icon={<BotIcon />}
        title="还没有机器人"
        action={<Button onClick={() => navigate('/bots/connections/new')}>添加连接</Button>}
      />
    )
  return (
    <ul className="divide-y divide-border">
      {applications.data.map(({ bot, application }) => (
        <li key={`${bot.platform}:${bot.selfId}`} className="py-4 first:pt-0 last:pb-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <Link to={botPath(bot)} className="text-sm font-medium hover:text-accent">
                {bot.nickname || bot.selfId}
              </Link>
              <p className="mt-1 break-all font-mono text-[11.5px] text-fg-3">
                {bot.platform} · {bot.selfId}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link
                to={botPath(bot, `plugins/${encodeURIComponent(plugin.name)}`)}
                className="text-[12.5px] text-accent"
              >
                配置与继承
              </Link>
              <Switch
                aria-label={`在 ${bot.nickname ?? bot.selfId} 上启用`}
                checked={application.overrideEnabled ?? application.botDefaultEnabled}
                disabled={toggle.isPending}
                onCheckedChange={(enabled) => toggle.mutate({ bot, enabled })}
              />
            </div>
          </div>
          <CompatibilityInfo value={application.compatibility} />
          {application.override && (
            <p className="mt-2 text-[12px] text-fg-3">
              配置已覆盖：{Object.keys(application.override).join('、')}
            </p>
          )}
        </li>
      ))}
    </ul>
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

function OverviewTab({ plugin, onUninstall }: { plugin: PluginView; onUninstall: () => void }) {
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
        <InfoRow label="来源">
          {plugin.source === 'builtin' ? '内置插件' : plugin.source === 'package' ? 'npm 插件包' : '本地文件'}
        </InfoRow>
        {plugin.package && (
          <>
            <InfoRow label="包名">
              <span className="font-mono">{plugin.package.name}</span>
            </InfoRow>
            <InfoRow label="已安装版本">
              <span className="font-mono">v{plugin.package.version}</span>
              {plugin.package.latest && plugin.package.latest !== plugin.package.version && (
                <span className="ml-2 text-info">最新 v{plugin.package.latest}</span>
              )}
            </InfoRow>
            {plugin.package.peerRange && (
              <InfoRow label="要求框架版本">
                <span className={cn('font-mono', !plugin.package.compatible && 'text-danger')}>
                  {plugin.package.peerRange}
                </span>
                {!plugin.package.compatible && <span className="ml-2 text-danger">与当前版本不兼容</span>}
              </InfoRow>
            )}
          </>
        )}
        {plugin.path && (
          <InfoRow label="文件">
            <span className="font-mono text-[12px] text-fg-2">{plugin.path}</span>
          </InfoRow>
        )}
        <InfoRow label="命令">{plugin.commands.length} 条</InfoRow>
        <InfoRow label="可配置">{plugin.configSchema ? '是' : '否'}</InfoRow>
        {plugin.depends && plugin.depends.length > 0 && (
          <InfoRow label="依赖插件">
            <span className="inline-flex flex-wrap justify-end gap-2">
              {plugin.depends.map((name) => (
                <Link key={name} to={pluginPath(name)} className="text-accent">
                  {name}
                </Link>
              ))}
            </span>
          </InfoRow>
        )}
        {plugin.provides.length > 0 && (
          <InfoRow label="提供服务">
            <ServiceList services={plugin.provides.map((name) => ({ name, optional: false }))} />
          </InfoRow>
        )}
        {plugin.inject.length > 0 && (
          <InfoRow label="依赖服务">
            <ServiceList services={plugin.inject} />
          </InfoRow>
        )}
      </dl>
      {hasUpdate(plugin) && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-info-soft px-4 py-3">
          <span className="text-[13px] text-info">有新版本 v{plugin.package?.latest} 可用</span>
          <UpdateButton plugin={plugin} />
        </div>
      )}
      {plugin.removable && (
        <div className="rounded-xl border border-danger/25 px-4 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-medium text-fg">卸载插件</div>
              <p className="mt-0.5 text-[12px] text-fg-3">
                {plugin.source === 'package' ? '通过 npm 卸载这个插件包。' : '删除插件目录中的插件文件。'}
                可以选择同时清理数据。
              </p>
            </div>
            <Button variant="danger-ghost" size="sm" onClick={onUninstall}>
              <Trash2 className="size-3.5" />
              卸载
            </Button>
          </div>
        </div>
      )}
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

function ServiceList({ services }: { services: { name: string; optional: boolean }[] }) {
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5">
      {services.map(({ name, optional }) => (
        <span key={name} title={optional ? '可选：缺失时插件照常运行' : undefined}>
          <Badge className="font-mono">
            {name}
            {optional && <span className="font-sans text-fg-3">可选</span>}
          </Badge>
        </span>
      ))}
    </span>
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
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots })
  const [selectedBot, setSelectedBot] = useState('')
  const effectiveBot =
    bots.data?.find((bot) => `${bot.platform}:${bot.selfId}` === selectedBot) ?? bots.data?.[0]
  const set = useMutation({
    mutationFn: ({ groupKey, enabled }: { groupKey: string; enabled: boolean }) =>
      api.setPluginGroup(plugin.name, groupKey, { enabled }),
    onMutate: ({ groupKey, enabled }) => {
      client.setQueryData<PluginGroupSetting[]>(['pluginGroups', plugin.name], (list = []) =>
        list.some((item) => item.groupKey === groupKey)
          ? list.map((item) => (item.groupKey === groupKey ? { ...item, enabled } : item))
          : [...list, { groupKey, enabled }],
      )
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['pluginGroups', plugin.name] })
      void client.invalidateQueries({ queryKey: ['groups'] })
    },
  })

  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-fg-3">
        插件在机器人上启用后，默认在它的所有群生效。可单独关闭某个群，私聊不受影响。
        {plugin.configSchema && '按群覆盖配置请到“群组”页面中打开对应的群。'}
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const id = groupId.trim()
          if (!isValidId(id)) return toast.error('请输入群 ID')
          if (!effectiveBot) return toast.error('请先添加机器人')
          set.mutate({
            groupKey: `${effectiveBot.platform}:${effectiveBot.selfId}:group:${id}`,
            enabled: false,
          })
          setGroupId('')
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
          placeholder="群 ID"
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
          className="flex-1"
        />
        <Button type="submit" variant="secondary">
          <Plus className="size-4" />
          在该群关闭
        </Button>
      </form>
      {groups.error && !groups.data ? (
        <ErrorState
          error={groups.error}
          onRetry={() => void groups.refetch()}
          retrying={groups.isFetching}
          className="py-8"
        />
      ) : groups.isPending ? (
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
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] text-fg">
                      {item.groupKey.split(':').slice(3).join(':')}
                    </span>
                    {item.config !== undefined && (
                      <Link to={groupPath(item.groupKey)}>
                        <Badge tone="accent">配置已覆盖</Badge>
                      </Link>
                    )}
                  </div>
                  <div className="text-[11.5px] text-fg-3">
                    {item.groupKey.split(':').slice(0, 2).join(' · ')}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cn('text-[12.5px]', item.enabled !== false ? 'text-success' : 'text-fg-3')}
                  >
                    {item.enabled !== false ? '已开启' : '已关闭'}
                  </span>
                  <Switch
                    aria-label={`${item.groupKey} 开关`}
                    checked={item.enabled !== false}
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
