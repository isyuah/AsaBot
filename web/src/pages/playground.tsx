import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowUp, Crown, Eraser, FlaskConical, Shield, Sparkles, User } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Avatar } from '../components/avatar.tsx'
import { Logo } from '../components/layout/logo.tsx'
import { Button } from '../components/ui/button.tsx'
import { Field, Input } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { Card, CardHeader, PageHeader } from '../components/ui/primitives.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { api } from '../lib/api.ts'
import { formatClock } from '../lib/format.ts'
import { softSpring, spring } from '../lib/motion.ts'
import type { PlaygroundRequest, Segment } from '../lib/types.ts'
import { playgroundDraft, usePlaygroundDraft } from '../lib/ui-state.ts'
import { cn } from '../lib/utils.ts'

type Role = 'member' | 'admin' | 'owner'

interface Entry {
  id: number
  from: 'user' | 'bot' | 'system'
  time: number
  text?: string
  message?: Segment[]
}

let nextId = 0

export function PlaygroundPage() {
  const draft = usePlaygroundDraft()
  const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands })
  const [userId, setUserId] = useState('10001')
  const [nickname, setNickname] = useState('测试用户')
  const [role, setRole] = useState<Role>('member')
  const [superuser, setSuperuser] = useState(false)
  const [mode, setMode] = useState<'group' | 'private'>('group')
  const [groupId, setGroupId] = useState('10000')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
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

  const send = useMutation({
    mutationFn: (request: PlaygroundRequest) => api.playground(request),
    meta: { silent: true },
    onSuccess: ({ replies }) => {
      const now = Date.now()
      setEntries((list) => [
        ...list,
        ...(replies.length === 0
          ? [{ id: nextId++, from: 'system' as const, time: now, text: '没有回复' }]
          : replies.map((reply) => ({
              id: nextId++,
              from: 'bot' as const,
              time: now,
              message: reply.message,
              text: reply.text,
            }))),
      ])
    },
    onError: (error) =>
      setEntries((list) => [
        ...list,
        { id: nextId++, from: 'system', time: Date.now(), text: `出错了：${error.message}` },
      ]),
  })

  const submit = (text = input) => {
    const content = text.trim()
    if (!content || send.isPending) return
    setEntries((list) => [...list, { id: nextId++, from: 'user', time: Date.now(), text: content }])
    setInput('')
    send.mutate({
      text: content,
      user: { id: userId, nickname, role: mode === 'group' ? role : undefined, superuser },
      group: mode === 'group' ? groupId : null,
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const suggestions = (commands.data ?? []).filter((command) => !command.hidden).slice(0, 8)

  return (
    <>
      <PageHeader
        title="调试台"
        description="模拟用户给机器人发消息，消息会走真实的插件和命令，但不会发到 QQ"
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
              <div className="flex items-center justify-between rounded-xl border border-border px-3.5 py-2.5">
                <label htmlFor="pg-superuser" className="cursor-pointer">
                  <span className="block text-[13px] font-medium">超管</span>
                  <span className="text-[12px] text-fg-3">仅在调试台内生效</span>
                </label>
                <Switch id="pg-superuser" checked={superuser} onCheckedChange={setSuperuser} />
              </div>
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
            </div>
          </Card>
        </div>

        <Card className="flex h-[calc(100vh-200px)] min-h-[520px] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2.5">
              <Logo className="size-6" />
              <div className="leading-tight">
                <div className="text-[13.5px] font-semibold">AsaBot</div>
                <div className="text-[11.5px] text-fg-3">
                  {mode === 'group' ? `群 ${groupId}` : `与 ${nickname} 私聊`}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" disabled={entries.length === 0} onClick={() => setEntries([])}>
              <Eraser className="size-3.5" />
              清空
            </Button>
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
                  <Bubble key={entry.id} entry={entry} userId={userId} nickname={nickname} />
                ))}
              </AnimatePresence>
            )}
            <AnimatePresence>{send.isPending && <TypingIndicator key="typing" />}</AnimatePresence>
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
            <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-2/50 p-1.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder="输入消息，回车发送，Shift + 回车换行"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onKeyDown}
                className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-2.5 py-2 text-[13.5px] leading-5 outline-none [field-sizing:content] placeholder:text-fg-3"
              />
              <Button
                variant="primary"
                size="icon"
                aria-label="发送"
                disabled={!input.trim()}
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
        多轮对话（比如猜数）也可以：机器人提问后，直接继续发消息回答即可。
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

function Bubble({ entry, userId, nickname }: { entry: Entry; userId: string; nickname: string }) {
  if (entry.from === 'system') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={softSpring}
        className="flex justify-center"
      >
        <span className="rounded-full bg-surface-2 px-3 py-1 text-[12px] text-fg-3">{entry.text}</span>
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
      className={cn('flex items-end gap-2.5', mine && 'flex-row-reverse')}
    >
      {mine ? <Avatar id={userId} name={nickname} size={28} /> : <Logo className="size-7 shrink-0" />}
      <div className={cn('flex max-w-[72%] flex-col gap-1', mine ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap',
            mine
              ? 'rounded-br-md bg-accent text-accent-fg'
              : 'rounded-bl-md border border-border bg-surface-2 text-fg',
          )}
        >
          {entry.message ? <Segments message={entry.message} /> : entry.text}
        </div>
        <span className="px-1 text-[11px] text-fg-3 tabular">{formatClock(entry.time, false)}</span>
      </div>
    </motion.div>
  )
}

function Segments({ message }: { message: Segment[] }) {
  return (
    <>
      {message.map((segment, index) => {
        const key = `${segment.type}-${index}`
        switch (segment.type) {
          case 'text':
            return <span key={key}>{String(segment.data.text)}</span>
          case 'at':
            return (
              <span key={key} className="mx-0.5 rounded bg-accent-soft px-1 text-accent-soft-fg">
                @{segment.data.qq === 'all' ? '全体成员' : String(segment.data.qq)}
              </span>
            )
          case 'image': {
            const source = String(segment.data.url ?? segment.data.file ?? '')
            const src = source.startsWith('base64://') ? `data:image/png;base64,${source.slice(9)}` : source
            return /^(https?:|data:)/.test(src) ? (
              <img key={key} src={src} alt="图片" className="my-1 max-h-60 rounded-lg" />
            ) : (
              <span key={key} className="text-fg-3">
                [图片]
              </span>
            )
          }
          case 'face':
            return (
              <span key={key} className="text-fg-3">
                [表情]
              </span>
            )
          case 'reply':
            return null
          default:
            return (
              <span key={key} className="text-fg-3">
                [{segment.type}]
              </span>
            )
        }
      })}
    </>
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
