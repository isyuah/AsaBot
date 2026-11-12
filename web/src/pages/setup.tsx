import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, Copy, KeyRound, Link2, Lock, Terminal } from 'lucide-react'
import { AnimatePresence, motion, useAnimationControls } from 'motion/react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Logo } from '../components/layout/logo.tsx'
import { ListControl } from '../components/schema-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Field, Input } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { ApiError, api } from '../lib/api.ts'
import { softSpring, spring } from '../lib/motion.ts'
import { resetSession } from '../lib/session.ts'
import type { SetupInput } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { Backdrop } from './login.tsx'

const steps = [
  { title: '验证设置码', description: '确认你能访问运行 AsaBot 的机器' },
  { title: '设置面板密码', description: '之后用它登录管理面板' },
  { title: '超级用户', description: '拥有全部权限的账号，可以稍后修改' },
  { title: '连接 OneBot', description: '可以跳过，之后在设置中添加' },
] as const

type Mode = 'forward' | 'reverse' | 'later'

/** Setup codes are `XXXX-XXXX` in a base32 alphabet; accept any case and spacing while typing. */
function formatCode(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

const wsUrl = /^wss?:\/\/\S+$/i

export function SetupPage() {
  const client = useQueryClient()
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [superusers, setSuperusers] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('forward')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const shake = useAnimationControls()

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1)
    setStep(next)
  }
  const fail = (at: number, next: Record<string, string>) => {
    setErrors(next)
    if (at !== step) go(at)
    void shake.start({ x: [0, -8, 7, -5, 3, 0], transition: { duration: 0.42 } })
  }

  const finish = useMutation({
    mutationFn: (input: SetupInput) => api.setup(input),
    meta: { silent: true },
    onSuccess: () => {
      toast.success('设置完成，欢迎使用 AsaBot')
      resetSession(client, true)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401)
        fail(0, { code: '设置码不正确，请对照控制台输出' })
      else if (error instanceof ApiError && error.status === 429)
        fail(0, { code: '尝试次数过多，请稍后再试' })
      else if (error instanceof ApiError && error.issues.length > 0) {
        const issue = error.issues[0] as { path: string; message: string }
        const at = issue.path.startsWith('password') ? 1 : issue.path.startsWith('superusers') ? 2 : 3
        fail(at, { [at === 1 ? 'password' : at === 3 ? 'url' : 'superusers']: issue.message })
      } else toast.error(error.message)
    },
  })

  const validate = (): Record<string, string> => {
    if (step === 0 && !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code))
      return { code: '设置码是 8 位字符，形如 ABCD-EFGH' }
    if (step === 1 && password.length < 8) return { password: '至少 8 个字符' }
    if (step === 1 && password.includes('${')) return { password: '密码不能包含 ${' }
    if (step === 1 && confirm !== password) return { confirm: '两次输入的密码不一致' }
    if (step === 3 && mode === 'forward' && !wsUrl.test(url.trim()))
      return { url: '请填写 ws:// 或 wss:// 开头的地址' }
    return {}
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = validate()
    if (Object.keys(found).length > 0) return fail(step, found)
    setErrors({})
    if (step < steps.length - 1) return go(step + 1)
    const onebot =
      mode === 'forward'
        ? { connections: [{ type: 'forward', url: url.trim(), ...(token ? { accessToken: token } : {}) }] }
        : mode === 'reverse'
          ? { reverse: { enabled: true, accessToken: token } }
          : undefined
    finish.mutate({ code, password, superusers, ...(onebot ? { adapters: { onebot11: onebot } } : {}) })
  }

  const reverseAddress = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/onebot/v11/ws`
  const current = steps[step] as (typeof steps)[number]

  return (
    <motion.div
      className="relative flex h-full items-center justify-center overflow-hidden px-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
    >
      <Backdrop />
      <motion.div
        className="relative w-full max-w-[440px]"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...softSpring, delay: 0.05 }}
      >
        <div className="mb-7 flex flex-col items-center text-center">
          <motion.div
            initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ ...spring, delay: 0.12 }}
            className="mb-5 rounded-[14px] shadow-[0_8px_24px_-6px_rgb(109_94_245/0.5)]"
          >
            <Logo className="size-12" />
          </motion.div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">初始化 AsaBot</h1>
          <p className="mt-1.5 text-[13.5px] text-fg-3">只需几步，完成后进入管理面板</p>
        </div>

        <motion.form animate={shake} onSubmit={submit} className="card overflow-hidden">
          <div className="flex gap-1.5 px-6 pt-5">
            {steps.map((item, index) => (
              <div key={item.title} className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
                <motion.div
                  className="h-full rounded-full bg-accent"
                  initial={false}
                  animate={{ width: index <= step ? '100%' : '0%' }}
                  transition={softSpring}
                />
              </div>
            ))}
          </div>

          <div className="px-6 pt-5">
            <p className="text-[11.5px] font-medium text-fg-3 tabular">
              第 {step + 1} 步，共 {steps.length} 步
            </p>
            <h2 className="mt-1 text-[16px] font-semibold tracking-[-0.015em]">{current.title}</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-3">{current.description}</p>
          </div>

          <div className="relative min-h-[196px] px-6 pt-5 pb-2">
            <AnimatePresence mode="wait" initial={false} custom={direction}>
              <motion.div
                key={step}
                custom={direction}
                initial={{ opacity: 0, x: direction * 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * -24 }}
                transition={{ ...softSpring, opacity: { duration: 0.15 } }}
                className="space-y-4"
              >
                {step === 0 && (
                  <>
                    <Hint icon={<Terminal />}>
                      设置码在 AsaBot 启动时打印在控制台。Docker 部署可以用{' '}
                      <code className="font-mono text-[12px]">docker compose logs asabot</code> 查看。
                    </Hint>
                    <Field label="设置码" error={errors.code} htmlFor="setup-code">
                      <Input
                        id="setup-code"
                        autoFocus
                        autoComplete="off"
                        icon={<KeyRound />}
                        placeholder="ABCD-EFGH"
                        value={code}
                        aria-invalid={Boolean(errors.code)}
                        onChange={(event) => {
                          setCode(formatCode(event.target.value))
                          setErrors({})
                        }}
                        className="font-mono tracking-[0.12em]"
                      />
                    </Field>
                  </>
                )}
                {step === 1 && (
                  <>
                    <Field
                      label="面板密码"
                      error={errors.password}
                      hint="至少 8 个字符"
                      htmlFor="setup-password"
                    >
                      <Input
                        id="setup-password"
                        type="password"
                        autoFocus
                        autoComplete="new-password"
                        icon={<Lock />}
                        value={password}
                        aria-invalid={Boolean(errors.password)}
                        onChange={(event) => {
                          setPassword(event.target.value)
                          setErrors({})
                        }}
                      />
                    </Field>
                    <Field label="确认密码" error={errors.confirm} htmlFor="setup-confirm">
                      <Input
                        id="setup-confirm"
                        type="password"
                        autoComplete="new-password"
                        icon={<Lock />}
                        value={confirm}
                        aria-invalid={Boolean(errors.confirm)}
                        onChange={(event) => {
                          setConfirm(event.target.value)
                          setErrors({})
                        }}
                      />
                    </Field>
                  </>
                )}
                {step === 2 && (
                  <Field
                    label="超级用户 ID"
                    error={errors.superusers}
                    hint="输入后按回车添加。超级用户可以在聊天中管理插件和访问控制"
                    htmlFor="setup-superusers"
                  >
                    <ListControl
                      id="setup-superusers"
                      value={superusers}
                      onChange={(next) => setSuperusers(next as string[])}
                    />
                  </Field>
                )}
                {step === 3 && (
                  <>
                    {/* Segmented resets its own margin, which would cancel the parent spacing. */}
                    <div>
                      <Segmented
                        value={mode}
                        onChange={(next) => {
                          setMode(next)
                          setErrors({})
                        }}
                        className="w-full [&>button]:flex-1"
                        options={[
                          { value: 'forward', label: '正向 WS' },
                          { value: 'reverse', label: '反向 WS' },
                          { value: 'later', label: '稍后配置' },
                        ]}
                      />
                    </div>
                    {mode === 'forward' && (
                      <>
                        <Field
                          label="OneBot 实现的 WebSocket 地址"
                          error={errors.url}
                          hint="AsaBot 主动连接这个地址，例如 NapCat 的 WebSocket 服务器"
                          htmlFor="setup-url"
                        >
                          <Input
                            id="setup-url"
                            icon={<Link2 />}
                            placeholder="ws://127.0.0.1:3001"
                            value={url}
                            aria-invalid={Boolean(errors.url)}
                            onChange={(event) => {
                              setUrl(event.target.value)
                              setErrors({})
                            }}
                            className="font-mono"
                          />
                        </Field>
                        <TokenField value={token} onChange={setToken} />
                      </>
                    )}
                    {mode === 'reverse' && (
                      <>
                        <Field label="在 OneBot 实现中填写这个地址" hint="由 OneBot 实现主动连接 AsaBot">
                          <CopyField value={reverseAddress} />
                        </Field>
                        <TokenField value={token} onChange={setToken} />
                      </>
                    )}
                    {mode === 'later' && (
                      <Hint icon={<Link2 />}>
                        完成后在「设置」页面添加连接。没有连接时，仍然可以在调试台里试用插件。
                      </Hint>
                    )}
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => go(step - 1)}
              className={cn(step === 0 && 'invisible')}
            >
              <ArrowLeft className="size-4" />
              上一步
            </Button>
            <Button type="submit" variant="primary" loading={finish.isPending}>
              {step === steps.length - 1 ? (
                <>
                  完成设置
                  <Check className="size-4" />
                </>
              ) : (
                <>
                  下一步
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </div>
        </motion.form>
      </motion.div>
    </motion.div>
  )
}

function Hint({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-fg-2 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3">
      {icon}
      <p>{children}</p>
    </div>
  )
}

function TokenField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field label="访问令牌" hint="与 OneBot 实现中配置的 token 一致；没有设置可以留空" htmlFor="setup-token">
      <Input
        id="setup-token"
        type="password"
        autoComplete="off"
        icon={<KeyRound />}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono"
      />
    </Field>
  )
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex h-9 items-center gap-2 rounded-[10px] border border-border bg-surface-2 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="复制地址"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            },
            () => toast.error('无法访问剪贴板，请手动复制'),
          )
        }
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}
