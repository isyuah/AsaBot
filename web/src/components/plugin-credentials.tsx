import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Skeleton } from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Eye, Import, KeyRound, Plus, Trash2 } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, api } from '../lib/api.ts'
import { timeText } from '../lib/management.ts'
import type { PluginCredentialGroup, PluginCredentialInfo } from '../lib/types.ts'

type CredentialAction =
  | { kind: 'generate' | 'import'; group: PluginCredentialGroup }
  | { kind: 'reveal' | 'revoke'; item: PluginCredentialInfo }

export function PluginCredentialsTab({ name }: { name: string }) {
  const client = useQueryClient()
  const queryKey = ['pluginCredentials', name]
  const query = useQuery({ queryKey, queryFn: () => api.pluginCredentials(name), refetchOnWindowFocus: true })
  const [action, setAction] = useState<CredentialAction | null>(null)
  if (query.error && !query.data)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
  if (!query.data) return <Skeleton className="h-32" />
  const { groups, items } = query.data
  if (groups.length === 0 && items.length === 0)
    return <EmptyState icon={<KeyRound />} title="此插件没有凭据用途" className="py-10" />

  const declared = new Set(groups.map(({ id }) => id))
  const removed = [...new Set(items.filter(({ group }) => !declared.has(group)).map(({ group }) => group))]
  const sections: PluginCredentialGroup[] = [...groups, ...removed.map((id) => ({ id, title: id }))]
  const close = () => setAction(null)
  const saved = (revoked = false) => {
    close()
    void client.invalidateQueries({ queryKey })
    if (revoked) void client.invalidateQueries({ queryKey: ['plugins'] })
  }

  return (
    <div className="divide-y divide-border [&>section+section]:pt-5 [&>section:not(:last-of-type)]:pb-5">
      {sections.map((group) => {
        const available = declared.has(group.id)
        const records = items.filter((item) => item.group === group.id)
        return (
          <section key={group.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                  <span className="break-all">{group.title}</span>
                  {!available && <Badge tone="warning">用途不可用</Badge>}
                </h2>
                {group.description && <p className="mt-1 text-[12.5px] text-fg-3">{group.description}</p>}
              </div>
              {available && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    aria-label={`生成${group.title}凭据`}
                    onClick={() => setAction({ kind: 'generate', group })}
                  >
                    <Plus className="size-3.5" />
                    生成
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`导入${group.title}凭据`}
                    onClick={() => setAction({ kind: 'import', group })}
                  >
                    <Import className="size-3.5" />
                    导入
                  </Button>
                </div>
              )}
            </div>
            {records.length ? (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {records.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3.5 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                        <span className="break-all">{item.label}</span>
                        {available && !item.active && <Badge tone="warning">已停用</Badge>}
                      </div>
                      <time
                        dateTime={new Date(item.createdAt).toISOString()}
                        className="whitespace-nowrap text-[12px] text-fg-3 tabular"
                      >
                        {timeText(item.createdAt)}
                      </time>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`查看凭据 ${item.label}`}
                        onClick={() => setAction({ kind: 'reveal', item })}
                      >
                        <Eye className="size-3.5" />
                        查看
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        aria-label={`撤销凭据 ${item.label}`}
                        onClick={() => setAction({ kind: 'revoke', item })}
                      >
                        <Trash2 className="size-3.5" />
                        撤销
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-3.5 py-3 text-[12.5px] text-fg-3">
                还没有凭据
              </p>
            )}
          </section>
        )
      })}
      {(action?.kind === 'generate' || action?.kind === 'import') && (
        <CreateCredential
          name={name}
          group={action.group}
          mode={action.kind}
          onClose={close}
          onSaved={saved}
        />
      )}
      {action?.kind === 'reveal' && <RevealCredential name={name} item={action.item} onClose={close} />}
      {action?.kind === 'revoke' && (
        <RevokeCredential name={name} item={action.item} onClose={close} onSaved={() => saved(true)} />
      )}
    </div>
  )
}

function CreateCredential({
  name,
  group,
  mode,
  onClose,
  onSaved,
}: {
  name: string
  group: PluginCredentialGroup
  mode: 'generate' | 'import'
  onClose: () => void
  onSaved: () => void
}) {
  const id = useId()
  const title = mode === 'generate' ? '生成凭据' : '导入凭据'
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<Error>()
  const issues = error instanceof ApiError ? error.issues : []

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const fields = { group: group.id, label: String(form.get('label')) }
    setError(undefined)
    setSaving(true)
    try {
      // An import contains the secret. Keep its arguments out of the query/mutation cache.
      await api.createPluginCredential(
        name,
        mode === 'generate' ? { ...fields, mode } : { ...fields, mode, value: String(form.get('value')) },
      )
      toast.success(mode === 'generate' ? '凭据已生成' : '凭据已导入')
      onSaved()
    } catch (error) {
      setError(error instanceof Error ? error : new Error('无法保存凭据'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      title={title}
      description={group.title}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
      footer={
        <Button type="submit" form={id} variant="primary" loading={saving}>
          {title}
        </Button>
      }
    >
      <form id={id} onSubmit={(event) => void submit(event)} className="space-y-3">
        <Field
          label="凭据名称"
          htmlFor={`${id}-label`}
          error={issues.find((issue) => issue.path === 'label')?.message}
        >
          <Input id={`${id}-label`} name="label" required maxLength={80} autoComplete="off" />
        </Field>
        {mode === 'import' && (
          <Field
            label="凭据原值"
            htmlFor={`${id}-value`}
            error={issues.find((issue) => issue.path === 'value')?.message}
          >
            <Input
              id={`${id}-value`}
              name="value"
              type="password"
              required
              maxLength={4096}
              autoComplete="new-password"
              className="font-mono"
            />
          </Field>
        )}
        {error && issues.length === 0 && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error.message}
          </p>
        )}
      </form>
    </Dialog>
  )
}

type RevealState = { kind: 'loading' } | { kind: 'revealed'; value: string } | { kind: 'error'; error: Error }

function RevealCredential({
  name,
  item,
  onClose,
}: {
  name: string
  item: PluginCredentialInfo
  onClose: () => void
}) {
  const [state, setState] = useState<RevealState>({ kind: 'loading' })
  const [manual, setManual] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController>(undefined)
  const id = useId()
  const reveal = useCallback(() => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setState({ kind: 'loading' })
    void api.revealPluginCredential(name, item.id, next.signal).then(
      ({ value }) => {
        if (!next.signal.aborted) setState({ kind: 'revealed', value })
      },
      (error: Error) => {
        if (!next.signal.aborted) setState({ kind: 'error', error })
      },
    )
  }, [name, item.id])
  useEffect(() => {
    reveal()
    return () => controller.current?.abort()
  }, [reveal])

  async function copy(value: string) {
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(value)
        toast.success('已复制凭据')
        return
      } catch {
        // Clipboard permission is optional; select the revealed value for manual copy.
      }
    }
    input.current?.focus()
    input.current?.select()
    setManual(true)
  }

  return (
    <Dialog
      open
      title="查看凭据"
      description={item.label}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        state.kind === 'revealed' && (
          <Button variant="primary" onClick={() => void copy(state.value)}>
            <Copy className="size-3.5" />
            复制
          </Button>
        )
      }
    >
      {state.kind === 'loading' && <Skeleton className="h-9" />}
      {state.kind === 'error' && <ErrorState error={state.error} onRetry={reveal} />}
      {state.kind === 'revealed' && (
        <Field
          label="凭据原值"
          htmlFor={id}
          hint={manual ? '已选中原值，可按 Ctrl / ⌘ + C 复制。' : undefined}
        >
          <Input id={id} ref={input} readOnly spellCheck={false} value={state.value} className="font-mono" />
        </Field>
      )}
    </Dialog>
  )
}

function RevokeCredential({
  name,
  item,
  onClose,
  onSaved,
}: {
  name: string
  item: PluginCredentialInfo
  onClose: () => void
  onSaved: () => void
}) {
  const revoke = useMutation({
    mutationFn: () => api.revokePluginCredential(name, item.id),
    onSuccess: () => {
      toast.success('凭据已撤销')
      onSaved()
    },
  })
  return (
    <Dialog
      open
      title="撤销凭据"
      description={`撤销「${item.label}」后，使用它的请求将无法通过验证。`}
      onOpenChange={(open) => {
        if (!open && !revoke.isPending) onClose()
      }}
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>
            撤销凭据
          </Button>
        </>
      }
    />
  )
}
