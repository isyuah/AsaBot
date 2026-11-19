import { Button, Dialog, Field, Input, Switch, useFadeUp } from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, LoaderCircle, RefreshCw, ScanLine, ShieldCheck, Smartphone } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useState } from 'react'
import { api } from '../lib/api.ts'
import type { AdapterView, ConnectionSetup, ConnectionView } from '../lib/types.ts'

const copy = {
  starting: { label: '正在获取二维码', Icon: LoaderCircle },
  waiting: { label: '等待扫码', detail: '请用手机扫描二维码。', Icon: ScanLine },
  scanned: { label: '在手机上确认', detail: '按手机上的提示继续。', Icon: Smartphone },
  verification: { label: '输入验证码', Icon: Smartphone },
  authorized: { label: '已授权，待保存', Icon: ShieldCheck },
  saved: { label: '连接已保存', Icon: ShieldCheck },
  expired: { label: '二维码已失效', detail: '请刷新二维码后重新扫码。', Icon: CircleAlert },
  'already-bound': {
    label: '该机器人已绑定',
    detail: '没有返回新授权。若已有有效连接，可直接重连。',
    Icon: CircleAlert,
  },
  failed: { label: '扫码未完成', detail: '请刷新二维码后重试。', Icon: CircleAlert },
} satisfies Record<ConnectionSetup['status'], { label: string; detail?: string; Icon: typeof ScanLine }>

export function ConnectionQrSetup({
  adapter,
  connection,
  onSaved,
  onCancel,
}: {
  adapter: AdapterView
  connection?: ConnectionView
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  const client = useQueryClient()
  const fade = useFadeUp()
  const nameId = useId()
  const enabledId = useId()
  const verifyId = useId()
  const [request, setRequest] = useState(() => ({ adapter: adapter.id, connectionId: connection?.id }))
  const [initial, setInitial] = useState<ConnectionSetup>()
  const [startError, setStartError] = useState<Error>()
  const [name, setName] = useState(adapter.name)
  const [enabled, setEnabled] = useState(true)
  const [code, setCode] = useState('')
  const [replacing, setReplacing] = useState(false)
  useEffect(() => {
    let active = true
    let setupId: string | undefined
    void Promise.resolve().then(async () => {
      if (!active) return
      try {
        const draft = await api.startConnectionSetup(request.adapter, request.connectionId)
        setupId = draft.id
        if (active) setInitial(draft)
        else await api.cancelConnectionSetup(setupId)
      } catch (error) {
        if (active) setStartError(error instanceof Error ? error : new Error('扫码请求失败'))
      }
    })
    return () => {
      active = false
      if (setupId) void api.cancelConnectionSetup(setupId).catch(() => undefined)
    }
  }, [request])
  const queryKey = ['connection-setup', initial?.id]
  const query = useQuery({
    queryKey,
    enabled: !!initial,
    queryFn: ({ signal }) => api.connectionSetup(initial?.id ?? '', signal),
    initialData: initial,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: ({ state }) =>
      state.error || ['expired', 'failed', 'saved', 'already-bound'].includes(state.data?.status ?? '')
        ? false
        : 1000,
  })
  const draft = query.data
  const verify = useMutation({
    mutationFn: async ({ id, code }: { id: string; code: string }) => {
      await client.cancelQueries({ queryKey })
      return api.verifyConnectionSetup(id, code)
    },
    onSuccess: (next) => {
      setCode('')
      client.setQueryData(queryKey, next)
    },
  })
  const save = useMutation({
    mutationFn: ({ id, replace }: { id: string; replace: boolean }) =>
      api.saveConnectionSetup(id, { ...(!connection && { name: name.trim(), enabled }), replace }),
    onSuccess: ({ connectionId }) => onSaved(connectionId),
    onError: () => setReplacing(false),
  })
  const restart = () => {
    setInitial(undefined)
    setStartError(undefined)
    setCode('')
    verify.reset()
    save.reset()
    setRequest({ adapter: adapter.id, connectionId: connection?.id })
  }
  const failure = startError ?? query.error
  const status = failure ? 'failed' : (draft?.status ?? 'starting')
  const hint: { label: string; detail?: string; Icon: typeof ScanLine } = copy[status]
  const detail = failure?.message ?? (draft?.status === 'failed' ? draft.detail : undefined) ?? hint.detail
  const authorized = !failure && draft?.status === 'authorized' ? draft : undefined
  const refreshable = status === 'expired' || status === 'already-bound' || status === 'failed'
  return (
    <div className="space-y-5">
      <section aria-label="扫码授权" className="rounded-xl border border-border bg-surface-2/45 p-4 sm:p-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={status} {...fade} className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {!failure && draft?.status === 'waiting' && (
              <img
                src={draft.image}
                alt={`${adapter.name} 授权二维码`}
                width={184}
                height={184}
                className="mx-auto aspect-square h-auto w-full max-w-[184px] shrink-0 rounded-lg bg-white shadow-card sm:mx-0"
              />
            )}
            <div className="min-w-0 flex-1 space-y-3">
              <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1.5">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <hint.Icon
                    aria-hidden="true"
                    className={`size-4 shrink-0 ${status === 'starting' ? 'animate-spin motion-reduce:animate-none' : ''} ${refreshable ? 'text-danger' : 'text-accent'}`}
                  />
                  {hint.label}
                </h2>
                {detail && <p className="text-[12.5px] leading-relaxed text-fg-3">{detail}</p>}
                {authorized && (
                  <>
                    <p className="break-all font-mono text-xs text-fg-3">{authorized.selfId}</p>
                    {authorized.replaces && (
                      <p className="text-[12.5px] text-fg-2">保存时需要确认替换当前机器人。</p>
                    )}
                    {authorized.missingAdmin && (
                      <p className="text-[12.5px] text-fg-2">
                        未识别扫码用户，保存后可在机器人详情设置管理员。
                      </p>
                    )}
                  </>
                )}
              </div>
              {!failure && draft?.status === 'verification' && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!verify.isPending && code.trim()) verify.mutate({ id: draft.id, code: code.trim() })
                  }}
                >
                  <Field
                    className="min-w-32 flex-1"
                    htmlFor={verifyId}
                    label="手机上显示的验证码"
                    error={verify.error?.message ?? (draft.retry ? '请核对验证码后重试' : undefined)}
                  >
                    <Input
                      id={verifyId}
                      value={code}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={64}
                      onChange={(event) => setCode(event.target.value)}
                      disabled={verify.isPending}
                    />
                  </Field>
                  <Button type="submit" loading={verify.isPending} disabled={!code.trim()}>
                    验证
                  </Button>
                </form>
              )}
              {refreshable && (
                <Button size="sm" onClick={restart}>
                  <RefreshCw className="size-3.5" /> 刷新二维码
                </Button>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </section>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!authorized || save.isPending) return
          if (authorized.replaces) setReplacing(true)
          else save.mutate({ id: authorized.id, replace: false })
        }}
      >
        {!connection && (
          <>
            <Field htmlFor={nameId} label="连接名称" required>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
                disabled={save.isPending}
              />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={enabledId} className="text-[12.5px] font-medium text-fg-2">
                启用连接
              </label>
              <Switch
                id={enabledId}
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={save.isPending}
              />
            </div>
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={!authorized || (!connection && !name.trim())}
          >
            保存连接
          </Button>
        </div>
        {save.error && (
          <p role="alert" className="text-[13px] text-danger">
            {save.error.message}
          </p>
        )}
      </form>
      <Dialog
        open={replacing && !!authorized}
        onOpenChange={(open) => !save.isPending && setReplacing(open)}
        title="替换已绑定的机器人？"
        description="保留这条连接的名称和启用状态。原机器人的管理员、插件设置、会话及历史不会迁移。"
        footer={
          <>
            <Button variant="ghost" disabled={save.isPending} onClick={() => setReplacing(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={save.isPending}
              disabled={!authorized}
              onClick={() => authorized && save.mutate({ id: authorized.id, replace: true })}
            >
              确认替换
            </Button>
          </>
        }
      />
    </div>
  )
}
