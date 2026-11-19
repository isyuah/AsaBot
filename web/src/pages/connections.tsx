import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  type JsonSchema,
  PageHeader,
  PageTabs,
  SchemaForm,
  Select,
  Skeleton,
  type Tone,
} from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Cable, ChevronRight, Copy, RefreshCw, ScanLine, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ConnectionQrSetup } from '../components/connection-qr-setup.tsx'
import { ApiError, api } from '../lib/api.ts'
import { adapterPath, botPath, connectionPath, timeText } from '../lib/management.ts'
import { Link, navigate } from '../lib/router.tsx'
import type { AdapterView, ConnectionInput, ConnectionView } from '../lib/types.ts'

const status: Record<ConnectionView['state'], { label: string; tone: Tone }> = {
  disabled: { label: '已停用', tone: 'neutral' },
  connecting: { label: '连接中', tone: 'warning' },
  waiting: { label: '等待接入', tone: 'info' },
  online: { label: '在线', tone: 'success' },
  retrying: { label: '等待重试', tone: 'warning' },
  error: { label: '连接失败', tone: 'danger' },
  offline: { label: '离线', tone: 'danger' },
  reauthorize: { label: '需要重新扫码', tone: 'danger' },
}
export function ConnectionStatus({ state }: { state: ConnectionView['state'] }) {
  return (
    <Badge tone={status[state].tone} dot>
      {status[state].label}
    </Badge>
  )
}
export function RobotTabs({ view }: { view: 'bots' | 'connections' }) {
  return (
    <PageTabs
      value={view}
      onChange={(value) => navigate(value === 'bots' ? '/bots' : '/bots/connections')}
      tabs={[
        { value: 'bots', label: '机器人' },
        { value: 'connections', label: '连接' },
      ]}
      className="mb-5"
    />
  )
}
export function ConnectionsPage({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections })
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters })
  if (connections.error || adapters.error)
    return (
      <ErrorState
        error={(connections.error ?? adapters.error) as Error}
        onRetry={() => {
          void connections.refetch()
          void adapters.refetch()
        }}
      />
    )
  if (!connections.data || !adapters.data) return <Skeleton className="h-64 rounded-xl" />
  if (parts[2] === 'new')
    return <ConnectionEditor key={parts.join('/')} adapters={adapters.data} initialAdapter={parts[3]} />
  if (parts[2]) {
    const connection = connections.data.find((item) => item.id === parts[2])
    return connection ? (
      <ConnectionEditor key={connection.id} connection={connection} adapters={adapters.data} />
    ) : (
      <EmptyState
        icon={<Cable />}
        title="连接不存在"
        action={<Button onClick={() => navigate('/bots/connections')}>返回连接列表</Button>}
      />
    )
  }
  return (
    <>
      {!connections.data.length ? (
        <Card>
          <EmptyState
            icon={<Cable />}
            title="还没有连接"
            description="选择适配器，按提示填写配置或扫码授权。"
            action={<Button onClick={() => navigate('/bots/connections/new')}>添加连接</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {connections.data.map((connection) => (
            <Link key={connection.id} to={connectionPath(connection.id)} className="block">
              <Card className="flex items-start gap-4 p-5 transition-colors hover:border-border-strong">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-3">
                  <Cable className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold">{connection.name}</span>
                    <ConnectionStatus state={connection.state} />
                  </div>
                  <p className="mt-1 text-[12.5px] text-fg-3">
                    {adapters.data.find((item) => item.id === connection.adapter)?.name ?? connection.adapter}{' '}
                    · {connection.bots.length} 个已识别机器人
                  </p>
                  {connection.lastError && (
                    <p className="mt-2 truncate text-[12.5px] text-danger">{connection.lastError}</p>
                  )}
                  {connection.nextRetryAt && (
                    <p className="mt-1 text-[12px] text-fg-3">下次重试 {timeText(connection.nextRetryAt)}</p>
                  )}
                </div>
                <ChevronRight className="mt-2 size-4 text-fg-3" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

function ConnectionEditor({
  connection,
  adapters,
  initialAdapter,
}: {
  connection?: ConnectionView
  adapters: AdapterView[]
  initialAdapter?: string
}) {
  const client = useQueryClient()
  const [adapterId, setAdapterId] = useState(connection?.adapter ?? initialAdapter ?? adapters[0]?.id ?? '')
  const [id] = useState(() => connection?.id ?? crypto.randomUUID())
  const [removing, setRemoving] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const adapter = adapters.find((item) => item.id === adapterId)
  const qr = adapter?.setup?.kind === 'qr'
  const invalidate = () =>
    Promise.all(
      ['connections', 'bots', 'bot', 'overview'].map((key) => client.invalidateQueries({ queryKey: [key] })),
    )
  const saved = async (connectionId: string) => {
    await invalidate()
    setRescanning(false)
    toast.success('连接已保存')
    navigate(connectionPath(connectionId))
  }
  const save = useMutation({
    mutationFn: (value: Omit<ConnectionInput, 'id' | 'adapter'>) =>
      api.saveConnection({ ...value, id, adapter: adapterId, ...(qr && { config: {} }) }, !connection),
    onSuccess: () => saved(id),
  })
  const reconnect = useMutation({ mutationFn: () => api.reconnect(id), onSuccess: invalidate })
  const remove = useMutation({
    mutationFn: () => api.deleteConnection(id),
    onSuccess: () => {
      invalidate()
      navigate('/bots/connections')
      toast.success('连接已删除')
    },
  })
  const schema = useMemo<JsonSchema>(
    () => ({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: '连接名称', minLength: 1, default: adapter?.name },
        enabled: { type: 'boolean', title: '启用连接', default: true },
        ...(adapter?.setup?.kind !== 'qr' && { config: { ...adapter?.configSchema, title: '连接配置' } }),
      },
    }),
    [adapter],
  )
  const value = connection
    ? { name: connection.name, enabled: connection.enabled, ...(!qr && { config: connection.config }) }
    : undefined
  const issues =
    save.error instanceof ApiError
      ? Object.fromEntries(save.error.issues.map((issue) => [issue.path, issue.message]))
      : {}
  return (
    <>
      <Link
        to="/bots/connections"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg"
      >
        <ArrowLeft className="size-3.5" />
        连接列表
      </Link>
      <PageHeader
        title={connection?.name ?? '添加连接'}
        description={connection ? <span className="font-mono text-xs">{id}</span> : '选择适配器并完成接入'}
        actions={
          connection && (
            <>
              <Button
                disabled={!connection.enabled || rescanning}
                loading={reconnect.isPending}
                onClick={() => reconnect.mutate()}
              >
                <RefreshCw className="size-3.5" />
                立即重连
              </Button>
              {qr && (
                <Button
                  variant={connection.state === 'reauthorize' ? 'primary' : 'secondary'}
                  disabled={rescanning || reconnect.isPending || save.isPending}
                  onClick={() => setRescanning(true)}
                >
                  <ScanLine className="size-3.5" />
                  重新扫码
                </Button>
              )}
              <Button variant="danger-ghost" disabled={rescanning} onClick={() => setRemoving(true)}>
                <Trash2 className="size-3.5" />
                删除
              </Button>
            </>
          )
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="min-w-0 p-4 sm:p-6">
          <div className="mb-5">
            <Select
              aria-label="适配器"
              value={adapterId}
              onValueChange={setAdapterId}
              disabled={!!connection}
              options={adapters.map((item) => ({ value: item.id, label: item.name }))}
            />
          </div>
          {adapter &&
            (qr && (!connection || rescanning) ? (
              <ConnectionQrSetup
                key={adapter.id}
                adapter={adapter}
                connection={connection}
                onSaved={(id) => void saved(id)}
                onCancel={() => (connection ? setRescanning(false) : navigate('/bots/connections'))}
              />
            ) : (
              <SchemaForm
                key={adapter.id}
                schema={schema}
                value={value}
                issues={issues}
                saving={save.isPending}
                submitWhenPristine={!connection}
                submitLabel={connection ? '保存连接' : '创建连接'}
                note={connection ? '保存后应用到这条连接' : '创建后开始连接'}
                onSubmit={(value) => save.mutate(value as Omit<ConnectionInput, 'id' | 'adapter'>)}
              />
            ))}
          {save.error && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {save.error.message}
              {save.error instanceof ApiError &&
                save.error.issues.map((issue) => (
                  <span className="block" key={issue.path}>
                    {issue.message}
                  </span>
                ))}
            </p>
          )}
        </Card>
        <div className="space-y-4">
          <Card className="space-y-4 p-5">
            <h2 className="text-sm font-semibold">{connection ? '连接状态' : '适配器'}</h2>
            {connection && (
              <>
                <ConnectionStatus state={connection.state} />
                <dl className="space-y-2 text-[12.5px] text-fg-3">
                  <dt>状态变更</dt>
                  <dd>{timeText(connection.changedAt)}</dd>
                  <dt>最近上线</dt>
                  <dd>{timeText(connection.lastConnectedAt)}</dd>
                  {connection.nextRetryAt && (
                    <>
                      <dt>下次重试</dt>
                      <dd>{timeText(connection.nextRetryAt)}</dd>
                    </>
                  )}
                </dl>
              </>
            )}
            <Link
              to={adapterPath(adapterId)}
              className="inline-flex items-center gap-1 text-[13px] text-accent"
            >
              {adapter?.name} 能力与配置
              <ChevronRight className="size-3.5" />
            </Link>
          </Card>
          {connection?.lastError && (
            <Card className="p-5">
              <p className="text-[13px] font-medium">最近异常</p>
              <p className="mt-1 text-[11.5px] text-fg-3">{timeText(connection.errorAt)}</p>
              <p className="mt-2 break-words text-[12.5px] text-danger">{connection.lastError}</p>
              <Link
                to={`/logs?connectionId=${encodeURIComponent(id)}`}
                className="mt-3 inline-block text-[12.5px] text-accent"
              >
                查看连接日志
              </Link>
            </Card>
          )}
          {connection?.endpoints.map((endpoint) => {
            const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${endpoint}`
            return (
              <Card key={endpoint} className="p-5">
                <p className="mb-2 text-[13px] font-medium">反向接入地址</p>
                <code className="break-all text-[12px] text-fg-2">{url}</code>
                <Button
                  className="mt-3"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(url)
                      .then(() => toast.success('地址已复制'))
                      .catch(() => toast.error('复制失败，请手动复制地址'))
                  }}
                >
                  <Copy className="size-3.5" />
                  复制地址
                </Button>
              </Card>
            )
          })}
          {connection && connection.bots.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">关联机器人</h2>
              <ul className="space-y-2">
                {connection.bots.map((bot) => (
                  <li key={`${bot.platform}:${bot.selfId}`}>
                    <Link to={botPath(bot)} className="break-all font-mono text-[12.5px] text-accent">
                      {bot.selfId}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title="删除连接"
        description="这条连接会断开并从配置文件中移除，机器人设置和历史数据会保留。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              取消
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              删除连接
            </Button>
          </>
        }
      />
    </>
  )
}
