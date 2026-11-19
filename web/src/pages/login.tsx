import { Button, Input, Logo, softSpring, spring } from '@asabot/panel-ui'
import { useMutation } from '@tanstack/react-query'
import { ArrowRight, KeyRound } from 'lucide-react'
import { motion, useAnimationControls } from 'motion/react'
import { type FormEvent, useState } from 'react'
import { ApiError, api } from '../lib/api.ts'

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const shake = useAnimationControls()
  const login = useMutation({
    mutationFn: api.login,
    meta: { silent: true },
    onSuccess,
    onError: (cause) => {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? '密码不正确'
          : cause instanceof ApiError && cause.status === 429
            ? '尝试次数过多，请稍后再试'
            : cause.message,
      )
      void shake.start({ x: [0, -8, 7, -5, 3, 0], transition: { duration: 0.42 } })
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!password) return
    setError(null)
    login.mutate(password)
  }

  return (
    <motion.div
      className="relative flex h-full items-center justify-center overflow-hidden px-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
    >
      <Backdrop />
      <motion.div
        className="relative w-full max-w-[380px]"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...softSpring, delay: 0.05 }}
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <motion.div
            initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ ...spring, delay: 0.12 }}
            className="mb-5 rounded-[14px] shadow-[0_8px_24px_-6px_rgb(109_94_245/0.5)]"
          >
            <Logo className="size-12" />
          </motion.div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">欢迎回到 AsaBot</h1>
          <p className="mt-1.5 text-[13.5px] text-fg-3">输入面板密码以继续</p>
        </div>

        <motion.form animate={shake} onSubmit={submit} className="card space-y-4 p-6">
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-[12.5px] font-medium text-fg-2">
              面板密码
            </label>
            <Input
              id="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              icon={<KeyRound />}
              placeholder="server.panelPassword"
              value={password}
              aria-invalid={error !== null}
              onChange={(event) => {
                setPassword(event.target.value)
                setError(null)
              }}
            />
            <motion.p
              initial={false}
              animate={{ height: error ? 'auto' : 0, opacity: error ? 1 : 0 }}
              transition={softSpring}
              className="overflow-hidden text-[12.5px] text-danger"
            >
              {error ?? ' '}
            </motion.p>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            loading={login.isPending}
            disabled={!password}
          >
            登录
            <ArrowRight className="size-4" />
          </Button>
        </motion.form>

        <p className="mt-6 text-center text-[12px] leading-relaxed text-fg-3">
          密码来自配置文件中的 <code className="font-mono">server.panelPassword</code>
        </p>
      </motion.div>
    </motion.div>
  )
}

/** Slow-drifting soft color fields plus a faint grid, masked toward the center. */
export function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:44px_44px] opacity-50 [mask-image:radial-gradient(ellipse_55%_50%_at_50%_45%,black,transparent)]" />
      <motion.div
        className="absolute top-[12%] left-[18%] size-[420px] rounded-full bg-[#8b7ffa] opacity-[0.16] blur-[110px] dark:opacity-[0.14]"
        animate={{ x: [0, 60, -20, 0], y: [0, 30, 60, 0] }}
        transition={{ duration: 22, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute right-[14%] bottom-[10%] size-[380px] rounded-full bg-[#2bbd95] opacity-[0.12] blur-[110px] dark:opacity-[0.1]"
        animate={{ x: [0, -50, 20, 0], y: [0, -40, -10, 0] }}
        transition={{ duration: 26, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute top-[40%] right-[30%] size-[260px] rounded-full bg-[#f2a5c8] opacity-[0.1] blur-[100px] dark:opacity-[0.07]"
        animate={{ x: [0, 40, -30, 0], y: [0, -30, 20, 0] }}
        transition={{ duration: 30, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      />
    </div>
  )
}
