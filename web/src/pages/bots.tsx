import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, Minus, Plus, Radio, Search, Send } from 'lucide-react'
import { motion } from 'motion/react'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Avatar } from '../components/avatar.tsx'
import { Button } from '../components/ui/button.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Field, Input, Textarea } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { type CapabilityRow, capabilityRows } from '../lib/capabilities.ts'
import { formatNumber } from '../lib/format.ts'
import { groupPath } from '../lib/groups.ts'
import { botPath } from '../lib/management.ts'
import { stagger, staggerItem } from '../lib/motion.ts'
import { isValidId } from '../lib/platform.ts'
import { Link, navigate, usePath } from '../lib/router.tsx'
import type { BotView, ChannelTarget } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { BotDetailPage } from './bot-detail.tsx'
import { ConnectionsPage, RobotTabs } from './connections.tsx'

export function BotsPage() {
  const path = usePath()
  if (path.startsWith('/bots/connections')) return <ConnectionsPage />
  if (path !== '/bots') return <BotDetailPage key={path.split('/').slice(0, 4).join('/')} />
  return <BotList />
}

function BotList() {
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots })
  return (
    <>
      <PageHeader
        title="机器人"
        description="管理机器人账号与平台连接"
        actions={
          <Button variant="primary" onClick={() => navigate('/bots/connections/new')}>
            <Plus className="size-4" />
            添加连接
          </Button>
        }
      />
      <RobotTabs view="bots" />
      {bots.error ? (
        <ErrorState error={bots.error} onRetry={() => void bots.refetch()} />
      ) : !bots.data ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : !bots.data.length ? (
        <Card>
          <EmptyState
            icon={<Radio />}
            title="还没有机器人"
            description="添加平台连接后，成功登录的机器人会显示在这里。连接失败时可以在“连接”中查看原因。"
            action={<Button onClick={() => navigate('/bots/connections')}>查看连接</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {bots.data.map((bot) => (
            <Link to={botPath(bot)} key={`${bot.platform}:${bot.selfId}`} className="block">
              <Card className="flex items-center gap-4 p-5 transition-colors hover:border-border-strong">
                <Avatar id={bot.selfId} name={bot.nickname} src={bot.avatar} size={48} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[15px] font-semibold">{bot.nickname || bot.selfId}</span>
                    <Badge
                      tone={
                        bot.status === 'online'
                          ? 'success'
                          : bot.status === 'connecting'
                            ? 'warning'
                            : 'neutral'
                      }
                      dot
                    >
                      {bot.status === 'online' ? '在线' : bot.status === 'connecting' ? '连接中' : '离线'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[12px] text-fg-3">{bot.platform}</p>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-fg-3">{bot.selfId}</p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-fg-3" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

export function CapabilityPanel({
  capabilities,
  adapter = false,
}: {
  capabilities: BotView['capabilities']
  adapter?: boolean
}) {
  const { segments, styles, actions } = capabilityRows(capabilities)
  return (
    <div className="space-y-4 border-t border-border bg-surface-2/40 px-5 py-4">
      <p className="text-[12.5px] leading-relaxed text-fg-3">
        {adapter ? '适配器声明的实现范围，具体机器人能力以机器人详情为准。' : '机器人上报的消息与操作能力。'}
        平台应用授权需在平台侧配置。
      </p>
      <CapabilityGroup title="消息内容" rows={segments} />
      <CapabilityGroup title="文本样式" rows={styles} />
      <CapabilityGroup title="操作" rows={actions} />
    </div>
  )
}

function CapabilityGroup({ title, rows }: { title: string; rows: CapabilityRow[] }) {
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-fg-2">{title}</div>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((row) => (
          <li
            key={row.key}
            title={row.key}
            className={cn(
              'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px]',
              row.supported
                ? 'border-border bg-surface text-fg'
                : 'border-dashed border-border text-fg-3 line-through decoration-fg-3/50',
            )}
          >
            {row.supported ? (
              <Check className="size-3 text-success" />
            ) : (
              <Minus className="size-3 text-fg-3" />
            )}
            {row.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function GroupList({ bot, onSend }: { bot: BotView; onSend: (groupId: string) => void }) {
  const groups = useQuery({
    queryKey: ['bot-groups', bot.platform, bot.selfId],
    queryFn: () => api.botGroups(bot),
  })
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
              <Link
                className="text-[12px] text-accent"
                to={groupPath(`${bot.platform}:${bot.selfId}:group:${group.groupId}`)}
              >
                群设置
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`向 ${group.groupName} 发送消息`}
                className="shrink-0"
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

export function SendDialog({
  state,
  onClose,
}: {
  state: { bot: BotView; target?: ChannelTarget } | null
  onClose: () => void
}) {
  const [type, setType] = useState<ChannelTarget['type']>('group')
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
      target: { platform: state.bot.platform, selfId: state.bot.selfId, type, id: id.trim() },
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
