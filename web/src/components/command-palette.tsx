import { Kbd, spring } from '@asabot/panel-ui'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Command } from 'cmdk'
import { CornerDownLeft, FlaskConical, LogOut, Monitor, Moon, RotateCw, Search, Sun } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useRef } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { navigate } from '../lib/router.tsx'
import { resetSession } from '../lib/session.ts'
import { useTheme } from '../lib/theme.tsx'
import { commandPalette, playgroundDraft, useCommandPalette } from '../lib/ui-state.ts'
import { navGroups } from './layout/nav.ts'

export function CommandPalette() {
  const request = useCommandPalette()
  const open = request !== null
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef<(() => void) | null>(null)
  const client = useQueryClient()
  const { setPreference } = useTheme()
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins, enabled: open })
  const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands, enabled: open })
  const reload = useMutation({
    mutationFn: (name: string) => api.pluginAction(name, 'reload'),
    onSuccess: (plugin) => {
      toast.success(`已重载 ${plugin.name}`)
      void client.invalidateQueries({ queryKey: ['plugins'] })
    },
  })

  const close = () => commandPalette.set(null)
  const run = (action: () => void) => {
    close()
    action()
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={close}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-overlay backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              />
            </DialogPrimitive.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 flex justify-center px-4 pt-[14dvh] pb-4">
              <DialogPrimitive.Content
                asChild
                forceMount
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => {
                  event.preventDefault()
                  restoreFocus.current = request?.restoreFocus ?? null
                  input.current?.focus({ preventScroll: true })
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                  if (commandPalette.get()) return
                  restoreFocus.current?.()
                  restoreFocus.current = null
                }}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.97, y: -8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={spring}
                  className="pointer-events-auto flex h-fit max-h-full w-full max-w-[580px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop outline-none"
                >
                  <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>
                  <Command
                    loop
                    className="flex min-h-0 flex-col [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3"
                  >
                    <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4">
                      <Search className="size-4 text-fg-3" />
                      <Command.Input
                        ref={input}
                        placeholder="输入页面、插件或命令…"
                        className="h-13 min-w-0 flex-1 bg-transparent text-[14.5px] text-fg outline-none placeholder:text-fg-3"
                      />
                      <Kbd>Esc</Kbd>
                    </div>
                    <Command.List className="min-h-0 max-h-[min(420px,60dvh)] overflow-y-auto overscroll-contain p-1.5 [&_[cmdk-list-sizer]]:transition-[height]">
                      <Command.Empty className="py-10 text-center text-[13px] text-fg-3">
                        没有匹配的结果
                      </Command.Empty>

                      <Command.Group heading="跳转">
                        {navGroups.flatMap((group) =>
                          group.items.map((item) => (
                            <PaletteItem
                              key={item.to}
                              value={`page ${item.label} ${item.to}`}
                              icon={<item.icon className="size-4" />}
                              onSelect={() => run(() => navigate(item.to))}
                            >
                              {item.label}
                            </PaletteItem>
                          )),
                        )}
                      </Command.Group>

                      {commands.data && commands.data.length > 0 && (
                        <Command.Group heading="在调试台中试用命令">
                          {commands.data
                            .filter((command) => !command.hidden)
                            .map((command) => (
                              <PaletteItem
                                key={`${command.owner}:${command.path}`}
                                value={`command ${command.path} ${command.aliases.join(' ')} ${command.description}`}
                                icon={<FlaskConical className="size-4" />}
                                hint={command.owner}
                                onSelect={() =>
                                  run(() => {
                                    playgroundDraft.set(`/${command.path} `)
                                    navigate('/playground')
                                  })
                                }
                              >
                                <span className="font-mono text-[12.5px]">{command.usage}</span>
                                {command.description && (
                                  <span className="ml-2 text-fg-3">{command.description}</span>
                                )}
                              </PaletteItem>
                            ))}
                        </Command.Group>
                      )}

                      {plugins.data && plugins.data.length > 0 && (
                        <Command.Group heading="重载插件">
                          {plugins.data.map((plugin) => (
                            <PaletteItem
                              key={plugin.name}
                              value={`reload ${plugin.name} ${plugin.description ?? ''}`}
                              icon={<RotateCw className="size-4" />}
                              onSelect={() => run(() => reload.mutate(plugin.name))}
                            >
                              重载 {plugin.name}
                            </PaletteItem>
                          ))}
                        </Command.Group>
                      )}

                      <Command.Group heading="偏好">
                        <PaletteItem
                          value="theme light 浅色"
                          icon={<Sun className="size-4" />}
                          onSelect={() => run(() => setPreference('light'))}
                        >
                          切换到浅色主题
                        </PaletteItem>
                        <PaletteItem
                          value="theme dark 深色"
                          icon={<Moon className="size-4" />}
                          onSelect={() => run(() => setPreference('dark'))}
                        >
                          切换到深色主题
                        </PaletteItem>
                        <PaletteItem
                          value="theme system 跟随系统"
                          icon={<Monitor className="size-4" />}
                          onSelect={() => run(() => setPreference('system'))}
                        >
                          主题跟随系统
                        </PaletteItem>
                        <PaletteItem
                          value="logout 退出登录"
                          icon={<LogOut className="size-4" />}
                          onSelect={() =>
                            run(() => {
                              void api.logout().finally(() => {
                                resetSession(client, false)
                              })
                            })
                          }
                        >
                          退出登录
                        </PaletteItem>
                      </Command.Group>
                    </Command.List>
                    <div className="flex shrink-0 items-center gap-3 border-t border-border bg-surface-2/60 px-4 py-2 text-[11.5px] text-fg-3">
                      <span className="flex items-center gap-1">
                        <Kbd>↑</Kbd>
                        <Kbd>↓</Kbd>选择
                      </span>
                      <span className="flex items-center gap-1">
                        <Kbd>
                          <CornerDownLeft className="size-3" />
                        </Kbd>
                        执行
                      </span>
                    </div>
                  </Command>
                </motion.div>
              </DialogPrimitive.Content>
            </div>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}

function PaletteItem({
  value,
  icon,
  hint,
  onSelect,
  children,
}: {
  value: string
  icon: ReactNode
  hint?: string
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="group flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-[13.5px] text-fg-2 select-none data-[selected=true]:bg-surface-2 data-[selected=true]:text-fg"
    >
      <span className="text-fg-3 group-data-[selected=true]:text-accent">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[11.5px] text-fg-3">{hint}</span>}
    </Command.Item>
  )
}
