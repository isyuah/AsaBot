import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Sheet,
  Skeleton,
  type Tone,
} from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ListChecks, RefreshCw, Search } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { navigate, useLocation, usePath } from '../lib/router.tsx'
import type { TaskState } from '../lib/types.ts'

const states: Record<TaskState, { label: string; tone: Tone }> = {
  pending: { label: '待执行', tone: 'neutral' },
  running: { label: '执行中', tone: 'accent' },
  retry_wait: { label: '等待重试', tone: 'warning' },
  cancelling: { label: '等待退出', tone: 'warning' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
}
const outcomeLabels = {
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '取消',
  interrupted: '中断',
  timeout: '超时',
}
const time = (value?: number) =>
  value === undefined ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false })
const pathFor = (id: string) => `/tasks/${encodeURIComponent(id)}${window.location.search}`

export function TasksPage() {
  const path = usePath()
  const location = useLocation()
  const selected = path.startsWith('/tasks/') ? decodeURIComponent(path.slice(7)) : null
  const [q, setQ] = useState('')
  const plugin = new URLSearchParams(location.split('?')[1]).get('plugin') ?? 'all'
  const [state, setState] = useState('all')
  const [paging, setPaging] = useState({ plugin, page: 0 })
  const page = paging.plugin === plugin ? paging.page : 0
  const setPage = (page: number) => setPaging({ plugin, page })
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins })
  const filters = {
    q,
    ...(plugin === 'all' ? {} : { plugin }),
    ...(state === 'all' ? {} : { state }),
    limit: '25',
    offset: String(page * 25),
  }
  const tasks = useQuery({
    queryKey: ['tasks', 'list', filters],
    queryFn: () => api.tasks(filters),
    refetchInterval: 15_000,
  })
  const total = tasks.data?.total ?? 0
  return (
    <>
      <PageHeader
        title="任务中心"
        description="查看插件的一次性任务、执行历史与重试状态。"
        actions={
          <Button variant="secondary" loading={tasks.isFetching} onClick={() => void tasks.refetch()}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          aria-label="搜索任务"
          icon={<Search />}
          placeholder="搜索插件、任务名或键"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(0)
          }}
          className="w-64"
        />
        <Select
          aria-label="任务状态"
          value={state}
          onValueChange={(v) => {
            setState(v)
            setPage(0)
          }}
          options={[
            { value: 'all', label: '全部状态' },
            ...Object.entries(states).map(([value, { label }]) => ({ value, label })),
          ]}
        />
        <Select
          aria-label="所属插件"
          value={plugin}
          onValueChange={(v) => {
            navigate(v === 'all' ? '/tasks' : `/tasks?plugin=${encodeURIComponent(v)}`)
            setPage(0)
          }}
          options={[
            { value: 'all', label: '全部插件' },
            ...(plugins.data ?? []).map((p) => ({ value: p.name, label: p.name })),
          ]}
        />
      </div>
      {tasks.error ? (
        <Card>
          <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} retrying={tasks.isFetching} />
        </Card>
      ) : !tasks.data ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : !tasks.data.items.length ? (
        <Card>
          <EmptyState
            icon={<ListChecks />}
            title={q || state !== 'all' || plugin !== 'all' ? '没有匹配的任务' : '暂无任务'}
            description="插件通过 ctx.task 创建的任务会显示在这里。"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-surface-2/50 text-fg-3">
                <tr>
                  {['任务 / 插件', '状态', '下次执行', '尝试', '最近更新'].map((label) => (
                    <th key={label} className="whitespace-nowrap px-5 py-3 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tasks.data.items.map((task) => (
                  <tr key={task.id} className="hover:bg-surface-2/60">
                    <td className="max-w-64 px-5 py-3">
                      <button
                        type="button"
                        onClick={() => navigate(pathFor(task.id))}
                        className="block w-full cursor-pointer truncate text-left font-medium text-accent hover:underline"
                      >
                        {task.name} · {task.key}
                      </button>
                      <div className="mt-1 truncate text-xs text-fg-3">{task.plugin}</div>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={states[task.state].tone}>{states[task.state].label}</Badge>
                      {task.blockedReason && (
                        <div className="mt-1 max-w-44 text-xs text-fg-3">{task.blockedReason}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-fg-2">
                      {task.state === 'pending' || task.state === 'retry_wait' ? time(task.nextRunAt) : '—'}
                    </td>
                    <td className="px-5 py-3 tabular-nums">{task.attempt}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-fg-3">{time(task.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <div className="mt-4 flex items-center justify-between text-xs text-fg-3">
        <span>
          共 {total} 个任务 · 第 {page + 1} 页
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="icon"
            aria-label="上一页"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label="下一页"
            disabled={(page + 1) * 25 >= total}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <TaskSheet id={selected} />
    </>
  )
}

function TaskSheet({ id }: { id: string | null }) {
  const client = useQueryClient()
  const task = useQuery({
    queryKey: ['tasks', id],
    queryFn: () => api.task(id as string),
    enabled: id !== null,
    refetchInterval: 15_000,
  })
  const attempts = useQuery({
    queryKey: ['tasks', id, 'attempts'],
    queryFn: () => api.taskAttempts(id as string),
    enabled: id !== null,
    refetchInterval: 15_000,
  })
  const action = useMutation({
    mutationFn: (operation: 'retry' | 'cancel') => api.taskAction(id as string, operation),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (error) => toast.error(error.message),
  })
  const item = task.data
  const cancellable = item && ['pending', 'running', 'retry_wait'].includes(item.state)
  return (
    <Sheet
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) navigate(`/tasks${window.location.search}`)
      }}
      title={item?.name ?? '任务详情'}
      subtitle={item?.plugin}
    >
      <div className="space-y-6 p-6">
        {task.error ? (
          <ErrorState error={task.error} onRetry={() => void task.refetch()} />
        ) : !item ? (
          <Skeleton className="h-56" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Badge tone={states[item.state].tone}>{states[item.state].label}</Badge>
              <div className="ml-auto flex gap-2">
                {item.canRetry && (
                  <Button
                    variant="secondary"
                    loading={action.isPending}
                    onClick={() => action.mutate('retry')}
                  >
                    重试
                  </Button>
                )}
                {cancellable && (
                  <Button
                    variant="secondary"
                    loading={action.isPending}
                    onClick={() => action.mutate('cancel')}
                  >
                    取消任务
                  </Button>
                )}
              </div>
            </div>
            {item.blockedReason && <p className="text-sm text-warning">{item.blockedReason}</p>}
            {item.state === 'cancelling' && (
              <p className="text-sm text-fg-3">已发送中止信号，等待处理函数退出后释放执行名额。</p>
            )}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-[13px]">
              {[
                ['任务 ID', item.id],
                ['逻辑键', item.key],
                ['创建时间', time(item.createdAt)],
                ['原定执行', time(item.runAt)],
                ['下次执行', time(item.nextRunAt)],
                ['开始时间', time(item.startedAt)],
                ['结束时间', time(item.finishedAt)],
                ['执行次数', String(item.attempt)],
                ['自动重试', `${item.policy.maxRetries} 次 · ${item.policy.delay}ms 起`],
                ['超时', item.policy.timeout ? `${item.policy.timeout}ms` : '未设置'],
              ].map(([label, value]) => (
                <Detail key={label} label={label ?? ''} value={value ?? ''} />
              ))}
            </dl>
            {item.error && (
              <div>
                <h3 className="mb-2 text-sm font-medium">最近错误</h3>
                <pre className="whitespace-pre-wrap break-all rounded-lg bg-danger-soft p-3 text-xs text-danger">
                  {item.error}
                </pre>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-sm font-medium">参数</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-3 text-xs text-fg-2">
                {JSON.stringify(item.payload, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="mb-3 text-sm font-medium">执行历史</h3>
              {attempts.error ? (
                <ErrorState error={attempts.error} onRetry={() => void attempts.refetch()} />
              ) : !attempts.data ? (
                <Skeleton className="h-20" />
              ) : attempts.data.length === 0 ? (
                <p className="text-sm text-fg-3">尚未开始执行</p>
              ) : (
                <ol className="space-y-3">
                  {attempts.data.map((attempt) => (
                    <li key={attempt.id} className="rounded-lg border border-border p-3 text-xs">
                      <div className="flex justify-between font-medium">
                        <span>第 {attempt.attempt} 次</span>
                        <span>{outcomeLabels[attempt.outcome]}</span>
                      </div>
                      <div className="mt-2 text-fg-3">
                        {time(attempt.startedAt)} → {time(attempt.finishedAt)}
                      </div>
                      {attempt.finishedAt !== undefined && (
                        <div className="mt-1 text-fg-3">耗时 {attempt.finishedAt - attempt.startedAt}ms</div>
                      )}
                      {attempt.error && (
                        <pre className="mt-2 whitespace-pre-wrap break-all text-danger">{attempt.error}</pre>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg-3">{label}</dt>
      <dd className="break-all text-fg-2">{value}</dd>
    </>
  )
}
