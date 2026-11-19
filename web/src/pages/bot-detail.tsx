import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  type JsonSchema,
  PageHeader,
  PageTabs,
  SchemaForm,
  Skeleton,
  useFadeUp,
} from '@asabot/panel-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Cable, Radio, Send } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { BotPlugins } from '../components/bot-plugins.tsx'
import { api } from '../lib/api.ts'
import { botPath, connectionPath, invalidatePolicies, timeText } from '../lib/management.ts'
import { Link, navigate } from '../lib/router.tsx'
import type { BotView, ChannelTarget } from '../lib/types.ts'
import { CapabilityPanel, GroupList, SendDialog } from './bots.tsx'
import { ConnectionStatus } from './connections.tsx'

function adminSchema(platform: string): JsonSchema {
  return {
    type: 'object',
    properties: {
      admins: {
        type: 'array',
        title: '机器人管理员',
        items: { type: 'string' },
        description:
          platform === 'feishu'
            ? '填写当前飞书应用下的用户 open_id（ou_ 开头），不是 user_id。可发送 whoami 命令查看。'
            : '填写这个机器人所属平台的用户 ID，可发送 whoami 命令查看。仅能管理本机器人的插件开关和群规则。',
      },
    },
  }
}
const tabs = [
  { value: 'overview', label: '概览' },
  { value: 'plugins', label: '插件' },
  { value: 'groups', label: '群组' },
  { value: 'settings', label: '设置' },
]

export function BotDetailPage({ path }: { path: string }) {
  const fadeUp = useFadeUp()
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  const identity = { platform: parts[1] ?? '', selfId: parts[2] ?? '' }
  const schema = useMemo(() => adminSchema(identity.platform), [identity.platform])
  const tab = parts[3] ?? 'overview'
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['bot', identity.platform, identity.selfId],
    queryFn: () => api.bot(identity),
  })
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections })
  const [sendTo, setSendTo] = useState<{ bot: BotView; target?: ChannelTarget } | null>(null)
  const saveAdmins = useMutation({
    mutationFn: (admins: string[]) => api.botAdmins(identity, admins),
    onSuccess: () => {
      invalidatePolicies(client)
      toast.success('机器人管理员已保存')
    },
  })
  const adminValue = useMemo(() => ({ admins: detail.data?.admins ?? [] }), [detail.data?.admins])
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
  if (!detail.data) return <Skeleton className="h-64 rounded-xl" />
  const { bot, plugins } = detail.data
  const connection = connections.data?.find((item) => item.id === bot.connectionId)
  return (
    <>
      <Link to="/bots" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" />
        机器人列表
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Avatar id={bot.selfId} name={bot.nickname} src={bot.avatar} size={44} />
            <span>{bot.nickname || bot.selfId}</span>
            <Badge tone={bot.status === 'online' ? 'success' : 'neutral'} dot>
              {bot.status === 'online' ? '在线' : bot.status === 'connecting' ? '连接中' : '离线'}
            </Badge>
          </span>
        }
        description={`${bot.platform} · ${bot.selfId}`}
        actions={
          <Button disabled={bot.status !== 'online'} onClick={() => setSendTo({ bot })}>
            <Send className="size-3.5" />
            发送消息
          </Button>
        }
      />
      <PageTabs
        value={tab}
        onChange={(value) => navigate(botPath(bot, value))}
        tabs={tabs}
        className="mb-5"
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} {...fadeUp}>
          {tab === 'overview' && (
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
              <Card className="overflow-hidden">
                <div className="px-5 py-4">
                  <h2 className="text-sm font-semibold">机器人能力</h2>
                </div>
                <CapabilityPanel capabilities={bot.capabilities} />
              </Card>
              <div className="space-y-4">
                <Card className="space-y-3 p-5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Cable className="size-4 text-fg-3" />
                    关联连接
                  </h2>
                  {connection ? (
                    <>
                      <Link to={connectionPath(connection.id)} className="block text-[13.5px] text-accent">
                        {connection.name}
                      </Link>
                      <ConnectionStatus state={connection.state} />
                      <p className="text-[12px] text-fg-3">最近上线 {timeText(connection.lastConnectedAt)}</p>
                      {connection.lastError && (
                        <p className="break-words text-[12.5px] text-danger">{connection.lastError}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-[13px] text-fg-3">{bot.connection || '程序注册的机器人'}</p>
                  )}
                </Card>
                <Card className="p-5">
                  <h2 className="text-sm font-semibold">插件应用</h2>
                  <p className="mt-2 text-[13px] text-fg-3">
                    {plugins.filter((plugin) => plugin.botEnabled && plugin.state === 'active').length}{' '}
                    个插件生效
                  </p>
                  <Link to={botPath(bot, 'plugins')} className="mt-3 inline-block text-[13px] text-accent">
                    管理插件与配置覆盖
                  </Link>
                </Card>
                <Link
                  to={`/logs?platform=${encodeURIComponent(bot.platform)}&selfId=${encodeURIComponent(bot.selfId)}`}
                  className="block px-1 text-[13px] text-accent"
                >
                  查看机器人日志
                </Link>
              </div>
            </div>
          )}
          {tab === 'plugins' && (
            <BotPlugins key={parts[4] ?? 'all'} bot={bot} plugins={plugins} initialOpen={parts[4]} />
          )}
          {tab === 'groups' && (
            <Card className="overflow-hidden">
              {bot.status === 'online' ? (
                <GroupList bot={bot} onSend={(id) => setSendTo({ bot, target: { type: 'group', id } })} />
              ) : (
                <EmptyState
                  icon={<Radio />}
                  title="机器人当前离线"
                  description="连接恢复后可获取群列表，已保存的规则仍可在群组页面管理。"
                  action={<Button onClick={() => navigate('/groups')}>已保存的群规则</Button>}
                />
              )}
            </Card>
          )}
          {tab === 'settings' && (
            <div className="max-w-3xl space-y-4">
              <Card className="p-6">
                <h2 className="mb-4 text-sm font-semibold">管理员</h2>
                <SchemaForm
                  schema={schema}
                  value={adminValue}
                  issues={{}}
                  saving={saveAdmins.isPending}
                  note="保存后立即生效"
                  submitLabel="保存管理员"
                  onSubmit={(value) => saveAdmins.mutate((value as { admins: string[] }).admins)}
                />
              </Card>
              {bot.connectionId && (
                <Card className="flex items-center justify-between gap-3 p-5">
                  <span className="text-sm text-fg-2">连接凭据、启停与重连</span>
                  <Link className="text-[13px] text-accent" to={connectionPath(bot.connectionId)}>
                    进入连接设置
                  </Link>
                </Card>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      <SendDialog state={sendTo} onClose={() => setSendTo(null)} />
    </>
  )
}
