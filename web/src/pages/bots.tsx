import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, Link2, Radio, Search, Send, Users } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Avatar } from '../components/avatar.tsx'
import { Button } from '../components/ui/button.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Field, Input, Textarea } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { formatNumber } from '../lib/format.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { isValidId } from '../lib/platform.ts'
import type { BotView, Target } from '../lib/types.ts'

const statusMeta = {
  online: { label: '在线', tone: 'success' },
  connecting: { label: '连接中', tone: 'warning' },
  offline: { label: '离线', tone: 'danger' },
} as const

export function BotsPage() {
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots })
  const [sendTo, setSendTo] = useState<{ bot: BotView; target?: Target } | null>(null)

  return (
    <>
      <PageHeader title="机器人" description="已连接的账号、群列表，以及以机器人身份发送消息" />
      {bots.error && !bots.data ? (
        <Card>
          <ErrorState error={bots.error} onRetry={() => void bots.refetch()} retrying={bots.isFetching} />
        </Card>
      ) : !bots.data ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : bots.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Radio />}
            title="还没有机器人连接"
            description="在配置文件的 adapters 段配置适配器。以 OneBot 11 为例：可以填写正向 WS 地址让 AsaBot 主动连接，也可以开启反向 WS，让 OneBot 实现连过来。"
          />
        </Card>
      ) : (
        <motion.div variants={stagger} initial="initial" animate="animate" className="space-y-3">
          {bots.data.map((bot) => (
            <motion.div key={`${bot.platform}:${bot.selfId}`} variants={staggerItem}>
              <BotCard bot={bot} onSend={(target) => setSendTo({ bot, ...(target ? { target } : {}) })} />
            </motion.div>
          ))}
        </motion.div>
      )}
      <SendDialog state={sendTo} onClose={() => setSendTo(null)} />
    </>
  )
}

function BotCard({ bot, onSend }: { bot: BotView; onSend: (target?: Target) => void }) {
  const [expanded, setExpanded] = useState(false)
  const meta = statusMeta[bot.status]
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 p-5">
        <div className="relative">
          <Avatar id={bot.selfId} name={bot.nickname} src={bot.avatar} size={48} />
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-surface">
            <span
              className={`block size-2.5 rounded-full ${bot.status === 'online' ? 'bg-success' : bot.status === 'connecting' ? 'bg-warning' : 'bg-danger'}`}
            />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.01em]">{bot.nickname ?? bot.selfId}</span>
            <Badge tone={meta.tone} dot pulse={bot.status === 'online'}>
              {meta.label}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-fg-3">
            <span className="font-mono">{bot.selfId}</span>
            <span>{bot.platform}</span>
            <span className="flex items-center gap-1">
              <Link2 className="size-3.5" />
              {bot.connection}
              {bot.url && <span className="font-mono">{bot.url}</span>}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button disabled={bot.status !== 'online'} onClick={() => onSend()}>
            <Send className="size-3.5" />
            发消息
          </Button>
          <Button variant="ghost" disabled={bot.status !== 'online'} onClick={() => setExpanded(!expanded)}>
            <Users className="size-3.5" />
            群列表
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={softSpring}>
              <ChevronDown className="size-3.5" />
            </motion.span>
          </Button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <GroupList bot={bot} onSend={(groupId) => onSend({ type: 'group', id: groupId })} />
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

function GroupList({ bot, onSend }: { bot: BotView; onSend: (groupId: string) => void }) {
  const groups = useQuery({ queryKey: ['groups', bot.platform, bot.selfId], queryFn: () => api.groups(bot) })
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (groups.data ?? []).filter(
      (group) =>
        !keyword || group.groupName.toLowerCase().includes(keyword) || group.groupId.includes(keyword),
    )
  }, [groups.data, query])

  return (
    <div className="border-t border-border bg-surface-2/40 px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-fg-3">
          {groups.data ? `共 ${groups.data.length} 个群` : '加载中…'}
        </span>
        <Input
          icon={<Search />}
          placeholder="搜索群名或群号"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-56"
        />
      </div>
      {groups.isPending ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : groups.error ? (
        <p className="text-[13px] text-danger">{groups.error.message}</p>
      ) : (
        <motion.ul
          variants={stagger}
          initial="initial"
          animate="animate"
          className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2"
        >
          {filtered.map((group) => (
            <motion.li
              key={group.groupId}
              variants={staggerItem}
              className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-[12px] font-medium text-fg-2">
                {group.groupName.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{group.groupName}</div>
                <div className="font-mono text-[11.5px] text-fg-3">
                  {group.groupId}
                  {group.memberCount !== undefined && ` · ${formatNumber(group.memberCount)} 人`}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`向 ${group.groupName} 发送消息`}
                className="opacity-0 group-hover:opacity-100"
                onClick={() => onSend(group.groupId)}
              >
                <Send className="size-3.5" />
              </Button>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  )
}

function SendDialog({
  state,
  onClose,
}: {
  state: { bot: BotView; target?: Target } | null
  onClose: () => void
}) {
  const [type, setType] = useState<Target['type']>('group')
  const [id, setId] = useState('')
  const [text, setText] = useState('')
  const [lastState, setLastState] = useState(state)
  if (state !== lastState) {
    // Prefill when the dialog opens for a specific target.
    setLastState(state)
    if (state?.target) {
      setType(state.target.type)
      setId(state.target.id)
    }
  }
  const send = useMutation({
    mutationFn: api.send,
    onSuccess: () => {
      toast.success('已发送')
      setText('')
      onClose()
    },
  })
  const valid = isValidId(id) && text.trim().length > 0
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!state || !valid) return
    send.mutate({
      platform: state.bot.platform,
      selfId: state.bot.selfId,
      target: { type, id: id.trim() },
      message: text,
    })
  }
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => !open && onClose()}
      title="发送消息"
      description={state ? `以 ${state.bot.nickname ?? state.bot.selfId} 的身份发送` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={send.isPending} disabled={!valid} onClick={() => submit()}>
            <Send className="size-3.5" />
            发送
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: 'group', label: '群聊' },
            { value: 'private', label: '私聊' },
          ]}
        />
        <Field label={type === 'group' ? '群 ID' : '用户 ID'} htmlFor="send-id">
          <Input
            id="send-id"
            inputMode="numeric"
            value={id}
            onChange={(event) => setId(event.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="内容" htmlFor="send-text" hint="按纯文本发送">
          <Textarea
            id="send-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
            }}
          />
        </Field>
      </form>
    </Dialog>
  )
}
