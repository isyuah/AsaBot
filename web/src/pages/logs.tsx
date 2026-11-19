import {
  Button,
  Card,
  cn,
  EmptyState,
  formatClock,
  Input,
  levelName,
  levelStyle,
  PageHeader,
  Segmented,
  Select,
  softSpring,
} from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Eraser, Pause, Play, ScrollText, Search, Workflow, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { useClearLogs, useLiveLogs } from '../lib/realtime.tsx'
import { navigate, useLocation } from '../lib/router.tsx'
import type { LogEntry, LogLevel } from '../lib/types.ts'

type LevelFilter = '10' | '30' | '40' | '50'

const recordLevels: { value: LogLevel; label: string }[] = [
  { value: 'trace', label: 'Trace' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
]

const hiddenKeys = new Set(['time', 'level', 'msg', 'plugin', 'eventId', 'pid', 'hostname', 'seq'])
const maxRendered = 600

export function LogsPage() {
  const location = useLocation()
  const scope = useMemo(() => new URLSearchParams(location.split('?')[1]), [location])
  const live = useLiveLogs()
  const clear = useClearLogs()
  const [level, setLevel] = useState<LevelFilter>('10')
  const [plugin, setPlugin] = useState('*')
  const [query, setQuery] = useState('')
  // Logs written while handling one dispatched event (records carry eventId, DESIGN §24.8).
  useEffect(() => {
    const query = new URLSearchParams(location.split('?')[1])
    setPlugin(query.get('plugin') ?? '*')
  }, [location])
  const [eventId, setEventId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [snapshot, setSnapshot] = useState<LogEntry[] | null>(null)
  const [stick, setStick] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  const source = paused && snapshot ? snapshot : live
  const plugins = useMemo(
    () =>
      [
        ...new Set(live.map((record) => record.plugin).filter((name): name is string => Boolean(name))),
      ].sort(),
    [live],
  )

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const min = Number(level)
    return source
      .filter(
        (record) =>
          record.level >= min &&
          (!scope.has('connectionId') || record.connectionId === scope.get('connectionId')) &&
          (!scope.has('platform') || record.platform === scope.get('platform')) &&
          (!scope.has('selfId') || record.selfId === scope.get('selfId')) &&
          (eventId === null || record.eventId === eventId) &&
          (plugin === '*' || (plugin === '-' ? !record.plugin : record.plugin === plugin)) &&
          (!keyword ||
            record.msg.toLowerCase().includes(keyword) ||
            JSON.stringify(record).toLowerCase().includes(keyword)),
      )
      .slice(-maxRendered)
  }, [source, level, plugin, query, eventId, scope])

  // Keep the view pinned to the newest entry unless the user scrolled up to read.
  useEffect(() => {
    const element = scroller.current
    if (element && stick && rows.length > 0) element.scrollTop = element.scrollHeight
  }, [rows, stick])

  return (
    <>
      <PageHeader
        title="日志"
        description="实时日志，保留最近 2000 条"
        actions={
          <>
            <RecordLevel />
            <Button
              variant={paused ? 'primary' : 'secondary'}
              onClick={() => {
                setSnapshot(paused ? null : live)
                setPaused(!paused)
              }}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? '继续' : '暂停'}
            </Button>
            <Button variant="ghost" onClick={clear}>
              <Eraser className="size-3.5" />
              清空
            </Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(scope.has('connectionId') || scope.has('selfId')) && (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border py-1 pr-1 pl-2.5 text-xs text-fg-2">
            <span className="truncate">
              {scope.has('connectionId')
                ? `连接：${scope.get('connectionId')}`
                : `机器人：${scope.get('platform')} · ${scope.get('selfId')}`}
            </span>
            <button
              type="button"
              aria-label="清除来源范围"
              className="rounded p-1 hover:bg-surface-2"
              onClick={() => {
                const params = new URLSearchParams(scope)
                params.delete('connectionId')
                params.delete('selfId')
                params.delete('platform')
                navigate(`/logs${params.size ? `?${params}` : ''}`)
              }}
            >
              <X className="size-3.5" />
            </button>
          </span>
        )}
        <Segmented
          value={level}
          onChange={setLevel}
          options={[
            { value: '10', label: '全部' },
            { value: '30', label: 'Info+' },
            { value: '40', label: 'Warn+' },
            { value: '50', label: 'Error' },
          ]}
        />
        <Select
          aria-label="按插件过滤"
          value={plugin}
          onValueChange={setPlugin}
          options={[
            { value: '*', label: '全部来源' },
            { value: '-', label: '框架' },
            ...plugins.map((name) => ({ value: name, label: name })),
          ]}
        />
        {eventId !== null && (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft py-0 pr-1 pl-2.5 text-[12.5px] text-accent-soft-fg">
            <Workflow className="size-3.5" />
            只看事件 <span className="font-mono">{eventId.slice(0, 8)}</span>
            <button
              type="button"
              aria-label="取消按事件过滤"
              onClick={() => setEventId(null)}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent/10"
            >
              <X className="size-3.5" />
            </button>
          </span>
        )}
        <Input
          icon={<Search />}
          placeholder="搜索日志内容"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ml-auto w-64"
        />
      </div>

      <Card className="relative overflow-hidden">
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget
            setStick(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
          }}
          className="h-[calc(100vh-270px)] min-h-[360px] overflow-y-auto py-1.5 font-mono text-[12.5px]"
        >
          {rows.length === 0 ? (
            <EmptyState
              icon={<ScrollText />}
              title={source.length === 0 ? '暂无日志' : '没有匹配的日志'}
              className="h-full"
            />
          ) : (
            rows.map((record) => <LogRow key={record.seq} record={record} onEvent={setEventId} />)
          )}
        </div>
        <AnimatePresence>
          {!stick && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={softSpring}
              className="absolute right-4 bottom-4"
            >
              <Button
                variant="secondary"
                size="sm"
                className="shadow-pop"
                onClick={() => {
                  setStick(true)
                  scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
                }}
              >
                <ArrowDown className="size-3.5" />
                最新
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {paused && (
          <div className="absolute top-3 right-4 rounded-md bg-warning-soft px-2 py-0.5 font-sans text-[11.5px] font-medium text-warning">
            已暂停
          </div>
        )}
      </Card>
    </>
  )
}

/** Server-side log level (what gets recorded at all), unlike the display filter below it. Runtime only. */
function RecordLevel() {
  const client = useQueryClient()
  const level = useQuery({ queryKey: ['log-level'], queryFn: api.logLevel })
  const change = useMutation({
    mutationFn: api.setLogLevel,
    onSuccess: (result) => {
      client.setQueryData(['log-level'], result)
      toast.success(`记录级别已调整为 ${result.level}`, {
        description: '仅本次运行有效，重启后恢复为配置文件中的 log.level',
      })
    },
  })
  if (level.error) return null
  return (
    <div className="mr-1 flex items-center gap-2">
      <span className="text-[12.5px] text-fg-3">记录级别</span>
      <Select
        aria-label="记录级别"
        value={level.data?.level}
        onValueChange={(next) => change.mutate(next)}
        options={recordLevels}
        placeholder="…"
        className="min-w-24"
      />
    </div>
  )
}

const LogRow = memo(function LogRow({
  record,
  onEvent,
}: {
  record: LogEntry
  onEvent: (eventId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const name = levelName(record.level)
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !hiddenKeys.has(key)))
  const hasExtra = Object.keys(extra).length > 0
  return (
    <div
      className={cn(
        'group relative [content-visibility:auto] [contain-intrinsic-size:auto_28px]',
        open && 'bg-surface-2/60',
      )}
    >
      <button
        type="button"
        onClick={() => hasExtra && setOpen(!open)}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-[5px] text-left transition-colors hover:bg-surface-2/60',
          hasExtra && 'cursor-pointer',
        )}
      >
        <span className="shrink-0 text-fg-3 tabular">{formatClock(record.time)}</span>
        <span
          className={cn(
            'w-12 shrink-0 rounded px-1 text-center text-[11px] leading-[18px] font-medium uppercase',
            levelStyle[name],
          )}
        >
          {name}
        </span>
        {record.plugin && (
          <span className="shrink-0 rounded bg-accent-soft px-1.5 text-[11.5px] leading-[18px] text-accent-soft-fg">
            {record.plugin}
          </span>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 break-words whitespace-pre-wrap',
            record.level >= 50 ? 'text-danger' : 'text-fg',
          )}
        >
          {record.msg}
        </span>
      </button>
      {record.eventId && (
        <button
          type="button"
          title="只看这次事件处理产生的日志"
          onClick={() => onEvent(record.eventId as string)}
          className="absolute top-[5px] right-4 cursor-pointer rounded bg-surface-2 px-1.5 font-mono text-[11px] leading-[18px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg-2 focus-visible:opacity-100"
        >
          事件 {record.eventId.slice(0, 8)}
        </button>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.pre
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden px-4 pl-[170px] text-[12px] leading-relaxed text-fg-2"
          >
            <code className="block pb-2">{JSON.stringify(extra, null, 2)}</code>
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  )
})
