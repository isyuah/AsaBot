import {
  Card,
  ErrorState,
  type JsonSchema,
  PageHeader,
  SchemaForm,
  Skeleton,
  softSpring,
  stagger,
  staggerItem,
} from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw, SlidersHorizontal, TerminalSquare } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { ApiError, api } from '../lib/api.ts'
import type { Settings, SettingsUpdate } from '../lib/types.ts'

const basicSchema: JsonSchema = {
  type: 'object',
  properties: {
    superusers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['platform', 'selfId', 'userId'],
        properties: {
          platform: { type: 'string', title: '平台' },
          selfId: { type: 'string', title: '机器人 ID' },
          userId: { type: 'string', title: '用户 ID' },
        },
      },
      title: '框架管理员',
      description:
        '身份绑定平台、机器人和用户，可在聊天中管理全局插件、安装包与访问控制。各机器人的管理员在机器人设置中配置',
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
    suggest: {
      type: 'string',
      title: '相似命令提示',
      description: '命令写错时回复“你是不是想用 /xxx？”，只提示不执行',
      oneOf: [
        { const: 'direct', title: '私聊和 @机器人 时' },
        { const: 'always', title: '所有带前缀的消息' },
        { const: 'off', title: '关闭' },
      ],
    },
  },
}

const restartLabels: Record<string, string> = { timezone: '时区' }

/** Which part of the settings a save came from: its issues and spinner belong to that card only. */
type Section = 'basic' | 'command'

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
  const save = useMutation({
    mutationFn: ({ input }: { section: Section; input: SettingsUpdate; message: string }) =>
      api.updateSettings(input),
    meta: { silent: true },
    onSuccess: (next, { message }) => {
      client.setQueryData<Settings>(['settings'], next)
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

          <Section icon={<SlidersHorizontal />} title="基本" description="框架管理员与时区">
            <SchemaForm
              schema={basicSchema}
              value={{ superusers: settings.data.superusers, timezone: settings.data.timezone }}
              issues={sectionIssues(failed('basic'), '')}
              saving={saving('basic')}
              note="管理员设置立即生效，时区在重启后生效"
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
        </motion.div>
      )}
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
