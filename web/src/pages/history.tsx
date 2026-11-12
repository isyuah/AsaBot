import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Download, Inbox, MessagesSquare, Search, Workflow } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar } from '../components/avatar.tsx'
import { Logo } from '../components/layout/logo.tsx'
import { Segments } from '../components/segments.tsx'
import { TraceLoader } from '../components/trace.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { formatClock, formatRelative } from '../lib/format.ts'
import { softSpring } from '../lib/motion.ts'
import { platformName } from '../lib/platform.ts'
import { useLiveMessages } from '../lib/realtime.tsx'
import type { Segment } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

// Shapes of the history plugin's panel routes (DESIGN §24.8).
interface HistoryMessage {
  id: number
  eventId?: string
  direction: 'in' | 'out'
  platform: string
  selfId: string
  channel: string
  userId?: string
  nickname?: string
  messageId?: string
  message: Segment[]
  text: string
  time: number
}
interface HistoryChannel {
  channel: string
  platform: string
  selfId: string
  type: 'group' | 'private'
  id: string
  count: number
  last: HistoryMessage
}

const pageSize = 50

function useGroupNames(): Map<string, string> {
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.groups() })
  return useMemo(
    () => new Map((groups.data ?? []).flatMap((group) => (group.name ? [[group.groupKey, group.name]] : []))),
    [groups.data],
  )
}

function channelTitle(channel: HistoryChannel, names: Map<string, string>): string {
  if (channel.type === 'group') return names.get(`${channel.platform}:${channel.id}`) ?? `群 ${channel.id}`
  const nickname = channel.last.direction === 'in' ? channel.last.nickname : undefined
  return nickname ? `${nickname}（私聊）` : `私聊 ${channel.id}`
}

export function HistoryPage() {
  const client = useQueryClient()
  const names = useGroupNames()
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const live = useLiveMessages()

  const channels = useQuery({
    queryKey: ['history', 'channels'],
    queryFn: () => api.ext<HistoryChannel[]>('history', 'GET', '/channels'),
  })
  const messages = useInfiniteQuery({
    queryKey: ['history', 'messages', selected, q],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(pageSize) })
      if (selected) params.set('channel', selected)
      if (q) params.set('q', q)
      if (pageParam !== undefined) params.set('before', String(pageParam))
      return api.ext<{ items: HistoryMessage[]; more: boolean }>('history', 'GET', `/messages?${params}`)
    },
    getNextPageParam: (page) => (page.more ? page.items.at(-1)?.id : undefined),
  })

  // New live traffic: refresh the channel list and the newest page of the open conversation.
  const latest = live[0]?.time
  useEffect(() => {
    if (latest === undefined) return
    const timer = window.setTimeout(() => {
      void client.invalidateQueries({ queryKey: ['history', 'channels'] })
      void client.invalidateQueries({ queryKey: ['history', 'messages'] })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [latest, client])

  const visibleChannels = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    return (channels.data ?? []).filter(
      (channel) =>
        !keyword ||
        channel.id.toLowerCase().includes(keyword) ||
        channelTitle(channel, names).toLowerCase().includes(keyword),
    )
  }, [channels.data, filter, names])

  const current = channels.data?.find((channel) => channel.channel === selected)
  // Pages arrive newest first; the stream reads top to bottom, oldest first.
  const items = useMemo(
    () => (messages.data?.pages.flatMap((page) => page.items) ?? []).toReversed(),
    [messages.data],
  )

  // Chat-style scrolling: open at the newest message; loading older pages keeps the visible messages in place;
  // a refresh of the newest page only follows along when the reader is already at the bottom.
  const stream = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ pages: number; fromBottom: number; atBottom: boolean } | null>(null)
  const pages = messages.data?.pages.length ?? 0
  useLayoutEffect(() => {
    const element = stream.current
    if (!element || items.length === 0) return
    const previous = anchor.current
    if (!previous || previous.atBottom) element.scrollTop = element.scrollHeight
    else if (pages > previous.pages) element.scrollTop = element.scrollHeight - previous.fromBottom
  }, [items, pages])
  const remember = () => {
    const element = stream.current
    if (!element) return
    const fromBottom = element.scrollHeight - element.scrollTop
    anchor.current = { pages, fromBottom, atBottom: fromBottom - element.clientHeight < 40 }
  }
  // Switching conversation or search starts at the bottom again.
  const open = (channel: string | null) => {
    anchor.current = null
    setSelected(channel)
  }

  return (
    <>
      <PageHeader
        title="消息记录"
        description="history 插件记录的收发消息，以及每条消息经过了哪些插件处理"
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              const params = selected ? `?channel=${encodeURIComponent(selected)}` : ''
              window.location.href = `/api/panel/ext/history/export${params}`
            }}
          >
            <Download className="size-3.5" />
            {selected ? '导出这个会话' : '导出全部'}
          </Button>
        }
      />
      <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
        <Card className="flex h-[calc(100dvh-190px)] min-h-[480px] flex-col overflow-hidden">
          <div className="border-b border-border p-3">
            <Input
              icon={<Search />}
              placeholder="筛选会话"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            <ChannelButton
              active={selected === null}
              onClick={() => open(null)}
              title="全部会话"
              subtitle={channels.data ? `${channels.data.length} 个会话` : undefined}
              icon={<Inbox className="size-4" />}
            />
            {channels.error && !channels.data ? (
              <ErrorState
                error={channels.error}
                onRetry={() => void channels.refetch()}
                retrying={channels.isFetching}
                className="py-8"
              />
            ) : !channels.data ? (
              <div className="space-y-1.5 p-1.5">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : (
              visibleChannels.map((channel) => (
                <ChannelButton
                  key={channel.channel}
                  active={selected === channel.channel}
                  onClick={() => open(channel.channel)}
                  title={channelTitle(channel, names)}
                  subtitle={`${channel.last.direction === 'out' ? '机器人：' : channel.last.nickname ? `${channel.last.nickname}：` : ''}${channel.last.text || '[非文本消息]'}`}
                  time={channel.last.time}
                  icon={
                    channel.type === 'group' ? (
                      <span className="text-[12px] font-medium">
                        {channelTitle(channel, names).slice(0, 1)}
                      </span>
                    ) : (
                      <Avatar id={channel.id} name={channel.last.nickname} size={32} />
                    )
                  }
                />
              ))
            )}
          </div>
        </Card>

        <Card className="flex h-[calc(100dvh-190px)] min-h-[480px] flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[13.5px] font-semibold">
                {current ? channelTitle(current, names) : '全部会话'}
              </div>
              <div className="text-[11.5px] text-fg-3">
                {current
                  ? `${platformName(current.platform)} · 机器人 ${current.selfId} · 共 ${current.count} 条`
                  : '所有会话的消息按时间排列'}
              </div>
            </div>
            <Input
              icon={<Search />}
              placeholder="搜索消息内容"
              value={search}
              onChange={(event) => {
                anchor.current = null
                setSearch(event.target.value)
              }}
              className="w-56"
            />
          </div>
          <div ref={stream} onScroll={remember} className="flex-1 overflow-y-auto px-5 py-4">
            {messages.error && !messages.data ? (
              <ErrorState
                error={messages.error}
                onRetry={() => void messages.refetch()}
                retrying={messages.isFetching}
              />
            ) : !messages.data ? (
              <div className="space-y-3">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<MessagesSquare />}
                title={q ? '没有匹配的消息' : '还没有消息记录'}
                description={q ? undefined : '机器人收发消息后会出现在这里。'}
              />
            ) : (
              <div className="space-y-1">
                {messages.hasNextPage && (
                  <div className="flex justify-center pb-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={messages.isFetchingNextPage}
                      onClick={() => void messages.fetchNextPage()}
                    >
                      加载更早的消息
                    </Button>
                  </div>
                )}
                {items.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    showChannel={selected === null}
                    names={names}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  )
}

function ChannelButton({
  active,
  onClick,
  title,
  subtitle,
  time,
  icon,
}: {
  active: boolean
  onClick: () => void
  title: string
  subtitle?: string
  time?: number
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors',
        active ? 'text-fg' : 'text-fg-2 hover:bg-surface-2/70',
      )}
    >
      {active && (
        <motion.span
          layoutId="history-channel"
          transition={softSpring}
          className="absolute inset-0 rounded-[10px] bg-accent-soft"
        />
      )}
      <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-surface-2 text-fg-2">
        {icon}
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium">{title}</span>
          {time !== undefined && (
            <span className="shrink-0 text-[11px] text-fg-3">{formatRelative(time)}</span>
          )}
        </span>
        {subtitle && <span className="block truncate text-[12px] text-fg-3">{subtitle}</span>}
      </span>
    </button>
  )
}

function MessageRow({
  message,
  showChannel,
  names,
}: {
  message: HistoryMessage
  showChannel: boolean
  names: Map<string, string>
}) {
  const [open, setOpen] = useState(false)
  const outgoing = message.direction === 'out'
  const traceable = message.direction === 'in' && message.eventId !== undefined
  const [, , type, ...rest] = message.channel.split(':')
  const channelLabel =
    type === 'group' ? (names.get(`${message.platform}:${rest.join(':')}`) ?? `群 ${rest.join(':')}`) : '私聊'
  return (
    <div
      className={cn(
        'group rounded-xl px-2 py-2 transition-colors',
        open ? 'bg-surface-2/60' : 'hover:bg-surface-2/40',
      )}
    >
      <div className="flex gap-3">
        {outgoing ? (
          <Logo className="size-8 shrink-0" />
        ) : (
          <Avatar id={message.userId ?? '?'} name={message.nickname} size={32} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className={cn('font-medium', outgoing ? 'text-accent' : 'text-fg')}>
              {outgoing ? '机器人' : (message.nickname ?? message.userId)}
            </span>
            {!outgoing && message.nickname && <span className="font-mono text-fg-3">{message.userId}</span>}
            {showChannel && <span className="text-fg-3">{channelLabel}</span>}
            <span className="text-fg-3 tabular">{formatClock(message.time)}</span>
            {traceable && (
              <button
                type="button"
                onClick={() => setOpen(!open)}
                className={cn(
                  'ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-opacity',
                  open ? 'text-accent' : 'text-fg-3 opacity-0 group-hover:opacity-100 hover:text-fg-2',
                )}
              >
                <Workflow className="size-3" />
                处理链
                <motion.span animate={{ rotate: open ? 180 : 0 }} transition={softSpring}>
                  <ChevronDown className="size-3" />
                </motion.span>
              </button>
            )}
          </div>
          <div className="mt-0.5 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">
            <Segments message={message.message} />
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && message.eventId && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div className="mt-2 ml-11 rounded-xl border border-border bg-surface px-4 py-3">
              <TraceLoader eventId={message.eventId} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
