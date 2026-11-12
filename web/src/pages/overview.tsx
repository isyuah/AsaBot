import { useQuery } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Bot, Cpu, MessagesSquare, Puzzle, Radio } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import { Avatar } from '../components/avatar.tsx'
import { MessageChart } from '../components/message-chart.tsx'
import { NumberTicker, Segmented } from '../components/ui/misc.tsx'
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { formatBytes, formatDuration, formatRelative } from '../lib/format.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { useLiveMessages } from '../lib/realtime.tsx'
import { Link } from '../lib/router.tsx'
import type { BotView } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

export function OverviewPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 60_000 })
  const [range, setRange] = useState<'1h' | '24h'>('1h')
  const stats = useQuery({
    queryKey: ['stats', range],
    queryFn: () => api.stats(range),
    refetchInterval: range === '24h' ? 5 * 60_000 : false,
    placeholderData: (previous) => previous,
  })
  const data = overview.data
  const online = data?.bots.filter((bot) => bot.status === 'online').length ?? 0

  return (
    <>
      <PageHeader
        title="概览"
        description={new Date().toLocaleDateString('zh-CN', {
          month: 'long',
          day: 'numeric',
          weekday: 'long',
        })}
      />

      <motion.div
        variants={stagger}
        initial="initial"
        animate="animate"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <StatTile
          icon={<Bot />}
          label="在线机器人"
          loading={!data}
          value={
            <>
              <NumberTicker value={online} />
              <span className="text-fg-3"> / {data?.bots.length ?? 0}</span>
            </>
          }
          footer={
            data && data.bots.length === 0 ? (
              '尚未配置连接'
            ) : online === data?.bots.length ? (
              <span className="text-success">全部在线</span>
            ) : (
              <span className="text-warning">{(data?.bots.length ?? 0) - online} 个离线</span>
            )
          }
        />
        <StatTile
          icon={<ArrowDownLeft />}
          label="今日收到"
          loading={!data}
          value={<NumberTicker value={data?.today.received ?? 0} />}
          footer="条消息"
        />
        <StatTile
          icon={<ArrowUpRight />}
          label="今日发出"
          loading={!data}
          value={<NumberTicker value={data?.today.sent ?? 0} />}
          footer="条消息"
        />
        <StatTile
          icon={<Puzzle />}
          label="运行中插件"
          loading={!data}
          value={<NumberTicker value={data?.plugins.active ?? 0} />}
          footer={
            data && data.plugins.failed > 0 ? (
              <Link to="/plugins" className="text-danger hover:underline">
                {data.plugins.failed} 个加载失败
              </Link>
            ) : (
              `${data?.plugins.disabled ?? 0} 个已停用`
            )
          }
        />
      </motion.div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <motion.div
          className="lg:col-span-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.12 }}
        >
          <Card className="h-full pb-3">
            <CardHeader
              title="消息趋势"
              description={range === '1h' ? '最近一小时，按分钟统计' : '最近 24 小时，每 15 分钟统计'}
              action={
                <Segmented
                  size="sm"
                  value={range}
                  onChange={setRange}
                  options={[
                    { value: '1h', label: '1 小时' },
                    { value: '24h', label: '24 小时' },
                  ]}
                />
              }
            />
            {stats.data ? (
              <MessageChart points={stats.data} range={range} dimmed={stats.isPlaceholderData} />
            ) : (
              <div className="px-5 pt-8 pb-4">
                <Skeleton className="h-[232px] w-full" />
              </div>
            )}
          </Card>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.16 }}
        >
          <BotsCard bots={data?.bots} />
        </motion.div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <motion.div
          className="lg:col-span-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.2 }}
        >
          <LiveFeedCard />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.24 }}
        >
          <SystemCard
            startedAt={data?.startedAt}
            rss={data?.memory.rss}
            heap={data?.memory.heapUsed}
            node={data?.node}
            version={data?.version}
          />
        </motion.div>
      </div>
    </>
  )
}

function StatTile({
  icon,
  label,
  value,
  footer,
  loading,
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  footer: ReactNode
  loading: boolean
}) {
  return (
    <motion.div variants={staggerItem} whileHover={{ y: -2 }} transition={softSpring}>
      <Card className="group relative overflow-hidden px-5 pt-4 pb-4">
        <div className="flex items-center justify-between text-[12.5px] text-fg-3">
          {label}
          <span className="flex size-7 items-center justify-center rounded-lg bg-surface-2 text-fg-3 transition-colors group-hover:bg-accent-soft group-hover:text-accent-soft-fg [&>svg]:size-3.5">
            {icon}
          </span>
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-8 w-20" />
        ) : (
          <div className="mt-1.5 text-[28px] leading-9 font-semibold tracking-[-0.03em] text-fg">{value}</div>
        )}
        <div className="mt-1 text-[12px] text-fg-3">{footer}</div>
      </Card>
    </motion.div>
  )
}

function botTone(bot: BotView) {
  return bot.status === 'online' ? 'success' : bot.status === 'connecting' ? 'warning' : 'danger'
}

const statusLabel = { online: '在线', connecting: '连接中', offline: '离线' } as const

function BotsCard({ bots }: { bots: BotView[] | undefined }) {
  return (
    <Card className="h-full">
      <CardHeader
        title="机器人"
        description="账号与连接状态"
        action={
          <Link to="/bots" className="text-[12.5px] text-fg-3 hover:text-fg">
            查看
          </Link>
        }
      />
      <div className="px-2 pb-3">
        {!bots ? (
          <div className="space-y-2 px-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : bots.length === 0 ? (
          <EmptyState
            icon={<Radio />}
            title="还没有连接"
            description="在配置文件的 onebot11.connections 中添加 NapCat 连接。"
            className="py-8"
          />
        ) : (
          <ul>
            {bots.map((bot) => (
              <li
                key={`${bot.platform}:${bot.selfId}`}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-2/70"
              >
                <Avatar id={bot.selfId} name={bot.nickname} platform={bot.platform} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">{bot.nickname ?? bot.selfId}</div>
                  <div className="truncate font-mono text-[11.5px] text-fg-3">
                    {bot.selfId} · {bot.connection === 'forward' ? '正向 WS' : '反向 WS'}
                  </div>
                </div>
                <Badge tone={botTone(bot)} dot pulse={bot.status === 'online'}>
                  {statusLabel[bot.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function LiveFeedCard() {
  const messages = useLiveMessages()
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <Card className="h-full">
      <CardHeader
        title="实时消息"
        description="机器人收到和发出的消息"
        action={
          <span className="flex items-center gap-1.5 text-[12px] text-fg-3">
            <span className="relative flex size-1.5">
              <span className="absolute inset-0 rounded-full bg-success motion-safe:animate-pulse-soft" />
              <span className="relative size-full rounded-full bg-success" />
            </span>
            实时
          </span>
        }
      />
      <div className="h-[316px] overflow-hidden px-2 pb-2 [mask-image:linear-gradient(to_bottom,black_85%,transparent)]">
        {messages.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare />}
            title="等待消息中"
            description="有人和机器人说话时，消息会出现在这里。"
            className="py-12"
          />
        ) : (
          <ul>
            <AnimatePresence initial={false}>
              {messages.slice(0, 14).map((message) => (
                <motion.li
                  key={`${message.time}-${message.direction}-${message.preview}-${message.userId ?? ''}`}
                  layout
                  initial={{ opacity: 0, y: -14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={softSpring}
                  className="flex items-start gap-3 rounded-xl px-3 py-2"
                >
                  <Avatar
                    id={message.direction === 'out' ? message.selfId : (message.userId ?? '?')}
                    name={message.direction === 'out' ? 'Bot' : message.nickname}
                    platform={message.platform}
                    size={28}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-medium text-fg">
                        {message.direction === 'out' ? '机器人' : (message.nickname ?? message.userId)}
                      </span>
                      <span
                        className={cn(
                          'rounded px-1 text-[10.5px] font-medium',
                          message.direction === 'out'
                            ? 'bg-success-soft text-success'
                            : 'bg-accent-soft text-accent-soft-fg',
                        )}
                      >
                        {message.direction === 'out' ? '发出' : '收到'}
                      </span>
                      <span className="truncate text-fg-3">
                        {message.channel.type === 'group' ? `群 ${message.channel.id}` : '私聊'}
                      </span>
                      <span className="ml-auto shrink-0 text-fg-3 tabular">
                        {formatRelative(message.time)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-fg-2">
                      {message.preview || '[非文本消息]'}
                    </p>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </Card>
  )
}

function SystemCard({
  startedAt,
  rss,
  heap,
  node,
  version,
}: {
  startedAt?: number
  rss?: number
  heap?: number
  node?: string
  version?: string
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const rows: { label: string; value: ReactNode }[] = [
    { label: '已运行', value: startedAt ? formatDuration(now - startedAt) : '—' },
    { label: '内存（RSS）', value: rss ? formatBytes(rss) : '—' },
    { label: 'JS 堆', value: heap ? formatBytes(heap) : '—' },
    { label: 'Node.js', value: node ?? '—' },
    { label: 'AsaBot', value: version ? `v${version}` : '—' },
  ]
  return (
    <Card className="h-full">
      <CardHeader title="系统" description="运行环境" action={<Cpu className="size-4 text-fg-3" />} />
      <dl className="space-y-0.5 px-5 pb-4">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between border-b border-border py-2.5 last:border-0"
          >
            <dt className="text-[13px] text-fg-3">{row.label}</dt>
            <dd className="text-[13px] font-medium text-fg tabular">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
