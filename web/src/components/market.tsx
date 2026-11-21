import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Segmented,
  Select,
  Sheet,
  Skeleton,
  Switch,
  softSpring,
  stagger,
  staggerItem,
} from '@asabot/panel-ui'
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpCircle,
  Download,
  ExternalLink,
  PackageSearch,
  Scale,
  Search,
  ShieldAlert,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, api } from '../lib/api.ts'
import { formatRelative } from '../lib/format.ts'
import { useTrackOperation } from '../lib/realtime.tsx'
import type { PackageDetail, PackageSearchItem, PackageSort, PackageVersion } from '../lib/types.ts'
import { PackageReadme } from './package-readme.tsx'

interface InstallTarget {
  name: string
  version: string
  description?: string
  /** Installed version, when this replaces an existing install. */
  installed?: string
  verb: InstallVerb
}

type InstallVerb = '安装' | '升级到' | '降级到' | '切换到'

/** Versions are listed newest first, so list position tells upgrade from downgrade. */
function installVerb(detail: PackageDetail, version: string): InstallVerb {
  if (!detail.installed) return '安装'
  const target = detail.versions.findIndex((item) => item.version === version)
  const current = detail.versions.findIndex((item) => item.version === detail.installed)
  if (current === -1) return '切换到'
  return target < current ? '升级到' : '降级到'
}

const sortOptions: { value: PackageSort; label: string }[] = [
  { value: 'relevance', label: '相关度' },
  { value: 'updated', label: '最近更新' },
  { value: 'name', label: '名称' },
]

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function PackageMarket() {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<PackageSort>('relevance')
  const debounced = useDebounced(query.trim(), 350)
  const [detail, setDetail] = useState<string | null>(null)
  const [installing, setInstalling] = useState<InstallTarget | null>(null)
  const search = useInfiniteQuery({
    queryKey: ['packageSearch', debounced, sort],
    queryFn: ({ pageParam }) => api.searchPackages(debounced, sort, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0)
      return last.items.length > 0 && loaded < last.total ? loaded : undefined
    },
    placeholderData: (previous) => previous,
    retry: false,
  })
  const items = search.data?.pages.flatMap((page) => page.items)
  const total = search.data?.pages[0]?.total

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          icon={<Search />}
          placeholder="搜索插件包（带有 asabot-plugin 关键词的 npm 包）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full max-w-md"
        />
        {total !== undefined && <span className="text-[12.5px] text-fg-3">共 {total} 个结果</span>}
        <Segmented value={sort} onChange={setSort} options={sortOptions} size="sm" className="ml-auto" />
      </div>
      {search.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {['a', 'b', 'c', 'd'].map((key) => (
            <Skeleton key={key} className="h-[132px] rounded-xl" />
          ))}
        </div>
      ) : search.error && !items ? (
        <Card>
          <EmptyState
            icon={<PackageSearch />}
            title="无法连接插件源"
            description={`${search.error.message}。可以在配置的 packages.registry 中换成可访问的镜像。`}
          />
        </Card>
      ) : !items || items.length === 0 ? (
        <Card>
          <EmptyState icon={<PackageSearch />} title="没有找到插件包" description="换个关键词试试。" />
        </Card>
      ) : (
        <>
          <motion.div
            key={`${debounced}:${sort}`}
            variants={stagger}
            initial="initial"
            animate="animate"
            className={cn(
              'grid gap-3 sm:grid-cols-2 transition-opacity',
              search.isPlaceholderData && 'opacity-60',
            )}
          >
            {items.map((item) => (
              <MarketCard
                key={item.name}
                item={item}
                onOpen={() => setDetail(item.name)}
                onInstall={() =>
                  setInstalling({
                    name: item.name,
                    version: item.version,
                    description: item.description,
                    verb: '安装',
                  })
                }
              />
            ))}
          </motion.div>
          {search.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                loading={search.isFetchingNextPage}
                onClick={() => void search.fetchNextPage()}
              >
                加载更多
                <span className="text-fg-3 tabular">
                  {items.length} / {total}
                </span>
              </Button>
            </div>
          )}
        </>
      )}
      <PackageSheet name={detail} onClose={() => setDetail(null)} onInstall={setInstalling} />
      <InstallDialog target={installing} onClose={() => setInstalling(null)} />
    </div>
  )
}

function MarketCard({
  item,
  onOpen,
  onInstall,
}: {
  item: PackageSearchItem
  onOpen: () => void
  onInstall: () => void
}) {
  const upgradable = item.installed && item.installedVersion !== item.version
  return (
    <motion.div variants={staggerItem} whileHover={{ y: -2 }} transition={softSpring}>
      {/* The title button is the keyboard entry point; the card itself is a larger mouse target. */}
      <Card
        className="flex h-full cursor-pointer flex-col p-4 transition-[border-color] hover:border-border-strong"
        onClick={onOpen}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onOpen()
                }}
                className="cursor-pointer truncate rounded font-mono text-[13.5px] font-semibold outline-none focus-visible:shadow-[0_0_0_3px_var(--ring)]"
              >
                {item.name}
              </button>
              <span className="font-mono text-[11px] text-fg-3">v{item.version}</span>
            </div>
            <div className="mt-0.5 text-[11.5px] text-fg-3">
              {[item.author, item.date && formatRelative(Date.parse(item.date))].filter(Boolean).join(' · ')}
            </div>
          </div>
          {item.installed ? (
            <Badge tone={upgradable ? 'info' : 'success'} dot>
              {upgradable ? `已安装 v${item.installedVersion}` : '已安装'}
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={(event) => {
                event.stopPropagation()
                onInstall()
              }}
            >
              <Download className="size-3.5" />
              安装
            </Button>
          )}
        </div>
        <p className="mt-3 line-clamp-2 min-h-[38px] text-[13px] leading-relaxed text-fg-2">
          {item.description || '没有描述'}
        </p>
        <div className="mt-auto pt-3">
          <PackageLinks links={item.links} />
        </div>
      </Card>
    </motion.div>
  )
}

function PackageLinks({ links }: { links: PackageSearchItem['links'] }) {
  return (
    <div className="flex gap-3 text-[12px]">
      {[
        ['npm', links.npm],
        ['主页', links.homepage],
        ['源码', links.repository],
      ]
        .filter((link): link is [string, string] => Boolean(link[1]))
        .map(([label, href]) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 text-fg-3 transition-colors hover:text-fg"
          >
            {label}
            <ExternalLink className="size-3" />
          </a>
        ))}
    </div>
  )
}

/** Default pick: the newest compatible, non-deprecated version, else the newest one. */
function preferredVersion(detail: PackageDetail): string | undefined {
  return (
    detail.versions.find((item) => item.compatible && !item.deprecated)?.version ??
    detail.versions[0]?.version
  )
}

function versionLabel(item: PackageVersion, detail: PackageDetail) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono">v{item.version}</span>
      {item.version === detail.latest && <span className="text-[11px] text-accent-soft-fg">最新</span>}
      {item.version === detail.installed && <span className="text-[11px] text-success">已安装</span>}
      {!item.compatible && <span className="text-[11px] text-danger">不兼容</span>}
      {item.deprecated && <span className="text-[11px] text-warning">已弃用</span>}
    </span>
  )
}

function PackageSheet({
  name,
  onClose,
  onInstall,
}: {
  name: string | null
  onClose: () => void
  onInstall: (target: InstallTarget) => void
}) {
  // Keep the last name while the sheet animates out so the content does not blank mid-exit.
  const [shown, setShown] = useState(name)
  useEffect(() => {
    if (name !== null) setShown(name)
  }, [name])
  const info = useQuery({
    queryKey: ['packageInfo', shown],
    queryFn: () => api.packageInfo(shown as string),
    enabled: shown !== null,
    staleTime: 5 * 60_000,
    retry: false,
  })
  // Remembered per package, so opening another package starts from its own default version.
  const [picked, setPicked] = useState<{ name: string; version: string }>()
  const detail = info.data
  const version = picked?.name === shown ? picked.version : detail && preferredVersion(detail)
  const selected = detail?.versions.find((item) => item.version === version)

  return (
    <Sheet
      open={name !== null}
      onOpenChange={(open) => !open && onClose()}
      title={<span className="font-mono">{shown}</span>}
      subtitle={detail?.description ?? (info.isPending ? '加载中…' : undefined)}
    >
      {info.error && !detail ? (
        <ErrorState error={info.error} onRetry={() => void info.refetch()} retrying={info.isFetching} />
      ) : !detail || !version ? (
        <div className="space-y-3 p-6">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : (
        <div>
          <div className="space-y-3 border-b border-border px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="选择版本"
                value={version}
                onValueChange={(next) => setPicked({ name: detail.name, version: next })}
                options={detail.versions.map((item) => ({
                  value: item.version,
                  label: versionLabel(item, detail),
                }))}
                className="min-w-48"
              />
              <Button
                variant="primary"
                disabled={version === detail.installed}
                onClick={() =>
                  onInstall({
                    name: detail.name,
                    version,
                    description: detail.description,
                    installed: detail.installed,
                    verb: installVerb(detail, version),
                  })
                }
              >
                {detail.installed ? (
                  <ArrowUpCircle className="size-3.5" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {version === detail.installed
                  ? '已安装此版本'
                  : `${installVerb(detail, version)} v${version}`}
              </Button>
            </div>
            <AnimatePresence initial={false}>
              {selected && (!selected.compatible || selected.deprecated) && (
                <motion.div
                  key={version}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={softSpring}
                  className="overflow-hidden"
                >
                  <div className="space-y-1 rounded-xl bg-warning-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warning">
                    {!selected.compatible && (
                      <p className="flex gap-2">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        {selected.peerRange
                          ? `这个版本要求 asabot ${selected.peerRange}，与当前框架版本不兼容。`
                          : '这个版本没有声明支持的 asabot 版本。'}
                      </p>
                    )}
                    {selected.deprecated && (
                      <p className="flex gap-2">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        已弃用：{selected.deprecated}
                      </p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-fg-3">
              {detail.license && (
                <span className="inline-flex items-center gap-1">
                  <Scale className="size-3.5" />
                  {detail.license}
                </span>
              )}
              {selected?.date && <span>发布于 {formatRelative(Date.parse(selected.date))}</span>}
              <PackageLinks links={detail.links} />
            </div>
          </div>
          <PackageReadme className="px-6 py-5" readme={detail.readme} />
        </div>
      )}
    </Sheet>
  )
}

function InstallDialog({ target, onClose }: { target: InstallTarget | null; onClose: () => void }) {
  const track = useTrackOperation()
  const [force, setForce] = useState(false)
  const [incompatible, setIncompatible] = useState<string | null>(null)
  const reset = () => {
    setForce(false)
    setIncompatible(null)
  }
  const install = useMutation({
    mutationFn: (next: InstallTarget) =>
      api.installPackage({ name: next.name, version: next.version, force }),
    meta: { silent: true },
    onSuccess: (operation) => {
      track(operation)
      reset()
      onClose()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setIncompatible(error.message)
      else toast.error(error.message)
    },
  })
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (open) return
        reset()
        onClose()
      }}
      title={`${target?.verb === '安装' ? '安装' : '更换版本'} ${target?.name ?? ''}`}
      description={
        target?.installed
          ? `从 v${target.installed} ${target.verb} v${target.version}。`
          : target?.description
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={install.isPending}
            disabled={incompatible !== null && !force}
            onClick={() => target && install.mutate(target)}
          >
            <Download className="size-3.5" />
            {target?.verb} v{target?.version}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2.5 rounded-xl bg-warning-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          插件与框架运行在同一进程中，拥有完整权限。只安装你信任的插件包。
        </div>
        <AnimatePresence>
          {incompatible && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={softSpring}
              className="overflow-hidden"
            >
              <div className="space-y-3 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-3">
                <p className="text-[12.5px] text-danger">{incompatible}</p>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="force-install" className="cursor-pointer text-[12.5px] text-fg-2">
                    忽略版本要求，强制安装
                  </label>
                  <Switch id="force-install" checked={force} onCheckedChange={setForce} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  )
}
