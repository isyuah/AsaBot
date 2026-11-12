import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { App } from './app.tsx'
import { TooltipProvider } from './components/ui/misc.tsx'
import { ApiError } from './lib/api.ts'
import { ThemeProvider, useTheme } from './lib/theme.tsx'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        !(error instanceof ApiError && error.status > 0 && error.status < 500) && count < 2,
    },
  },
  // Mutations surface their failure as a toast unless the caller handles it (meta.silent).
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silent) return
      toast.error(error instanceof Error ? error.message : '操作失败')
    },
  }),
})

function ThemedToaster() {
  const { resolved } = useTheme()
  return (
    <Toaster
      theme={resolved}
      position="top-right"
      gap={10}
      toastOptions={{
        classNames: {
          toast: '!rounded-xl !border-border !bg-surface !text-fg !shadow-pop !font-sans !text-[13px]',
          description: '!text-fg-3',
        },
      }}
    />
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          <TooltipProvider>
            <App />
            <ThemedToaster />
          </TooltipProvider>
        </MotionConfig>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
