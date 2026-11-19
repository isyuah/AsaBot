import { ScrollText, Workflow } from 'lucide-react'
import { formatClock, levelName, levelStyle } from './format.ts'
import type { DispatchTrace, LogRecord, TraceOutcome, TraceStage } from './types.ts'
import { Badge, type Tone } from './ui/primitives.tsx'
import { cn } from './utils.ts'

const stageLabels: Record<TraceStage, string> = {
  filter: '访问过滤',
  observer: '监听器',
  middleware: '中间件',
  prompt: '对话等待',
  command: '命令',
  matcher: '匹配器',
  suggest: '相似命令提示',
}

const outcomeMeta: Record<TraceOutcome, { label: string; tone: Tone }> = {
  handled: { label: '已处理', tone: 'success' },
  passed: { label: '放行', tone: 'neutral' },
  blocked: { label: '已拦截', tone: 'danger' },
  denied: { label: '权限不足', tone: 'warning' },
  cooldown: { label: '冷却中', tone: 'warning' },
  invalid: { label: '参数错误', tone: 'warning' },
  error: { label: '出错', tone: 'danger' },
  timeout: { label: '超时', tone: 'danger' },
}

const dotColors: Record<Tone, string> = {
  neutral: 'bg-fg-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

/** Content-derived React keys for static lists without IDs; repeats get an occurrence suffix. */
function contentKeys<T>(items: T[], key: (item: T) => string): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = key(item)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return `${base}#${count}`
  })
}

function ms(value: number): string {
  return value < 1 ? '<1 ms' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}

/** How one dispatched event went through the pipeline (DESIGN §24.8), plus the logs written while handling it. */
export function TraceView({ trace, logs }: { trace: DispatchTrace; logs?: LogRecord[] }) {
  const stepKeys = contentKeys(
    trace.steps,
    (step) => `${step.stage}|${step.plugin ?? ''}|${step.command ?? ''}`,
  )
  const logKeys = contentKeys(logs ?? [], (record) => `${record.time}|${record.msg}`)
  return (
    <div className="space-y-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-3">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
          <Workflow className="size-3.5" />
          处理链
        </span>
        <span className="font-mono">{trace.name}</span>
        <span>耗时 {ms(trace.duration)}</span>
        {trace.sent.length > 0 && <span>发出 {trace.sent.length} 条消息</span>}
      </div>
      {trace.steps.length === 0 ? (
        <p className="text-fg-3">没有任何处理器处理这条消息。</p>
      ) : (
        <ol className="relative space-y-2 pl-4 before:absolute before:top-1.5 before:bottom-1.5 before:left-[3px] before:w-px before:bg-border">
          {trace.steps.map((step, index) => {
            const meta = outcomeMeta[step.outcome]
            return (
              <li key={stepKeys[index]} className="relative">
                <span
                  className={cn(
                    'absolute top-[7px] -left-4 size-[7px] rounded-full ring-2 ring-surface',
                    dotColors[meta.tone],
                  )}
                />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-fg-2">{stageLabels[step.stage]}</span>
                  {step.plugin && (
                    <span className="rounded bg-accent-soft px-1.5 text-[11.5px] leading-[18px] text-accent-soft-fg">
                      {step.plugin}
                    </span>
                  )}
                  {step.command && <code className="font-mono text-fg">/{step.command}</code>}
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="ml-auto text-fg-3 tabular">{ms(step.duration)}</span>
                </div>
                {step.error && <p className="mt-1 break-words text-danger">{step.error}</p>}
              </li>
            )
          })}
        </ol>
      )}
      {logs && logs.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 font-medium text-fg-2">
            <ScrollText className="size-3.5" />
            日志
          </div>
          <ul className="space-y-1 rounded-lg bg-surface-2/60 px-3 py-2 font-mono text-[11.5px]">
            {logs.map((record, index) => {
              const name = levelName(record.level)
              return (
                <li key={logKeys[index]} className="flex items-start gap-2">
                  <span className="shrink-0 text-fg-3 tabular">{formatClock(record.time)}</span>
                  <span
                    className={cn(
                      'w-11 shrink-0 rounded px-1 text-center text-[10.5px] leading-[17px] uppercase',
                      levelStyle[name],
                    )}
                  >
                    {name}
                  </span>
                  {record.plugin && <span className="shrink-0 text-accent-soft-fg">{record.plugin}</span>}
                  <span className={cn('min-w-0 break-words', record.level >= 50 ? 'text-danger' : 'text-fg')}>
                    {record.msg}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
