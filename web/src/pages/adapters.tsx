import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  type JsonSchema,
  PageHeader,
  Skeleton,
  useFadeUp,
} from '@asabot/panel-ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Cable, ChevronRight, Plus, Radio } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { api } from '../lib/api.ts'
import { adapterPath, botDisplayName, botPath, connectionPath } from '../lib/management.ts'
import { Link, navigate, usePath } from '../lib/router.tsx'
import type { AdapterView } from '../lib/types.ts'
import { CapabilityPanel } from './bots.tsx'
import { ConnectionStatus } from './connections.tsx'

function SchemaFields({ schema }: { schema: JsonSchema }) {
  return (
    <dl className="divide-y divide-border">
      {Object.entries(schema.properties ?? {}).map(([name, field]) => (
        <div key={name} className="py-3">
          <dt className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            {field.title ?? name}
            <code className="font-mono text-[11.5px] font-normal text-fg-3">{name}</code>
            {schema.required?.includes(name) && <Badge>必填</Badge>}
            {field.writeOnly && <Badge tone="warning">凭据</Badge>}
          </dt>
          {field.description && <dd className="mt-1 text-[12.5px] text-fg-3">{field.description}</dd>}
          {field.properties && (
            <dd className="ml-3 border-l border-border pl-3">
              <SchemaFields schema={field} />
            </dd>
          )}
        </div>
      ))}
    </dl>
  )
}
export function AdaptersPage() {
  const id = usePath().split('/')[2]
  const fadeUp = useFadeUp()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={id ?? '/adapters'} {...fadeUp}>
        <AdapterContent id={id} />
      </motion.div>
    </AnimatePresence>
  )
}

function AdapterContent({ id }: { id?: string }) {
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters })
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections })
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots })
  if (adapters.error || connections.error || bots.error)
    return (
      <ErrorState
        error={(adapters.error ?? connections.error ?? bots.error) as Error}
        onRetry={() => {
          void adapters.refetch()
          void connections.refetch()
          void bots.refetch()
        }}
      />
    )
  if (!adapters.data || !connections.data || !bots.data) return <Skeleton className="h-64 rounded-xl" />
  const adapter = adapters.data.find((item) => item.id === (id ? decodeURIComponent(id) : ''))
  if (id && !adapter)
    return (
      <EmptyState
        icon={<Cable />}
        title="适配器未加载"
        action={<Button onClick={() => navigate('/adapters')}>返回适配器列表</Button>}
      />
    )
  if (!adapter)
    return (
      <>
        <PageHeader title="适配器" description="查看已加载的协议实现、连接方式和能力" />
        <div className="grid gap-4 md:grid-cols-2">
          {adapters.data.map((item) => (
            <AdapterCard
              key={item.id}
              adapter={item}
              count={connections.data?.filter((connection) => connection.adapter === item.id).length ?? 0}
            />
          ))}
        </div>
        <Card className="mt-5 p-5">
          <h2 className="text-sm font-semibold">添加外部适配器</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-3">
            在项目目录通过包管理器安装适配器包，将包名加入配置文件的{' '}
            <code className="font-mono">adapterModules</code> 后重启服务。加载成功后会出现在这里。
          </p>
        </Card>
      </>
    )
  const related = connections.data?.filter((item) => item.adapter === adapter.id) ?? []
  const relatedBots =
    bots.data?.filter((bot) => related.some((connection) => connection.id === bot.connectionId)) ?? []
  return (
    <>
      <Link
        to="/adapters"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg"
      >
        <ArrowLeft className="size-3.5" />
        适配器列表
      </Link>
      <PageHeader
        title={adapter.name}
        description={adapter.description}
        actions={
          <Button
            variant="primary"
            onClick={() => navigate(`/bots/connections/new/${encodeURIComponent(adapter.id)}`)}
          >
            <Plus className="size-3.5" />
            添加连接
          </Button>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <div className="px-5 py-4">
              <h2 className="text-sm font-semibold">适配器实现能力</h2>
            </div>
            <CapabilityPanel capabilities={adapter.capabilities} adapter />
          </Card>
          <Card className="p-5">
            {adapter.setup?.kind === 'qr' ? (
              <>
                <h2 className="text-sm font-semibold">接入方式</h2>
                <p className="mt-2 text-[13px] text-fg-3">扫码授权后保存连接。</p>
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold">配置字段</h2>
                <SchemaFields schema={adapter.configSchema} />
              </>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card className="space-y-3 p-5">
            <h2 className="text-sm font-semibold">版本与来源</h2>
            <p className="font-mono text-[13px]">v{adapter.version}</p>
            <p className="break-all text-[12.5px] text-fg-3">
              {adapter.source === 'builtin' ? '框架内置' : adapter.source}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {adapter.connectionTypes.map((type) => (
                <Badge key={type}>{type}</Badge>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">连接</h2>
            {!related.length ? (
              <p className="text-[13px] text-fg-3">尚未添加连接</p>
            ) : (
              <ul className="space-y-3">
                {related.map((connection) => (
                  <li key={connection.id} className="flex flex-wrap items-center justify-between gap-2">
                    <Link to={connectionPath(connection.id)} className="text-[13px] text-accent">
                      {connection.name}
                    </Link>
                    <ConnectionStatus state={connection.state} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {relatedBots.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">机器人</h2>
              <ul className="space-y-2">
                {relatedBots.map((bot) => (
                  <li key={`${bot.platform}:${bot.selfId}`}>
                    <Link className="break-all text-[13px] text-accent" to={botPath(bot)}>
                      {botDisplayName(bot)}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
function AdapterCard({ adapter, count }: { adapter: AdapterView; count: number }) {
  return (
    <Link to={adapterPath(adapter.id)}>
      <Card className="flex h-full flex-col gap-4 p-5 transition-colors hover:border-border-strong">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-3">
            <Radio className="size-5" />
          </span>
          <h2 className="text-[15px] font-semibold">{adapter.name}</h2>
          <span className="ml-auto font-mono text-xs text-fg-3">v{adapter.version}</span>
        </div>
        <p className="flex-1 text-[13px] leading-relaxed text-fg-3">{adapter.description}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{adapter.source === 'builtin' ? '内置' : '外部包'}</Badge>
          <span className="text-[12px] text-fg-3">{count} 条连接</span>
          <ChevronRight className="ml-auto size-4 text-fg-3" />
        </div>
      </Card>
    </Link>
  )
}
