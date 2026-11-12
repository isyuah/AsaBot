import {
  Bot,
  FlaskConical,
  LayoutDashboard,
  Puzzle,
  ScrollText,
  Settings,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'
import type { ComponentType } from 'react'

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
