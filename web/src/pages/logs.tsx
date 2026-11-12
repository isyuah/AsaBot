import { ArrowDown, Eraser, Pause, Play, ScrollText, Search } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { Card, EmptyState, PageHeader } from '../components/ui/primitives.tsx'
import { Select } from '../components/ui/select.tsx'
import { formatClock, levelName } from '../lib/format.ts'
import { softSpring } from '../lib/motion.ts'
import { useClearLogs, useLiveLogs } from '../lib/realtime.tsx'
import type { LogEntry } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

type LevelFilter = '10' | '30' | '40' | '50'

const levelStyle: Record<string, string> = {
  trace: 'text-fg-3 bg-surface-2',
  debug: 'text-fg-3 bg-surface-2',
  info: 'text-info bg-info-soft',
  warn: 'text-warning bg-warning-soft',
  error: 'text-danger bg-danger-soft',
  fatal: 'text-white bg-danger',
}

const hiddenKeys = new Set(['time', 'level', 'msg', 'plugin', 'pid', 'hostname', 'seq'])
const maxRendered = 600

export function LogsPage() {
  const live = useLiveLogs()
  const clear = useClearLogs()
  const [level, setLevel] = useState<LevelFilter>('10')
  const [plugin, setPlugin] = useState('*')
  const [query, setQuery] = useState('')
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
          (plugin === '*' || (plugin === '-' ? !record.plugin : record.plugin === plugin)) &&
          (!keyword ||
            record.msg.toLowerCase().includes(keyword) ||
            JSON.stringify(record).toLowerCase().includes(keyword)),
      )
      .slice(-maxRendered)
  }, [source, level, plugin, query])

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
            rows.map((record) => <LogRow key={record.seq} record={record} />)
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

const LogRow = memo(function LogRow({ record }: { record: LogEntry }) {
  const [open, setOpen] = useState(false)
  const name = levelName(record.level)
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !hiddenKeys.has(key)))
  const hasExtra = Object.keys(extra).length > 0
  return (
    <div
      className={cn(
        '[content-visibility:auto] [contain-intrinsic-size:auto_28px]',
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
