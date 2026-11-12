import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FlaskConical, Search, TerminalSquare } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Badge, Card, EmptyState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { api } from '../lib/api.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { navigate } from '../lib/router.tsx'
import type { CommandView } from '../lib/types.ts'
import { playgroundDraft } from '../lib/ui-state.ts'
import { cn } from '../lib/utils.ts'

export function CommandsPage() {
  const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands })
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const filtered = (commands.data ?? []).filter(
      (command) =>
        (showHidden || !command.hidden) &&
        (!keyword ||
          command.path.toLowerCase().includes(keyword) ||
          command.description.toLowerCase().includes(keyword) ||
          command.aliases.some((alias) => alias.toLowerCase().includes(keyword))),
    )
    const byOwner = new Map<string, CommandView[]>()
    for (const command of filtered)
      byOwner.set(command.owner, [...(byOwner.get(command.owner) ?? []), command])
    return [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [commands.data, query, showHidden])

  return (
    <>
      <PageHeader title="命令" description="所有插件注册的命令，点击展开查看参数和示例" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          icon={<Search />}
          placeholder="搜索命令、别名或说明"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-72"
        />
        <div className="ml-auto flex items-center gap-2 text-[13px] text-fg-2">
          <Switch id="show-hidden" checked={showHidden} onCheckedChange={setShowHidden} />
          <label htmlFor="show-hidden" className="cursor-pointer">
            显示隐藏命令
          </label>
        </div>
      </div>
      {!commands.data ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon={<TerminalSquare />} title="没有匹配的命令" />
        </Card>
      ) : (
        <motion.div variants={stagger} initial="initial" animate="animate" className="space-y-4">
          {groups.map(([owner, list]) => (
            <motion.div key={owner} variants={staggerItem}>
              <Card className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-border bg-surface-2/50 px-5 py-2.5">
                  <span className="text-[13px] font-semibold">{owner}</span>
                  <span className="text-[12px] text-fg-3">{list.length} 条</span>
                </div>
                <ul className="divide-y divide-border">
                  {list.map((command) => (
                    <CommandRow key={command.path} command={command} />
                  ))}
                </ul>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
    </>
  )
}

function CommandRow({ command }: { command: CommandView }) {
  const [open, setOpen] = useState(false)
  const expandable = command.options.length > 0 || command.examples.length > 0
  return (
    <li>
      <div className="group flex items-center gap-3 px-5 py-3">
        <button
          type="button"
          onClick={() => expandable && setOpen(!open)}
          className={cn('flex min-w-0 flex-1 items-center gap-3 text-left', expandable && 'cursor-pointer')}
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={softSpring}
            className={cn('text-fg-3', !expandable && 'invisible')}
          >
            <ChevronRight className="size-3.5" />
          </motion.span>
          <code className="shrink-0 font-mono text-[13px] font-medium text-fg">{command.usage}</code>
          <span className="truncate text-[13px] text-fg-3">{command.description}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {command.aliases.slice(0, 2).map((alias) => (
            <Badge key={alias}>{alias}</Badge>
          ))}
          {command.permission && <Badge tone="warning">权限</Badge>}
          {command.scope !== 'all' && (
            <Badge tone="info">{command.scope === 'group' ? '群聊' : '私聊'}</Badge>
          )}
          {command.hidden && <Badge>隐藏</Badge>}
          <Button
            variant="soft"
            size="sm"
            className="ml-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => {
              playgroundDraft.set(`/${command.path} `)
              navigate('/playground')
            }}
          >
            <FlaskConical className="size-3.5" />
            试用
          </Button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div className="grid gap-4 px-5 pb-4 pl-12 sm:grid-cols-2">
              {command.options.length > 0 && (
                <div>
                  <div className="mb-2 text-[11.5px] font-medium tracking-wide text-fg-3">选项</div>
                  <ul className="space-y-1.5">
                    {command.options.map((option) => (
                      <li key={option.flags.join(',')} className="text-[12.5px]">
                        <code className="font-mono text-fg">{option.flags.join(', ')}</code>
                        {option.description && <span className="ml-2 text-fg-3">{option.description}</span>}
                        {option.default !== undefined && (
                          <span className="ml-2 text-fg-3">（默认 {JSON.stringify(option.default)}）</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {command.examples.length > 0 && (
                <div>
                  <div className="mb-2 text-[11.5px] font-medium tracking-wide text-fg-3">示例</div>
                  <ul className="space-y-1.5">
                    {command.examples.map((example) => (
                      <li key={example}>
                        <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px] text-fg">
                          {example}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}
