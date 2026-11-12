import {
  AppWindow,
  BarChart3,
  Bot,
  Calendar,
  Coins,
  FlaskConical,
  Gamepad2,
  Gift,
  Image,
  LayoutDashboard,
  ListChecks,
  MessagesSquare,
  Music,
  Puzzle,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  TerminalSquare,
  Trophy,
  Users,
  Wrench,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { PluginView } from '../../lib/types.ts'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: '工作区',
    items: [
      { to: '/', label: '概览', icon: LayoutDashboard },
      { to: '/plugins', label: '插件', icon: Puzzle },
      { to: '/commands', label: '命令', icon: TerminalSquare },
      { to: '/groups', label: '群组', icon: Users },
      { to: '/bots', label: '机器人', icon: Bot },
      { to: '/playground', label: '调试台', icon: FlaskConical },
    ],
  },
  {
    label: '运维',
    items: [
      { to: '/logs', label: '日志', icon: ScrollText },
      { to: '/acl', label: '访问控制', icon: ShieldCheck },
      { to: '/settings', label: '设置', icon: Settings },
    ],
  },
]

/** Pages that exist only while a built-in plugin is active; the panel implements them natively. */
export const builtinPluginPages: (NavItem & { plugin: string; group: string })[] = [
  { to: '/history', label: '消息记录', icon: MessagesSquare, plugin: 'history', group: '运维' },
]

// Plugin pages name a lucide icon; a curated set keeps the bundle small, anything else falls back to AppWindow.
const pageIcons: Record<string, ComponentType<{ className?: string }>> = {
  'app-window': AppWindow,
  'bar-chart': BarChart3,
  calendar: Calendar,
  coins: Coins,
  gamepad: Gamepad2,
  gift: Gift,
  image: Image,
  'list-checks': ListChecks,
  music: Music,
  sparkles: Sparkles,
  star: Star,
  trophy: Trophy,
  users: Users,
  wrench: Wrench,
}

export function pluginPagePath(plugin: string): string {
  return `/pages/${encodeURIComponent(plugin)}`
}

/** Navigation entries for plugin pages (ctx.panel.page) of active plugins. */
export function pluginPageItems(plugins: PluginView[]): NavItem[] {
  return plugins
    .filter((plugin) => plugin.page && plugin.state === 'active')
    .map((plugin) => ({
      to: pluginPagePath(plugin.name),
      label: plugin.page?.title ?? plugin.name,
      icon: pageIcons[plugin.page?.icon ?? ''] ?? AppWindow,
    }))
}
