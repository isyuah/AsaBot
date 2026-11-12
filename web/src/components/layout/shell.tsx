import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut, Menu as MenuIcon, Monitor, Moon, Search, Sun } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ComponentType, type ReactNode, useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import { softSpring, spring } from '../../lib/motion.ts'
import { useConnection } from '../../lib/realtime.tsx'
import { Link, usePath } from '../../lib/router.tsx'
import { resetSession } from '../../lib/session.ts'
import { type ThemePreference, useTheme } from '../../lib/theme.tsx'
import { commandPaletteOpen } from '../../lib/ui-state.ts'
import { cn } from '../../lib/utils.ts'
import { AclPage } from '../../pages/acl.tsx'
import { BotsPage } from '../../pages/bots.tsx'
import { CommandsPage } from '../../pages/commands.tsx'
import { LogsPage } from '../../pages/logs.tsx'
import { NotFoundPage } from '../../pages/not-found.tsx'
import { OverviewPage } from '../../pages/overview.tsx'
import { PlaygroundPage } from '../../pages/playground.tsx'
import { PluginsPage } from '../../pages/plugins.tsx'
import { SettingsPage } from '../../pages/settings.tsx'
import { CommandPalette } from '../command-palette.tsx'
import { OperationsDock } from '../plugin-manage.tsx'
import { Button } from '../ui/button.tsx'
import { Tooltip } from '../ui/misc.tsx'
import { Kbd, StatusDot } from '../ui/primitives.tsx'
import { Logo } from './logo.tsx'
import { type NavItem, navGroups } from './nav.ts'

const pages: Record<string, ComponentType> = {
  '/': OverviewPage,
  '/plugins': PluginsPage,
  '/commands': CommandsPage,
  '/bots': BotsPage,
  '/playground': PlaygroundPage,
  '/logs': LogsPage,
  '/acl': AclPage,
  '/settings': SettingsPage,
}

const allItems = navGroups.flatMap((group) => group.items)

export function Shell() {
  const path = usePath()
  const [mobileOpen, setMobileOpen] = useState(false)
  const current = allItems.find((item) => item.to === path)
  const Page = pages[path] ?? NotFoundPage

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        commandPaletteOpen.set((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.title = current ? `${current.label} · AsaBot` : 'AsaBot 控制台'
  }, [current])

  return (
    <div className="relative flex h-full">
      {/* Soft accent glow behind the top of the content area. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_70%_60%_at_60%_-10%,var(--bg-glow),transparent_70%)]" />

      <aside className="relative z-10 hidden w-[236px] shrink-0 lg:block">
        <Sidebar path={path} />
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 w-[260px] border-r border-border bg-bg lg:hidden"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={softSpring}
            >
              <Sidebar path={path} onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="relative z-0 flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 px-4 lg:hidden">
          <Button variant="ghost" size="icon" aria-label="打开导航" onClick={() => setMobileOpen(true)}>
            <MenuIcon className="size-4.5" />
          </Button>
          <Logo className="size-6" />
          <span className="font-semibold tracking-tight">AsaBot</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={path}
              initial={{ opacity: 0, y: 10, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(2px)', transition: { duration: 0.12 } }}
              transition={softSpring}
              className="mx-auto w-full max-w-[1180px] px-5 py-7 lg:px-10 lg:py-9"
            >
              <Page />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <CommandPalette />
      <OperationsDock />
    </div>
  )
}

function Sidebar({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview })
  return (
    <div className="flex h-full flex-col px-3 pt-4 pb-3">
      <div className="flex items-center gap-2.5 px-2 pb-5">
        <Logo />
        <div className="leading-tight">
          <div className="text-[14.5px] font-semibold tracking-[-0.02em]">AsaBot</div>
          <div className="text-[11.5px] text-fg-3">
            {overview.data ? `v${overview.data.version}` : '控制台'}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => commandPaletteOpen.set(true)}
        className="group mb-5 flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-fg-3 shadow-card transition-colors hover:border-border-strong hover:text-fg-2"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">搜索或跳转…</span>
        <Kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </button>

      <nav className="flex-1 space-y-5 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.label}>
            <div className="mb-1 px-2.5 text-[11px] font-medium tracking-wide text-fg-3">{group.label}</div>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink item={item} active={item.to === path} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-border pt-3">
        <ConnectionPill />
        <div className="flex items-center justify-between gap-2 px-1">
          <ThemeSwitcher />
          <LogoutButton />
        </div>
      </div>
    </div>
  )
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={cn(
        'relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors duration-150',
        active ? 'text-fg' : 'text-fg-2 hover:bg-surface-2/70 hover:text-fg',
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          transition={spring}
          className="absolute inset-0 rounded-lg border border-border bg-surface shadow-card"
        />
      )}
      <Icon className={cn('relative size-4 transition-colors', active ? 'text-accent' : 'text-fg-3')} />
      <span className="relative">{item.label}</span>
    </Link>
  )
}

function ConnectionPill() {
  const connection = useConnection()
  const label: Record<typeof connection, ReactNode> = {
    open: '实时连接正常',
    connecting: '正在连接…',
    closed: '连接已断开，重试中',
  }
  const tone = connection === 'open' ? 'success' : connection === 'connecting' ? 'warning' : 'danger'
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-3">
      <StatusDot tone={tone} pulse={connection === 'open'} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={connection}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.15 }}
        >
          {label[connection]}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function ThemeSwitcher() {
  const { preference, setPreference } = useTheme()
  const options: { value: ThemePreference; icon: ReactNode; label: string }[] = [
    { value: 'light', icon: <Sun className="size-3.5" />, label: '浅色' },
    { value: 'system', icon: <Monitor className="size-3.5" />, label: '跟随系统' },
    { value: 'dark', icon: <Moon className="size-3.5" />, label: '深色' },
  ]
  return (
    <fieldset
      aria-label="主题"
      className="m-0 inline-flex h-8 min-w-0 items-center rounded-lg border border-border bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <Tooltip key={option.value} content={option.label}>
          <button
            type="button"
            aria-pressed={preference === option.value}
            aria-label={option.label}
            onClick={() => setPreference(option.value)}
            className={cn(
              'relative flex h-full w-7 cursor-pointer items-center justify-center rounded-md transition-colors',
              preference === option.value ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {preference === option.value && (
              <motion.span
                layoutId="theme-active"
                transition={spring}
                className="absolute inset-0 rounded-md border border-border bg-surface shadow-card"
              />
            )}
            <span className="relative">{option.icon}</span>
          </button>
        </Tooltip>
      ))}
    </fieldset>
  )
}

function LogoutButton() {
  const client = useQueryClient()
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      resetSession(client, false)
    },
  })
  return (
    <Tooltip content="退出登录">
      <Button
        variant="ghost"
        size="icon"
        aria-label="退出登录"
        loading={logout.isPending}
        onClick={() => logout.mutate()}
      >
        <LogOut className="size-4" />
      </Button>
    </Tooltip>
  )
}
