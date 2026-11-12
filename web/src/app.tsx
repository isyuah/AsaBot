import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import { Logo } from './components/layout/logo.tsx'
import { Shell } from './components/layout/shell.tsx'
import { ApiError, api, setUnauthorizedHandler } from './lib/api.ts'
import { softSpring } from './lib/motion.ts'
import { RealtimeProvider } from './lib/realtime.tsx'
import { resetSession } from './lib/session.ts'
import { LoginPage } from './pages/login.tsx'

export function App() {
  const client = useQueryClient()
  const session = useQuery({
    queryKey: ['session'],
    queryFn: api.session,
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    setUnauthorizedHandler(() => {
      client.setQueryData(['session'], { authenticated: false })
    })
  }, [client])

  const view = session.isPending
    ? 'splash'
    : session.error
      ? 'error'
      : session.data?.authenticated
        ? 'app'
        : 'login'

  return (
    <AnimatePresence mode="wait">
      {view === 'splash' && (
        <motion.div
          key="splash"
          className="flex h-full items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY }}
          >
            <Logo className="size-10" />
          </motion.div>
        </motion.div>
      )}
      {view === 'error' && (
        <UnavailableScreen key="error" error={session.error} onRetry={() => void session.refetch()} />
      )}
      {view === 'login' && (
        <LoginPage
          key="login"
          onSuccess={() => {
            resetSession(client, true)
          }}
        />
      )}
      {view === 'app' && (
        <motion.div
          key="app"
          className="h-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={softSpring}
        >
          <RealtimeProvider>
            <Shell />
          </RealtimeProvider>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function UnavailableScreen({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const disabled = error instanceof ApiError && error.status === 404
  return (
    <motion.div
      className="flex h-full items-center justify-center p-6"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={softSpring}
    >
      <div className="card max-w-md p-8 text-center">
        <Logo className="mx-auto mb-5 size-10" />
        <h1 className="text-lg font-semibold tracking-tight">
          {disabled ? '面板未启用' : '无法连接到 AsaBot'}
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-fg-3">
          {disabled ? (
            <>
              在配置文件中设置{' '}
              <code className="rounded bg-surface-2 px-1 font-mono text-[12.5px]">server.panelPassword</code>{' '}
              后重启 AsaBot。
            </>
          ) : (
            (error?.message ?? '请确认 AsaBot 正在运行。')
          )}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 cursor-pointer text-[13px] font-medium text-accent hover:underline"
        >
          重试
        </button>
      </div>
    </motion.div>
  )
}
