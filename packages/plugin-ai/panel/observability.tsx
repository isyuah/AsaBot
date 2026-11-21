import {
  Badge,
  Button,
  Card,
  DatePicker,
  Dialog,
  EmptyState,
  Field,
  Input,
  Sheet,
  Skeleton,
} from '@asabot/panel-ui'
import { Activity, ChevronLeft, ChevronRight, ClipboardList, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useState } from 'react'
import {
  type Capability,
  type CatalogView,
  capabilities,
  protocolInfo,
  type QueryFilters,
  type RequestDetail,
  type RequestPage,
  requestStates,
  type UsageGroup,
  type UsageReport,
  type UsageTotals,
  usageFields,
} from '../src/contracts.ts'
import {
  asDuration,
  clock,
  FormError,
  Loading,
  labels,
  number,
  PickField,
  queryPath,
  RemoteError,
  rpc,
  Status,
  sourceName,
  stateName,
  usageLabels,
  useAction,
  useRemote,
} from './ui.tsx'

const UsageChart = lazy(() => import('./usage-chart.tsx'))

function uniqueSources(data: CatalogView) {
  return [...new Set(['@panel', ...data.consumers, ...(data.capture ? [data.capture.source] : [])])]
}

function Filters({
  data,
  usage,
  onApply,
}: {
  data: CatalogView
  usage?: boolean
  onApply: (filters: QueryFilters) => void
}) {
  const form = useId()
  const [draft, setDraft] = useState<QueryFilters>({})
  return (
    <Card className="ai-padding">
      <form
        className="ai-filter"
        onSubmit={(event) => {
          event.preventDefault()
          onApply(draft)
        }}
      >
        <Field label="开始日期（UTC）" htmlFor={`${form}-from`}>
          <DatePicker
            id={`${form}-from`}
            value={draft.from}
            max={draft.to}
            timeZone="UTC"
            onValueChange={(from) => setDraft({ ...draft, from })}
          />
        </Field>
        <Field label="结束日期（UTC）" htmlFor={`${form}-to`}>
          <DatePicker
            id={`${form}-to`}
            value={draft.to}
            min={draft.from}
            timeZone="UTC"
            onValueChange={(to) => setDraft({ ...draft, to })}
          />
        </Field>
        <Field label="来源" htmlFor={`${form}-source`}>
          <Input
            id={`${form}-source`}
            list={`${form}-sources`}
            value={draft.source ?? ''}
            placeholder="全部来源"
            onChange={(event) => setDraft({ ...draft, source: event.target.value.trim() || undefined })}
          />
          <datalist id={`${form}-sources`}>
            {uniqueSources(data).map((item) => (
              <option key={item} value={item} label={sourceName(item)} />
            ))}
          </datalist>
        </Field>
        <Field label="渠道" htmlFor={`${form}-channel`}>
          <Input
            id={`${form}-channel`}
            list={`${form}-channels`}
            value={draft.channelId ?? ''}
            placeholder="名称选项或渠道 ID"
            onChange={(event) => setDraft({ ...draft, channelId: event.target.value.trim() || undefined })}
          />
          <datalist id={`${form}-channels`}>
            {data.channels.map((item) => (
              <option key={item.id} value={item.id} label={item.name} />
            ))}
          </datalist>
        </Field>
        <Field label="模型" htmlFor={`${form}-model`}>
          <Input
            id={`${form}-model`}
            list={`${form}-models`}
            value={draft.modelId ?? ''}
            placeholder="名称选项或模型 ID"
            onChange={(event) => setDraft({ ...draft, modelId: event.target.value.trim() || undefined })}
          />
          <datalist id={`${form}-models`}>
            {data.models
              .filter((item) => !draft.channelId || item.channelId === draft.channelId)
              .map((item) => (
                <option key={item.id} value={item.id} label={item.name} />
              ))}
          </datalist>
        </Field>
        <PickField
          label="能力"
          value={draft.capability ?? ''}
          choices={[
            { value: '', label: '全部能力' },
            ...capabilities.map((value) => ({ value, label: labels[value] })),
          ]}
          onChange={(value) => setDraft({ ...draft, capability: value || undefined })}
        />
        <PickField
          label="状态"
          value={draft.status ?? ''}
          choices={[
            { value: '', label: '全部状态' },
            ...requestStates
              .filter((item) => !usage || item !== 'running')
              .map((value) => ({ value, label: stateName(value) })),
          ]}
          onChange={(value) => setDraft({ ...draft, status: value || undefined })}
        />
        <div className="ai-actions ai-filter-actions">
          <Button type="submit" variant="primary">
            筛选
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft({})
              onApply({})
            }}
          >
            重置
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function Requests({
  data,
  reload,
  selected,
  onSelect,
}: {
  data: CatalogView
  reload: () => void
  selected?: string
  onSelect: (id?: string) => void
}) {
  const [filters, setFilters] = useState<QueryFilters>({})
  const [pages, setPages] = useState<number[]>([])
  const [capture, setCapture] = useState(false)
  const action = useAction()
  const remote = useRemote<RequestPage>(queryPath('/requests', { ...filters, before: pages.at(-1) }))
  const until = data.capture?.until
  const activeCapture = data.capture && data.capture.until > Date.now() ? data.capture : null
  useEffect(() => {
    if (until === undefined) return
    const timer = window.setTimeout(reload, Math.max(0, until - Date.now()))
    return () => window.clearTimeout(timer)
  }, [until, reload])
  return (
    <div className="ai-stack">
      <div className="ai-head">
        <h2>调用流水</h2>
        <div className="ai-actions">
          <Button onClick={() => setCapture(true)}>{activeCapture ? '更改采集来源' : '临时采集正文'}</Button>
          <Button
            size="icon"
            aria-label="刷新请求"
            title="刷新请求"
            loading={remote.loading}
            onClick={remote.refresh}
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>
      {activeCapture && (
        <Card className="ai-padding">
          <div className="ai-capture">
            <div>
              <h3>正在采集 {sourceName(activeCapture.source)} 的正文</h3>
              <p className="ai-muted">到期：{clock.format(activeCapture.until)} UTC</p>
            </div>
            <Button
              loading={action.busy}
              onClick={() => {
                void action.run(async () => {
                  await rpc('/capture', 'PUT', { source: null })
                  reload()
                })
              }}
            >
              停止采集
            </Button>
          </div>
          <FormError error={action.error} />
        </Card>
      )}
      <Filters
        data={data}
        onApply={(next) => {
          setPages([])
          setFilters(next)
          remote.refresh()
        }}
      />
      {remote.error ? (
        <Card>
          <RemoteError error={remote.error} retry={remote.refresh} loading={remote.loading} />
        </Card>
      ) : !remote.data ? (
        <Loading />
      ) : remote.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList />}
            title="没有匹配的请求"
            description="试试更改筛选条件，或在「模型」发送一次测试请求。"
          />
        </Card>
      ) : (
        <Card className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col">时间（UTC）</th>
                <th scope="col">来源 / 能力</th>
                <th scope="col">模型 / 渠道</th>
                <th scope="col">状态</th>
                <th scope="col">耗时</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {remote.data.items.map((item) => (
                <tr key={item.id}>
                  <td className="ai-nowrap">{clock.format(item.startedAt)}</td>
                  <td className="ai-cell-main">
                    <strong>{sourceName(item.source)}</strong>
                    <span className="ai-cell-line">
                      {labels[item.capability]}
                      {item.mode === 'stream' ? ' · 流式' : ''}
                    </span>
                  </td>
                  <td className="ai-cell-main">
                    <strong>{item.modelName ?? '—'}</strong>
                    <span className="ai-cell-line">{item.channelName}</span>
                  </td>
                  <td className="ai-nowrap">
                    <Status value={item.status} />
                  </td>
                  <td className="ai-nowrap ai-metric">{asDuration(item.durationMs)}</td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => onSelect(item.id)}>
                      详情
                      <ChevronRight size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {(pages.length > 0 || remote.data?.next !== undefined) && (
        <div className="ai-actions">
          <Button
            disabled={!pages.length || remote.loading}
            onClick={() => setPages((current) => current.slice(0, -1))}
          >
            <ChevronLeft size={15} />
            上一页
          </Button>
          <span className="ai-muted">第 {pages.length + 1} 页</span>
          <Button
            disabled={remote.data?.next === undefined || remote.loading}
            onClick={() => {
              const next = remote.data?.next
              if (next !== undefined) setPages([...pages, next])
            }}
          >
            下一页
            <ChevronRight size={15} />
          </Button>
        </div>
      )}
      {selected && <RequestSheet id={selected} onClose={() => onSelect()} />}
      {capture && (
        <Capture
          data={data}
          onClose={() => setCapture(false)}
          onSaved={() => {
            setCapture(false)
            reload()
          }}
        />
      )}
    </div>
  )
}

function Capture({
  data,
  onClose,
  onSaved,
}: {
  data: CatalogView
  onClose: () => void
  onSaved: () => void
}) {
  const form = useId()
  const [source, setSource] = useState(data.capture?.source ?? '')
  const action = useAction()
  return (
    <Dialog
      open
      className="ai-dialog"
      title="临时采集请求正文"
      description="采集指定来源在接下来 30 分钟内的请求正文和返回内容，正文保留 24 小时。不采集密钥、鉴权头或媒体文件。"
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          <Button disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button form={form} type="submit" variant="primary" loading={action.busy}>
            开启采集
          </Button>
        </>
      }
    >
      <form
        className="ai-form"
        id={form}
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            await rpc('/capture', 'PUT', { source: source.trim() })
            onSaved()
          })
        }}
      >
        <Field
          label="采集来源"
          required
          htmlFor={`${form}-source`}
          hint="输入插件名；采集测试调用时选「面板测试」。"
        >
          <Input
            id={`${form}-source`}
            required
            list={`${form}-sources`}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            autoComplete="off"
          />
          <datalist id={`${form}-sources`}>
            {uniqueSources(data).map((item) => (
              <option key={item} value={item} label={sourceName(item)} />
            ))}
          </datalist>
        </Field>
        <FormError error={action.error} />
      </form>
    </Dialog>
  )
}

function RequestSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const remote = useRemote<RequestDetail>(`/requests/${id}`)
  const item = remote.data
  const tokens =
    item &&
    usageFields.filter(
      (field) => field === 'inputTokens' || field === 'outputTokens' || item.usage[field] !== undefined,
    )
  return (
    <Sheet
      open
      onOpenChange={onClose}
      title="请求详情"
      subtitle={<code className="ai-code">{id}</code>}
      headerExtra={
        <Button
          size="icon"
          variant="ghost"
          loading={remote.loading}
          onClick={remote.refresh}
          aria-label="刷新详情"
        >
          <RefreshCw size={15} />
        </Button>
      }
    >
      <div className="ai-request-detail">
        {remote.error ? (
          <RemoteError error={remote.error} retry={remote.refresh} loading={remote.loading} />
        ) : !item ? (
          <Loading />
        ) : (
          <>
            <dl className="ai-dl">
              <dt>状态</dt>
              <dd>
                <Status value={item.status} />
              </dd>
              <dt>时间（UTC）</dt>
              <dd>{clock.format(item.startedAt)}</dd>
              <dt>来源</dt>
              <dd>
                {sourceName(item.source)} · {labels[item.capability]}
                {item.mode === 'stream' ? ' · 流式' : ''}
              </dd>
              <dt>耗时</dt>
              <dd>{asDuration(item.durationMs)}</dd>
              <dt>渠道</dt>
              <dd>
                {item.channelName ?? '—'}
                {item.channelId && <code className="ai-cell-line ai-code">{item.channelId}</code>}
              </dd>
              {item.protocol && (
                <>
                  <dt>协议</dt>
                  <dd>{protocolInfo[item.protocol].name}</dd>
                </>
              )}
              <dt>模型</dt>
              <dd>
                {item.modelName ?? '—'}
                {item.modelId && <code className="ai-cell-line ai-code">{item.modelId}</code>}
              </dd>
              <dt>上游模型</dt>
              <dd>
                <code className="ai-code">{item.upstreamModel ?? '—'}</code>
              </dd>
              {item.eventId && (
                <>
                  <dt>机器人</dt>
                  <dd>
                    {item.platform} / {item.selfId}
                  </dd>
                  <dt>事件 ID</dt>
                  <dd>
                    <code className="ai-code">{item.eventId}</code>
                  </dd>
                </>
              )}
            </dl>
            {item.error && (
              <Card className="ai-padding">
                <h3 className="ai-subhead">请求错误</h3>
                <p>{item.error.message}</p>
                <code className="ai-code ai-muted">
                  {item.error.code}
                  {item.error.httpStatus && ` · HTTP ${item.error.httpStatus}`}
                </code>
              </Card>
            )}
            <Card className="ai-padding">
              <h3 className="ai-subhead">本次用量</h3>
              <dl className="ai-dl">
                {tokens?.map((field) => (
                  <UsageDetail key={field} name={usageLabels[field]} value={item.usage[field]} />
                ))}
              </dl>
            </Card>
            {item.content && (
              <Card className="ai-padding">
                <h3 className="ai-subhead">采集正文</h3>
                <p className="ai-note">保留至 {clock.format(item.content.expiresAt)} UTC</p>
                {item.content.input && (
                  <div className="ai-body-block">
                    <h4 className="ai-subhead">请求内容</h4>
                    <pre className="ai-body ai-code">{item.content.input}</pre>
                  </div>
                )}
                {item.content.output && (
                  <div className="ai-body-block">
                    <h4 className="ai-subhead">返回内容</h4>
                    <pre className="ai-body ai-code">{item.content.output}</pre>
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}

function UsageDetail({ name, value }: { name: string; value?: number }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{value === undefined ? '未上报' : number.format(value)}</dd>
    </>
  )
}

const dimensions: Record<UsageGroup, string> = {
  source: '来源',
  channel: '渠道',
  model: '模型',
  capability: '能力',
}
const groupOptions = (['source', 'channel', 'model', 'capability'] as const).map((value) => ({
  value,
  label: dimensions[value],
}))
const rate = (total: UsageTotals) =>
  total.requests === 0 ? '—' : `${number.format((100 * total.succeeded) / total.requests)}%`

function groupLabel(groupBy: UsageGroup, name: string) {
  if (!name) return groupBy === 'channel' ? '未选中渠道' : '未选中模型'
  return groupBy === 'source'
    ? sourceName(name)
    : groupBy === 'capability'
      ? labels[name as Capability]
      : name
}

export function Usage({ data }: { data: CatalogView }) {
  const [filters, setFilters] = useState<QueryFilters>({})
  const [groupBy, setGroupBy] = useState<UsageGroup>('source')
  const remote = useRemote<UsageReport>(queryPath('/usage', { ...filters, groupBy }))
  const report = remote.data
  return (
    <div className="ai-stack">
      <div className="ai-head">
        <h2>实际用量</h2>
        <Button
          size="icon"
          aria-label="刷新用量"
          title="刷新用量"
          loading={remote.loading}
          onClick={remote.refresh}
        >
          <RefreshCw size={16} />
        </Button>
      </div>
      <Filters
        data={data}
        usage
        onApply={(next) => {
          setFilters(next)
          remote.refresh()
        }}
      />
      {remote.error ? (
        <Card>
          <RemoteError error={remote.error} retry={remote.refresh} loading={remote.loading} />
        </Card>
      ) : !report ? (
        <Loading />
      ) : (
        <>
          <div className="ai-card-grid">
            <Metric title="已结束调用" value={number.format(report.total.requests)} />
            <Metric title="成功率" value={rate(report.total)} />
            <Metric title="平均耗时" value={asDuration(report.total.averageMs)} />
            <Metric
              title="输入 / 输出 Token"
              value={['inputTokens', 'outputTokens']
                .map((field) => {
                  const entry = report.total.usage[field as 'inputTokens' | 'outputTokens']
                  return entry ? number.format(entry.value) : '—'
                })
                .join(' / ')}
            />
          </div>
          {!report.total.requests ? (
            <Card>
              <EmptyState icon={<Activity />} title="该区间暂无用量" description="统计在调用结束后更新。" />
            </Card>
          ) : (
            <>
              <Card className="ai-padding ai-bars">
                <div className="ai-head">
                  <h2>每日调用</h2>
                  <span className="ai-muted">
                    {report.from} 至 {report.to}（UTC）
                  </span>
                </div>
                <Suspense fallback={<Skeleton className="ai-usage-chart" />}>
                  <UsageChart daily={report.daily} />
                </Suspense>
              </Card>
              <Card className="ai-padding">
                <div className="ai-head">
                  <h2>消耗明细</h2>
                </div>
                <dl className="ai-dl">
                  {usageFields.map((field) => (
                    <UsageDetail
                      key={field}
                      name={usageLabels[field]}
                      value={report.total.usage[field]?.value}
                    />
                  ))}
                </dl>
                <p className="ai-note">
                  仅汇总有数据的调用。语音输入字符和图片张数按实际请求、返回结果计数。
                </p>
              </Card>
              <div className="ai-head">
                <h2>分组用量</h2>
                <PickField label="分组方式" value={groupBy} choices={groupOptions} onChange={setGroupBy} />
              </div>
              <Card className="ai-scroll">
                <table className="ai-table">
                  <thead>
                    <tr>
                      <th scope="col">{dimensions[groupBy]}</th>
                      <th scope="col">调用</th>
                      <th scope="col">成功率</th>
                      <th scope="col">平均耗时</th>
                      <th scope="col">用量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.groups.map((group) => (
                      <tr key={group.key}>
                        <td className="ai-cell-main">
                          <strong>{groupLabel(groupBy, group.name)}</strong>
                        </td>
                        <td>{number.format(group.requests)}</td>
                        <td>{rate(group)}</td>
                        <td className="ai-nowrap">{asDuration(group.averageMs)}</td>
                        <td>
                          <div className="ai-actions">
                            {usageFields.map((field) => {
                              const value = group.usage[field]
                              return (
                                value && (
                                  <Badge key={field} tone="neutral">
                                    {usageLabels[field]} {number.format(value.value)}
                                  </Badge>
                                )
                              )
                            })}
                            {Object.keys(group.usage).length === 0 && '—'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              {report.moreGroups && <p className="ai-muted">显示调用数最多的 100 组。</p>}
            </>
          )}
        </>
      )}
    </div>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <Card className="ai-metric-card">
      <span className="ai-muted">{title}</span>
      <strong>{value}</strong>
    </Card>
  )
}
