import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cable, Plus, RotateCw, SlidersHorizontal, TerminalSquare, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { SchemaForm } from '../components/schema-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Card, ErrorState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { Select } from '../components/ui/select.tsx'
import { ApiError, api } from '../lib/api.ts'
import { softSpring, stagger, staggerItem } from '../lib/motion.ts'
import { platformName } from '../lib/platform.ts'
import type { JsonSchema, Settings, SettingsUpdate } from '../lib/types.ts'

const basicSchema: JsonSchema = {
  type: 'object',
  properties: {
    superusers: {
      type: 'array',
      items: { type: 'string' },
      title: '超级用户',
      description: '拥有全部权限、不受冷却限制的用户 ID',
    },
    timezone: {
      type: 'string',
      title: '时区',
      description: 'IANA 时区名称，例如 Asia/Shanghai。用于定时任务和“今日”统计，重启后生效',
    },
  },
}

const commandSchema: JsonSchema = {
  type: 'object',
  properties: {
    prefixes: {
      type: 'array',
      items: { type: 'string' },
      title: '命令前缀',
      description: '消息以其中任一前缀开头时识别为命令',
    },
    mentionAsPrefix: {
      type: 'boolean',
      title: '@机器人时可省略前缀',
      description: '群聊中 @机器人 后可以直接写命令名',
    },
    privateRequirePrefix: {
      type: 'boolean',
      title: '私聊也需要前缀',
      description: '关闭时私聊可以直接写命令名',
    },
    replyOnError: { type: 'boolean', title: '出错时回复', description: '命令处理出错时回复一条简短提示' },
    replyOnDenied: { type: 'boolean', title: '拒绝时回复', description: '权限不足或冷却中时回复提示' },
  },
}

const restartLabels: Record<string, string> = { timezone: '时区' }

/** Which part of the settings a save came from: its issues and spinner belong to that card only. */
type Section = 'basic' | 'command' | `adapter:${string}`

function sectionIssues(error: unknown, prefix: string): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  return Object.fromEntries(
    error.issues
      .filter((issue) => issue.path.startsWith(prefix))
      .map((issue) => [issue.path.slice(prefix.length).replace(/^\./, ''), issue.message]),
  )
}

export function SettingsPage() {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [removing, setRemoving] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: ({ input }: { section: Section; input: SettingsUpdate; message: string }) =>
      api.updateSettings(input),
    meta: { silent: true },
    onSuccess: (next, { input, message }) => {
      client.setQueryData<Settings>(['settings'], next)
      if (input.adapters) {
        void client.invalidateQueries({ queryKey: ['bots'] })
        void client.invalidateQueries({ queryKey: ['overview'] })
      }
      setRemoving(null)
      toast.success(message)
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.status === 400)) toast.error(error.message)
    },
  })
  const failed = (section: Section) => (save.variables?.section === section ? save.error : null)
  const saving = (section: Section) => save.isPending && save.variables?.section === section

  return (
    <>
      <PageHeader title="设置" description="框架的核心配置，保存后写回配置文件" />
      {settings.error && !settings.data ? (
        <Card>
          <ErrorState
            error={settings.error}
            onRetry={() => void settings.refetch()}
            retrying={settings.isFetching}
          />
        </Card>
      ) : !settings.data ? (
        <div className="max-w-3xl space-y-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <motion.div variants={stagger} initial="initial" animate="animate" className="max-w-3xl space-y-3">
          <AnimatePresence initial={false}>
            {settings.data.restartRequired.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={softSpring}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2.5 rounded-xl bg-warning-soft px-4 py-3 text-[13px] text-warning">
                  <RotateCw className="size-4 shrink-0" />
                  以下修改已写入配置文件，重启 AsaBot 后生效：
                  {settings.data.restartRequired.map((key) => restartLabels[key] ?? key).join('、')}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <Section icon={<SlidersHorizontal />} title="基本" description="超级用户与时区">
            <SchemaForm
              schema={basicSchema}
              value={{ superusers: settings.data.superusers, timezone: settings.data.timezone }}
              issues={sectionIssues(failed('basic'), '')}
              saving={saving('basic')}
              note="超级用户立即生效，时区在重启后生效"
              submitLabel="保存"
              onSubmit={(value) =>
                save.mutate({
                  section: 'basic',
                  input: value as Pick<Settings, 'superusers' | 'timezone'>,
                  message: '基本设置已保存',
                })
              }
            />
          </Section>

          <Section icon={<TerminalSquare />} title="命令" description="命令的触发方式与回复行为">
            <SchemaForm
              schema={commandSchema}
              value={settings.data.command}
              issues={sectionIssues(failed('command'), 'command')}
              saving={saving('command')}
              note="保存后立即生效"
              submitLabel="保存"
              onSubmit={(value) =>
                save.mutate({
                  section: 'command',
                  input: { command: value as Settings['command'] },
                  message: '命令设置已保存',
                })
              }
            />
          </Section>

          {Object.entries(settings.data.adapters).map(([platform, adapter]) => (
            <Section
              key={platform}
              icon={<Cable />}
              title={platformName(platform)}
              description={
                <>
                  连接协议 · <span className="font-mono">adapters.{platform}</span>
                </>
              }
              action={
                <Button variant="ghost" size="sm" onClick={() => setRemoving(platform)}>
                  <Trash2 className="size-3.5" />
                  移除
                </Button>
              }
            >
              <SchemaForm
                schema={adapter.schema}
                value={adapter.value}
                issues={sectionIssues(failed(`adapter:${platform}`), `adapters.${platform}`)}
                saving={saving(`adapter:${platform}`)}
                note="保存后按新配置重新连接，机器人会短暂离线"
                submitLabel="保存并重连"
                onSubmit={(value) =>
                  save.mutate({
                    section: `adapter:${platform}`,
                    input: { adapters: { [platform]: value } },
                    message: `${platformName(platform)} 已按新配置重新连接`,
                  })
                }
              />
            </Section>
          ))}

          <AddAdapter
            settings={settings.data}
            pending={save.isPending}
            onAdd={(platform) =>
              save.mutate({
                section: `adapter:${platform}`,
                input: { adapters: { [platform]: {} } },
                message: `已添加 ${platformName(platform)}`,
              })
            }
          />
        </motion.div>
      )}

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`移除 ${removing ? platformName(removing) : ''}`}
        description="这个协议下的所有机器人会断开连接并注销，相应配置会从配置文件中删除。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={save.isPending && save.variables?.section === `adapter:${removing}`}
              onClick={() =>
                removing &&
                save.mutate({
                  section: `adapter:${removing}`,
                  input: { adapters: { [removing]: null } },
                  message: `已移除 ${platformName(removing)}`,
                })
              }
            >
              <Trash2 className="size-3.5" />
              移除
            </Button>
          </>
        }
      />
    </>
  )
}

function Section({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  description: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <motion.div variants={staggerItem}>
      <Card>
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-1">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-2 [&>svg]:size-4">
              {icon}
            </div>
            <div>
              <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
              <p className="mt-0.5 text-[12.5px] text-fg-3">{description}</p>
            </div>
          </div>
          {action}
        </div>
        <div className="px-6 pt-4 pb-6">{children}</div>
      </Card>
    </motion.div>
  )
}

function AddAdapter({
  settings,
  pending,
  onAdd,
}: {
  settings: Settings
  pending: boolean
  onAdd: (platform: string) => void
}) {
  const options = settings.available.filter((platform) => !(platform in settings.adapters))
  const [platform, setPlatform] = useState<string>()
  if (options.length === 0) return null
  const chosen = platform && options.includes(platform) ? platform : options[0]
  return (
    <motion.div variants={staggerItem}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border-strong px-5 py-4">
        <div className="mr-auto">
          <p className="text-[13.5px] font-medium text-fg">添加连接协议</p>
          <p className="mt-0.5 text-[12.5px] text-fg-3">以默认配置创建，保存后再在上面的表单中填写连接信息</p>
        </div>
        <Select
          aria-label="连接协议"
          value={chosen}
          onValueChange={setPlatform}
          options={options.map((item) => ({ value: item, label: platformName(item) }))}
          className="min-w-36"
        />
        <Button variant="secondary" loading={pending} onClick={() => chosen && onAdd(chosen)}>
          <Plus className="size-3.5" />
          添加
        </Button>
      </div>
    </motion.div>
  )
}
