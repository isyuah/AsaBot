import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronRight,
  FlaskConical,
  PencilLine,
  RotateCcw,
  Search,
  TerminalSquare,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ListControl } from '../components/schema-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Field, Input } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { Select } from '../components/ui/select.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { ApiError, api } from '../lib/api.ts'
import { groupPath, parseGroupKey } from '../lib/groups.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { Link, navigate } from '../lib/router.tsx'
import type { CommandOverride, CommandPermission, CommandView, CooldownScope } from '../lib/types.ts'
import { playgroundDraft } from '../lib/ui-state.ts'
import { cn } from '../lib/utils.ts'

const permissionLabels: Record<CommandPermission, string> = {
  everyone: '所有人',
  'group.admin': '群管理员',
  'group.owner': '群主',
  superuser: '超管',
}
const scopeLabels: Record<CooldownScope, string> = { user: '每个用户', group: '每个群', global: '全局' }

/** CommandView fields describe what the plugin declared; the override is layered on top here. */
function effective(command: CommandView) {
  const override = command.override ?? {}
  return {
    enabled: override.enabled !== false,
    hidden: override.hidden ?? command.hidden,
    aliases: [...command.aliases, ...(override.aliases ?? [])],
    permission:
      override.permission !== undefined
        ? override.permission === 'everyone'
          ? undefined
          : permissionLabels[override.permission]
        : command.permission
          ? '插件限定'
          : undefined,
    cooldown:
      override.cooldown === undefined || override.cooldown === false
        ? undefined
        : `${override.cooldown.duration} / ${scopeLabels[override.cooldown.scope ?? 'user']}`,
    modified: command.override !== undefined && Object.keys(command.override).length > 0,
  }
}

function useCommandMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ path, override }: { path: string; override: CommandOverride | null }) =>
      api.setCommandOverride(path, override),
    meta: { silent: true },
    onSuccess: (next) => {
      client.setQueryData<CommandView[]>(['commands'], (list = []) =>
        list.map((item) => (item.path === next.path ? next : item)),
      )
      void client.invalidateQueries({ queryKey: ['plugins'] })
    },
  })
}

export function CommandsPage() {
  const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands })
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const filtered = (commands.data ?? []).filter((command) => {
      const state = effective(command)
      return (
        (showHidden || !state.hidden) &&
        (!keyword ||
          command.path.toLowerCase().includes(keyword) ||
          command.description.toLowerCase().includes(keyword) ||
          state.aliases.some((alias) => alias.toLowerCase().includes(keyword)))
      )
    })
    const byOwner = new Map<string, CommandView[]>()
    for (const command of filtered)
      byOwner.set(command.owner, [...(byOwner.get(command.owner) ?? []), command])
    return [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [commands.data, query, showHidden])

  const editingCommand = commands.data?.find((command) => command.path === editing)

  return (
    <>
      <PageHeader
        title="命令"
        description="所有插件注册的命令。可以停用命令，或者修改别名、权限和冷却，不需要改插件代码"
      />
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
      {commands.error && !commands.data ? (
        <Card>
          <ErrorState
            error={commands.error}
            onRetry={() => void commands.refetch()}
            retrying={commands.isFetching}
          />
        </Card>
      ) : !commands.data ? (
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
                    <CommandRow
                      key={command.path}
                      command={command}
                      onEdit={() => setEditing(command.path)}
                    />
                  ))}
                </ul>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
      <OverrideDialog command={editingCommand} onClose={() => setEditing(null)} />
    </>
  )
}

function CommandRow({ command, onEdit }: { command: CommandView; onEdit: () => void }) {
  const [open, setOpen] = useState(false)
  const state = effective(command)
  const mutation = useCommandMutation()
  const expandable = command.options.length > 0 || command.examples.length > 0
  const toggle = (enabled: boolean) => {
    const { enabled: _previous, ...rest } = command.override ?? {}
    const next: CommandOverride = enabled ? rest : { ...rest, enabled: false }
    mutation.mutate(
      { path: command.path, override: Object.keys(next).length > 0 ? next : null },
      {
        onSuccess: () => toast.success(enabled ? `已启用 /${command.path}` : `已停用 /${command.path}`),
        onError: (error) => toast.error(error.message),
      },
    )
  }
  return (
    <li className={cn('transition-opacity', !state.enabled && 'opacity-60')}>
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
          <code
            className={cn(
              'shrink-0 font-mono text-[13px] font-medium',
              state.enabled ? 'text-fg' : 'text-fg-3 line-through',
            )}
          >
            {command.usage}
          </code>
          <span className="truncate text-[13px] text-fg-3">{command.description}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {command.overrideIssues.length > 0 && (
            <span title={command.overrideIssues.join('\n')}>
              <Badge tone="danger">
                <AlertTriangle className="size-3" />
                覆盖有冲突
              </Badge>
            </span>
          )}
          {state.modified && <Badge tone="accent">已修改</Badge>}
          {state.aliases.slice(0, 2).map((alias) => (
            <Badge key={alias}>{alias}</Badge>
          ))}
          {state.aliases.length > 2 && <Badge>+{state.aliases.length - 2}</Badge>}
          {state.permission && <Badge tone="warning">{state.permission}</Badge>}
          {state.cooldown && <Badge tone="info">冷却 {state.cooldown}</Badge>}
          {command.scope !== 'all' && (
            <Badge tone="info">{command.scope === 'group' ? '群聊' : '私聊'}</Badge>
          )}
          {command.disabledGroups.length > 0 && <Badge>{command.disabledGroups.length} 个群停用</Badge>}
          {state.hidden && <Badge>隐藏</Badge>}
          <div className="ml-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <PencilLine className="size-3.5" />
              编辑
            </Button>
            <Button
              variant="soft"
              size="sm"
              disabled={!state.enabled}
              onClick={() => {
                playgroundDraft.set(`/${command.path} `)
                navigate('/playground')
              }}
            >
              <FlaskConical className="size-3.5" />
              试用
            </Button>
          </div>
          <Switch
            aria-label={`启用 /${command.path}`}
            checked={state.enabled}
            disabled={mutation.isPending}
            onCheckedChange={toggle}
            className="ml-2"
          />
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

type Tri = 'default' | 'yes' | 'no'
type CooldownMode = 'default' | 'off' | 'custom'

interface Draft {
  enabled: boolean
  aliases: string[]
  permission: CommandPermission | 'default'
  cooldownMode: CooldownMode
  cooldownDuration: string
  cooldownScope: CooldownScope
  hidden: Tri
}

function toDraft(command: CommandView): Draft {
  const override = command.override ?? {}
  const cooldown = override.cooldown
  return {
    enabled: override.enabled !== false,
    aliases: override.aliases ?? [],
    permission: override.permission ?? 'default',
    cooldownMode: cooldown === undefined ? 'default' : cooldown === false ? 'off' : 'custom',
    cooldownDuration: cooldown ? String(cooldown.duration) : '10s',
    cooldownScope: cooldown ? (cooldown.scope ?? 'user') : 'user',
    hidden: override.hidden === undefined ? 'default' : override.hidden ? 'yes' : 'no',
  }
}

function fromDraft(draft: Draft): CommandOverride | null {
  const override: CommandOverride = {}
  if (!draft.enabled) override.enabled = false
  if (draft.aliases.length > 0) override.aliases = draft.aliases
  if (draft.permission !== 'default') override.permission = draft.permission
  if (draft.cooldownMode === 'off') override.cooldown = false
  if (draft.cooldownMode === 'custom')
    override.cooldown = { duration: draft.cooldownDuration.trim(), scope: draft.cooldownScope }
  if (draft.hidden !== 'default') override.hidden = draft.hidden === 'yes'
  return Object.keys(override).length > 0 ? override : null
}

function OverrideDialog({ command, onClose }: { command: CommandView | undefined; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [source, setSource] = useState<CommandView | undefined>(undefined)
  if (command !== source) {
    // Reset the draft whenever the dialog opens for another command (or closes).
    setSource(command)
    setDraft(command ? toDraft(command) : null)
  }
  const mutation = useCommandMutation()
  const client = useQueryClient()
  const restoreGroup = useMutation({
    mutationFn: ({ path, groupKey }: { path: string; groupKey: string }) =>
      api.setCommandGroup(path, groupKey, true),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['commands'] }),
  })
  const patch = (next: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...next } : current))
  const durationValid = draft?.cooldownMode !== 'custom' || draft.cooldownDuration.trim().length > 0
  const save = (override: CommandOverride | null) => {
    if (!command) return
    mutation.mutate(
      { path: command.path, override },
      {
        onSuccess: (next) => {
          if (next.overrideIssues.length > 0) toast.warning(next.overrideIssues.join('；'))
          else toast.success(override === null ? '已恢复插件默认设置' : '已保存')
          onClose()
        },
        onError: (error) =>
          toast.error(
            error instanceof ApiError && error.issues.length > 0
              ? error.issues.map((issue) => issue.message).join('；')
              : error.message,
          ),
      },
    )
  }
  return (
    <Dialog
      open={command !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title={command ? `/${command.path}` : ''}
      description="这里的设置覆盖插件自己的声明，保存后立即生效，不需要重载插件"
      footer={
        <>
          {command?.override && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => save(null)}
              disabled={mutation.isPending}
            >
              <RotateCcw className="size-3.5" />
              恢复默认
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={!draft || !durationValid}
            onClick={() => draft && save(fromDraft(draft))}
          >
            保存
          </Button>
        </>
      }
    >
      {command && draft && (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
            <div>
              <div className="text-[13px] font-medium">启用</div>
              <p className="mt-0.5 text-[12px] text-fg-3">
                停用后对所有人（包括超管）都不可用，消息交给其他处理器。
              </p>
            </div>
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
          </div>

          <Field
            label="追加别名"
            htmlFor="override-aliases"
            hint={
              command.aliases.length > 0
                ? `插件自带：${command.aliases.join('、')}。别名是完整路径，例如“重载插件”或“plugin rl”`
                : '别名是完整路径，例如“重载插件”或“plugin rl”'
            }
          >
            <ListControl
              id="override-aliases"
              value={draft.aliases}
              onChange={(value) => patch({ aliases: (value as string[]).map(String) })}
            />
          </Field>

          <Field
            label="权限"
            htmlFor="override-permission"
            hint={command.permission ? '插件为这条命令声明了权限规则' : '插件没有限制权限'}
          >
            <Select
              aria-label="权限"
              value={draft.permission}
              onValueChange={(permission) => patch({ permission })}
              options={[
                { value: 'default', label: '插件默认' },
                { value: 'everyone', label: '所有人' },
                { value: 'group.admin', label: '群管理员（含群主）' },
                { value: 'group.owner', label: '群主' },
                { value: 'superuser', label: '仅超管' },
              ]}
            />
          </Field>

          <Field label="冷却" htmlFor="override-cooldown" hint="超管不受冷却限制">
            <div className="space-y-2.5">
              <Segmented
                value={draft.cooldownMode}
                onChange={(cooldownMode) => patch({ cooldownMode })}
                options={[
                  { value: 'default', label: '插件默认' },
                  { value: 'off', label: '取消冷却' },
                  { value: 'custom', label: '自定义' },
                ]}
              />
              {draft.cooldownMode === 'custom' && (
                <div className="flex gap-2">
                  <Input
                    id="override-cooldown"
                    placeholder="例如 30s、5m"
                    value={draft.cooldownDuration}
                    onChange={(event) => patch({ cooldownDuration: event.target.value })}
                    className="w-36 font-mono"
                  />
                  <Select
                    aria-label="冷却范围"
                    value={draft.cooldownScope}
                    onValueChange={(cooldownScope) => patch({ cooldownScope })}
                    options={(Object.keys(scopeLabels) as CooldownScope[]).map((value) => ({
                      value,
                      label: scopeLabels[value],
                    }))}
                  />
                </div>
              )}
            </div>
          </Field>

          <Field label="在帮助中" htmlFor="override-hidden">
            <Segmented
              value={draft.hidden}
              onChange={(hidden) => patch({ hidden })}
              options={[
                { value: 'default', label: command.hidden ? '插件默认（隐藏）' : '插件默认（显示）' },
                { value: 'no', label: '显示' },
                { value: 'yes', label: '隐藏' },
              ]}
            />
          </Field>

          {command.disabledGroups.length > 0 && (
            <div>
              <div className="mb-2 text-[13px] font-medium">已在这些群停用</div>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {command.disabledGroups.map((groupKey) => {
                  const { platform, groupId } = parseGroupKey(groupKey)
                  return (
                    <li key={groupKey} className="flex items-center justify-between px-3.5 py-2">
                      <Link to={groupPath(groupKey)} className="min-w-0 hover:underline">
                        <span className="font-mono text-[12.5px]">{groupId}</span>
                        <span className="ml-2 text-[11.5px] text-fg-3">{platform}</span>
                      </Link>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={restoreGroup.isPending && restoreGroup.variables?.groupKey === groupKey}
                        onClick={() => restoreGroup.mutate({ path: command.path, groupKey })}
                      >
                        恢复
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {command.overrideIssues.length > 0 && (
            <div className="rounded-xl bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
              {command.overrideIssues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
