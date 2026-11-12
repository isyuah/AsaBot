import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowUp,
  AtSign,
  BellRing,
  Crown,
  Eraser,
  FlaskConical,
  Hand,
  ImagePlus,
  LogIn,
  LogOut,
  MessageSquareReply,
  MicOff,
  Reply,
  Shield,
  Sparkles,
  Trash2,
  User,
  UserPlus,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Avatar } from '../components/avatar.tsx'
import { Logo } from '../components/layout/logo.tsx'
import { Segments } from '../components/segments.tsx'
import { TraceView } from '../components/trace.tsx'
import { Button } from '../components/ui/button.tsx'
import { Field, Input } from '../components/ui/input.tsx'
import { Menu, MenuItem, MenuSeparator, Segmented } from '../components/ui/misc.tsx'
import { Card, CardHeader, PageHeader } from '../components/ui/primitives.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { api } from '../lib/api.ts'
import { formatClock } from '../lib/format.ts'
import { softSpring, spring } from '../lib/motion.ts'
import type {
  BotCapabilities,
  DispatchTrace,
  LogRecord,
  PlaygroundEventName,
  PlaygroundResult,
  PlaygroundUser,
  Segment,
} from '../lib/types.ts'
import { playgroundDraft, usePlaygroundDraft } from '../lib/ui-state.ts'
import { cn } from '../lib/utils.ts'

type Role = 'member' | 'admin' | 'owner'

interface Entry {
  id: number
  from: 'user' | 'bot' | 'system'
  time: number
  text?: string
  message?: Segment[]
  /** Platform message ID (user messages and bot replies), so later messages can quote it. */
  messageId?: string
  /** Pipeline traces and logs of the events this user message or simulated event triggered. */
  traces?: DispatchTrace[]
  logs?: LogRecord[]
}

/** A plain-text platform: everything else is lowered by the core before "sending". */
const textOnly: Partial<BotCapabilities> = { segments: ['text'], textStyles: [] }
const maxImageBytes = 1.5 * 1024 * 1024

const eventMenu: { name: PlaygroundEventName; label: string; icon: ReactNode; group?: boolean }[] = [
  { name: 'notice.member.join', label: '加入群聊', icon: <LogIn />, group: true },
  { name: 'notice.member.leave', label: '退出群聊', icon: <LogOut />, group: true },
  { name: 'notice.member.mute', label: '被禁言 10 分钟', icon: <MicOff />, group: true },
  { name: 'notice.poke', label: '戳一戳机器人', icon: <Hand /> },
  { name: 'notice.message.recall', label: '撤回上一条消息', icon: <Trash2 /> },
  { name: 'request.friend', label: '申请加好友', icon: <UserPlus /> },
  { name: 'request.group.join', label: '申请加群', icon: <Users />, group: true },
  { name: 'request.group.invite', label: '邀请机器人进群', icon: <BellRing />, group: true },
]

let nextId = 0

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function PlaygroundPage() {
  const draft = usePlaygroundDraft()
  const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands })
  const [userId, setUserId] = useState('10001')
  const [nickname, setNickname] = useState('测试用户')
  const [role, setRole] = useState<Role>('member')
  const [superuser, setSuperuser] = useState(false)
  const [plainText, setPlainText] = useState(false)
  const [mode, setMode] = useState<'group' | 'private'>('group')
  const [groupId, setGroupId] = useState('10000')
  const [input, setInput] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [mentions, setMentions] = useState<string[]>([])
  const [mentionDraft, setMentionDraft] = useState('')
  const [replyTo, setReplyTo] = useState<Entry | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (draft === null) return
    setInput(draft)
    playgroundDraft.set(null)
    inputRef.current?.focus()
  }, [draft])

  useEffect(() => {
    if (entries.length > 0)
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [entries])

  const user = (): PlaygroundUser => ({
    id: userId,
    nickname,
    role: mode === 'group' ? role : undefined,
    superuser,
  })
  const capabilities = plainText ? textOnly : undefined

  /** Appends the bot's replies and recorded actions, and attaches traces/logs to the entry that caused them. */
  const applyResult = (sourceId: number, result: PlaygroundResult) => {
    const now = Date.now()
    setEntries((list) => [
      ...list.map((entry) =>
        entry.id === sourceId
          ? {
              ...entry,
              ...(result.incoming ? { messageId: result.incoming.messageId } : {}),
              traces: result.traces,
              logs: result.logs,
            }
          : entry,
      ),
      ...result.replies.map((reply) => ({
        id: nextId++,
        from: 'bot' as const,
        time: now,
        message: reply.message,
        text: reply.text,
        messageId: reply.messageId,
      })),
      ...result.actions.map((action) => ({
        id: nextId++,
        from: 'system' as const,
        time: now,
        text: `机器人执行了 ${action.action}${Object.keys(action.params).length > 0 ? ` ${JSON.stringify(action.params)}` : ''}`,
      })),
      ...(result.replies.length === 0 && result.actions.length === 0
        ? [{ id: nextId++, from: 'system' as const, time: now, text: '没有回复' }]
        : []),
    ])
  }
  const fail = (error: Error) =>
    setEntries((list) => [
      ...list,
      { id: nextId++, from: 'system', time: Date.now(), text: `出错了：${error.message}` },
    ])

  const send = useMutation({
    mutationFn: ({ message }: { sourceId: number; message: Segment[] }) =>
      api.playground({ message, user: user(), group: mode === 'group' ? groupId : null, capabilities }),
    meta: { silent: true },
    onSuccess: (result, { sourceId }) => applyResult(sourceId, result),
    onError: fail,
  })
  const simulate = useMutation({
    mutationFn: ({
      name,
      fields,
    }: {
      sourceId: number
      name: PlaygroundEventName
      fields?: Record<string, unknown>
    }) =>
      api.playgroundEvent({
        name,
        fields,
        user: user(),
        group: mode === 'group' ? groupId : null,
        capabilities,
      }),
    meta: { silent: true },
    onSuccess: (result, { sourceId }) => applyResult(sourceId, result),
    onError: fail,
  })
  const pending = send.isPending || simulate.isPending

  const submit = (text = input) => {
    const content = text.trim()
    if ((!content && !image) || pending) return
    const message: Segment[] = [
      ...(replyTo?.messageId ? [{ type: 'reply', data: { id: replyTo.messageId } }] : []),
      ...mentions.flatMap((id) => [
        { type: 'at', data: { id } },
        { type: 'text', data: { text: ' ' } },
      ]),
      ...(content ? [{ type: 'text', data: { text: content } }] : []),
      ...(image ? [{ type: 'image', data: { file: `base64://${image}` } }] : []),
    ]
    const sourceId = nextId++
    setEntries((list) => [...list, { id: sourceId, from: 'user', time: Date.now(), message, text: content }])
    setInput('')
    setImage(null)
    setMentions([])
    setReplyTo(null)
    send.mutate({ sourceId, message })
  }

  const fireEvent = (item: (typeof eventMenu)[number]) => {
    if (pending) return
    const lastOwn = [...entries].reverse().find((entry) => entry.from === 'user' && entry.messageId)
    if (item.name === 'notice.message.recall' && !lastOwn) return toast.error('还没有可以撤回的消息')
    const fields: Record<string, unknown> | undefined =
      item.name === 'notice.member.mute'
        ? { duration: 600_000 }
        : item.name === 'notice.poke'
          ? { targetId: 'playground' }
          : item.name === 'notice.message.recall'
            ? { messageId: lastOwn?.messageId }
            : item.name.startsWith('request.')
              ? { comment: '来自调试台的测试请求' }
              : undefined
    const sourceId = nextId++
    setEntries((list) => [
      ...list,
      { id: sourceId, from: 'system', time: Date.now(), text: `模拟事件：${item.label}` },
    ])
    simulate.mutate({ sourceId, name: item.name, ...(fields ? { fields } : {}) })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const attach = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return toast.error('只能附加图片')
    if (file.size > maxImageBytes) return toast.error('图片不能超过 1.5 MB')
    setImage(await readImage(file))
  }

  const byMessageId = (id: string) => entries.find((entry) => entry.messageId === id)
  const suggestions = (commands.data ?? []).filter((command) => !command.hidden).slice(0, 8)
  const canSend = (input.trim().length > 0 || image !== null) && !pending

  return (
    <>
      <PageHeader
        title="调试台"
        description="模拟用户给机器人发消息或触发事件，走真实的插件和命令，但不会发到任何聊天平台"
      />
      <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
        <div className="space-y-3">
          <Card>
            <CardHeader title="身份" description="以谁的身份发言" />
            <div className="space-y-4 px-5 pb-5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="用户 ID" htmlFor="pg-user">
                  <Input
                    id="pg-user"
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field label="昵称" htmlFor="pg-nick">
                  <Input
                    id="pg-nick"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                  />
                </Field>
              </div>
              <AnimatePresence initial={false}>
                {mode === 'group' && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={softSpring}
                    className="overflow-hidden"
                  >
                    <Field label="群角色">
                      <Segmented
                        className="w-full [&>button]:flex-1"
                        value={role}
                        onChange={setRole}
                        options={[
                          {
                            value: 'member',
                            label: <RoleLabel icon={<User className="size-3" />} text="成员" />,
                          },
                          {
                            value: 'admin',
                            label: <RoleLabel icon={<Shield className="size-3" />} text="管理员" />,
                          },
                          {
                            value: 'owner',
                            label: <RoleLabel icon={<Crown className="size-3" />} text="群主" />,
                          },
                        ]}
                      />
                    </Field>
                  </motion.div>
                )}
              </AnimatePresence>
              <ToggleRow
                id="pg-superuser"
                title="超管"
                description="仅在调试台内生效"
                checked={superuser}
                onChange={setSuperuser}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="会话" description="消息发在哪里" />
            <div className="space-y-4 px-5 pb-5">
              <Segmented
                className="w-full [&>button]:flex-1"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'group', label: '群聊' },
                  { value: 'private', label: '私聊' },
                ]}
              />
              <AnimatePresence initial={false}>
                {mode === 'group' && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={softSpring}
                    className="overflow-hidden"
                  >
                    <Field label="群号" htmlFor="pg-group" hint="群开关、白名单按这个群号判断">
                      <Input
                        id="pg-group"
                        value={groupId}
                        onChange={(event) => setGroupId(event.target.value)}
                        className="font-mono"
                      />
                    </Field>
                  </motion.div>
                )}
              </AnimatePresence>
              <ToggleRow
                id="pg-plain"
                title="模拟纯文本平台"
                description="图片、Markdown、按钮等会按平台能力降级"
                checked={plainText}
                onChange={setPlainText}
              />
            </div>
          </Card>
        </div>

        <Card className="flex h-[calc(100dvh-200px)] min-h-[520px] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2.5">
              <Logo className="size-6" />
              <div className="leading-tight">
                <div className="text-[13.5px] font-semibold">AsaBot</div>
                <div className="text-[11.5px] text-fg-3">
                  {mode === 'group' ? `群 ${groupId}` : `与 ${nickname} 私聊`}
                  {plainText && ' · 纯文本平台'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Menu
                trigger={
                  <Button variant="ghost" size="sm" disabled={pending}>
                    <BellRing className="size-3.5" />
                    模拟事件
                  </Button>
                }
              >
                {eventMenu.map((item, index) => (
                  <div key={item.name}>
                    {index === 3 && <MenuSeparator />}
                    <MenuItem
                      icon={item.icon}
                      disabled={item.group && mode !== 'group'}
                      onSelect={() => fireEvent(item)}
                    >
                      {item.label}
                    </MenuItem>
                  </div>
                ))}
              </Menu>
              <Button
                variant="ghost"
                size="sm"
                disabled={entries.length === 0}
                onClick={() => setEntries([])}
              >
                <Eraser className="size-3.5" />
                清空
              </Button>
            </div>
          </div>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-5">
            {entries.length === 0 ? (
              <Welcome
                suggestions={suggestions.map((command) => `/${command.path}`)}
                onPick={(text) => submit(text)}
              />
            ) : (
              <AnimatePresence initial={false}>
                {entries.map((entry) => (
                  <Bubble
                    key={entry.id}
                    entry={entry}
                    userId={userId}
                    nickname={nickname}
                    onQuote={entry.messageId ? () => setReplyTo(entry) : undefined}
                    renderReply={(id) => <QuotePreview entry={byMessageId(id)} />}
                  />
                ))}
              </AnimatePresence>
            )}
            <AnimatePresence>{pending && <TypingIndicator key="typing" />}</AnimatePresence>
          </div>

          <div className="border-t border-border p-3">
            {suggestions.length > 0 && entries.length > 0 && (
              <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
                {suggestions.map((command) => (
                  <button
                    key={command.path}
                    type="button"
                    onClick={() => {
                      setInput(`/${command.path} `)
                      inputRef.current?.focus()
                    }}
                    className="shrink-0 cursor-pointer rounded-lg border border-border bg-surface px-2 py-1 font-mono text-[12px] text-fg-2 transition-colors hover:border-border-strong hover:text-fg"
                  >
                    /{command.path}
                  </button>
                ))}
              </div>
            )}
            <AnimatePresence initial={false}>
              {(replyTo || mentions.length > 0 || image) && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={softSpring}
                  className="overflow-hidden"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {replyTo && (
                      <Chip icon={<Reply className="size-3" />} onRemove={() => setReplyTo(null)}>
                        回复：{replyTo.text?.slice(0, 24) || '[消息]'}
                      </Chip>
                    )}
                    {mentions.map((id) => (
                      <Chip
                        key={id}
                        icon={<AtSign className="size-3" />}
                        onRemove={() => setMentions((list) => list.filter((item) => item !== id))}
                      >
                        {id === 'playground' ? '机器人' : id}
                      </Chip>
                    ))}
                    {image && (
                      <Chip onRemove={() => setImage(null)}>
                        <img src={`data:image/*;base64,${image}`} alt="附图" className="h-6 rounded" />
                        图片
                      </Chip>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="flex items-end gap-1.5 rounded-xl border border-border bg-surface-2/50 p-1.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
              <Menu
                align="start"
                trigger={
                  <Button variant="ghost" size="icon" aria-label="提及" className="size-9 rounded-[10px]">
                    <AtSign className="size-4" />
                  </Button>
                }
              >
                <MenuItem
                  icon={<Sparkles />}
                  onSelect={() => setMentions((list) => [...new Set([...list, 'playground'])])}
                >
                  提及机器人
                </MenuItem>
                <MenuSeparator />
                <form
                  className="flex gap-1 p-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const id = mentionDraft.trim()
                    if (!id) return
                    setMentions((list) => [...new Set([...list, id])])
                    setMentionDraft('')
                  }}
                >
                  <Input
                    placeholder="用户 ID"
                    value={mentionDraft}
                    onChange={(event) => setMentionDraft(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="h-8 w-32 font-mono"
                  />
                  <Button type="submit" size="sm" variant="secondary">
                    添加
                  </Button>
                </form>
              </Menu>
              <Button
                variant="ghost"
                size="icon"
                aria-label="附加图片"
                className="size-9 rounded-[10px]"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="size-4" />
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  void attach(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder="输入消息，回车发送，Shift + 回车换行；可以直接粘贴图片"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onKeyDown}
                onPaste={(event) => {
                  const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'))
                  if (file) {
                    event.preventDefault()
                    void attach(file)
                  }
                }}
                className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[13.5px] leading-5 outline-none [field-sizing:content] placeholder:text-fg-3"
              />
              <Button
                variant="primary"
                size="icon"
                aria-label="发送"
                disabled={!canSend}
                loading={send.isPending}
                onClick={() => submit()}
                className="size-9 rounded-[10px]"
              >
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-2.5">
      <label htmlFor={id} className="cursor-pointer">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="text-[12px] text-fg-3">{description}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function Chip({ icon, children, onRemove }: { icon?: ReactNode; children: ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface py-0.5 pr-1 pl-2 text-[12px] text-fg-2">
      {icon}
      {children}
      <button
        type="button"
        aria-label="移除"
        onClick={onRemove}
        className="flex size-5 cursor-pointer items-center justify-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function RoleLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      {text}
    </span>
  )
}

function Welcome({ suggestions, onPick }: { suggestions: string[]; onPick: (text: string) => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={softSpring}
      className="flex h-full flex-col items-center justify-center text-center"
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-soft-fg">
        <FlaskConical className="size-5" />
      </div>
      <p className="text-[14px] font-medium">试试和机器人说点什么</p>
      <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-fg-3">
        多轮对话（比如猜数）也可以：机器人提问后，直接继续发消息回答即可。右上角可以模拟入群、戳一戳、好友申请等事件。
      </p>
      {suggestions.length > 0 && (
        <div className="mt-5 flex max-w-md flex-wrap justify-center gap-2">
          {suggestions.slice(0, 6).map((text, index) => (
            <motion.button
              key={text}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...softSpring, delay: 0.05 + index * 0.04 }}
              whileHover={{ y: -2 }}
              onClick={() => onPick(text)}
              className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-1.5 font-mono text-[12.5px] text-fg-2 shadow-card hover:border-border-strong hover:text-fg"
            >
              <Sparkles className="size-3 text-accent" />
              {text}
            </motion.button>
          ))}
        </div>
      )}
    </motion.div>
  )
}

function QuotePreview({ entry }: { entry: Entry | undefined }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border-l-2 border-current/40 bg-black/5 px-2 py-0.5 text-[12px] opacity-80 dark:bg-white/10">
      <MessageSquareReply className="size-3 shrink-0" />
      <span className="truncate">{entry ? entry.text || '[消息]' : '一条消息'}</span>
    </span>
  )
}

function Bubble({
  entry,
  userId,
  nickname,
  onQuote,
  renderReply,
}: {
  entry: Entry
  userId: string
  nickname: string
  onQuote?: () => void
  renderReply: (id: string) => ReactNode
}) {
  const [traceOpen, setTraceOpen] = useState(false)
  const traces = entry.traces ?? []
  const traceToggle = traces.length > 0 && (
    <button
      type="button"
      onClick={() => setTraceOpen(!traceOpen)}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded-md px-1 text-[11px] transition-colors',
        traceOpen ? 'text-accent' : 'text-fg-3 hover:text-fg-2',
      )}
    >
      <Workflow className="size-3" />
      处理链
    </button>
  )
  const tracePanel = (
    <AnimatePresence initial={false}>
      {traceOpen && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={softSpring}
          className="w-full overflow-hidden"
        >
          <div className="mt-1 space-y-4 rounded-xl border border-border bg-surface px-4 py-3 text-left">
            {traces.map((trace) => (
              <TraceView
                key={trace.eventId}
                trace={trace}
                logs={(entry.logs ?? []).filter((record) => record.eventId === trace.eventId)}
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  if (entry.from === 'system') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={softSpring}
        className="flex flex-col items-center gap-1"
      >
        <span className="flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-[12px] text-fg-3">
          {entry.text}
          {traceToggle}
        </span>
        <div className="w-full max-w-xl">{tracePanel}</div>
      </motion.div>
    )
  }
  const mine = entry.from === 'user'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.96, x: mine ? 10 : -10 }}
      animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
      transition={spring}
      className={cn('group flex items-start gap-2.5', mine && 'flex-row-reverse')}
    >
      {mine ? <Avatar id={userId} name={nickname} size={28} /> : <Logo className="size-7 shrink-0" />}
      <div className={cn('flex max-w-[72%] flex-col gap-1', mine ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap',
            mine
              ? 'rounded-tr-md bg-accent text-accent-fg'
              : 'rounded-tl-md border border-border bg-surface-2 text-fg',
          )}
        >
          {entry.message ? <Segments message={entry.message} renderReply={renderReply} /> : entry.text}
        </div>
        <div className={cn('flex items-center gap-1.5 px-1', mine && 'flex-row-reverse')}>
          <span className="text-[11px] text-fg-3 tabular">{formatClock(entry.time, false)}</span>
          {onQuote && (
            <button
              type="button"
              onClick={onQuote}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 text-[11px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg-2"
            >
              <Reply className="size-3" />
              引用
            </button>
          )}
          {traceToggle}
        </div>
        {tracePanel}
      </div>
    </motion.div>
  )
}

function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={softSpring}
      className="flex items-end gap-2.5"
    >
      <Logo className="size-7 shrink-0" />
      <div className="flex gap-1 rounded-2xl rounded-bl-md border border-border bg-surface-2 px-3.5 py-3">
        {[0, 1, 2].map((index) => (
          <motion.span
            key={index}
            className="size-1.5 rounded-full bg-fg-3"
            animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }}
            transition={{
              duration: 0.9,
              repeat: Number.POSITIVE_INFINITY,
              delay: index * 0.15,
              ease: 'easeInOut',
            }}
          />
        ))}
      </div>
    </motion.div>
  )
}
