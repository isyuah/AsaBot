import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileUp,
  PackageSearch,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, api } from '../lib/api.ts'
import { formatRelative } from '../lib/format.ts'
import { softSpring, spring, stagger, staggerItem } from '../lib/motion.ts'
import { usePackageOperations, useTrackOperation } from '../lib/realtime.tsx'
import type { PackageOperation, PackageSearchItem, PluginView } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Dialog } from './ui/dialog.tsx'
import { Input } from './ui/input.tsx'
import { Badge, Card, EmptyState, Skeleton, Spinner } from './ui/primitives.tsx'
import { Switch } from './ui/switch.tsx'

const maxUploadBytes = 2 * 1024 * 1024

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Whether a newer version than the installed one is known. */
export function hasUpdate(plugin: PluginView): boolean {
  const info = plugin.package
  return Boolean(info?.latest && info.latest !== info.version)
}

// ─── Upload ────────────────────────────────────────────────────────────────

export function UploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [conflict, setConflict] = useState(false)
  const upload = useMutation({
    mutationFn: async ({ file, overwrite }: { file: File; overwrite: boolean }) =>
      api.uploadPlugin({ filename: file.name, content: await toBase64(file), overwrite }),
    meta: { silent: true },
    onSuccess: (plugin) => {
      void client.invalidateQueries({ queryKey: ['plugins'] })
      void client.invalidateQueries({ queryKey: ['commands'] })
      if (plugin.state === 'failed')
        toast.error(`${plugin.name} 已上传，但加载失败`, { description: plugin.error })
      else toast.success(`已安装 ${plugin.name}`)
      close()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(true)
      else toast.error(error.message)
    },
  })

  const close = () => {
    onOpenChange(false)
    setFile(null)
    setConflict(false)
  }
  const pick = (next: File | undefined) => {
    if (!next) return
    if (!/\.(ts|js|zip)$/i.test(next.name)) return toast.error('只支持 .ts、.js 或 .zip 文件')
    if (next.size > maxUploadBytes) return toast.error('文件不能超过 2 MB')
    setFile(next)
    setConflict(false)
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    pick(event.dataTransfer.files[0])
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="上传插件"
      description="单个 .ts / .js 插件文件，或包含 index.ts 的 .zip 包。上传后立即加载。"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            variant={conflict ? 'danger' : 'primary'}
            disabled={!file}
            loading={upload.isPending}
            onClick={() => file && upload.mutate({ file, overwrite: conflict })}
          >
            {conflict ? '覆盖并重载' : '上传'}
          </Button>
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".ts,.js,.zip"
        className="hidden"
        onChange={(event) => pick(event.target.files?.[0])}
      />
      <motion.button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        animate={{ scale: dragging ? 1.015 : 1 }}
        transition={spring}
        className={cn(
          'flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-9 text-center transition-colors',
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-border-strong bg-surface-2/50 hover:bg-surface-2',
        )}
      >
        <motion.span
          animate={{ y: dragging ? -4 : 0 }}
          transition={spring}
          className="mb-3 flex size-10 items-center justify-center rounded-xl bg-surface text-accent shadow-card"
        >
          <FileUp className="size-5" />
        </motion.span>
        {file ? (
          <>
            <span className="font-mono text-[13px] text-fg">{file.name}</span>
            <span className="mt-1 text-[12px] text-fg-3">{(file.size / 1024).toFixed(1)} KB · 点击更换</span>
          </>
        ) : (
          <>
            <span className="text-[13.5px] font-medium text-fg">拖拽文件到这里，或点击选择</span>
            <span className="mt-1 text-[12px] text-fg-3">最大 2 MB</span>
          </>
        )}
      </motion.button>
      <AnimatePresence>
        {conflict && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div className="mt-3 flex gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-[12.5px] text-warning">
              <AlertTriangle className="mt-px size-4 shrink-0" />
              已存在同名插件。覆盖会替换原有文件并重新加载插件。
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Dialog>
  )
}

// ─── Uninstall ─────────────────────────────────────────────────────────────

export function UninstallDialog({ plugin, onClose }: { plugin: PluginView | null; onClose: () => void }) {
  const client = useQueryClient()
  const track = useTrackOperation()
  const [purge, setPurge] = useState(false)
  const uninstall = useMutation({
    mutationFn: async (target: PluginView) => {
      if (target.source === 'package' && target.package) {
        track(await api.uninstallPackage(target.package.name, purge))
        return 'queued' as const
      }
      await api.uninstallPlugin(target.name, purge)
      return 'done' as const
    },
    onSuccess: (result, target) => {
      if (result === 'done') {
        toast.success(`已卸载 ${target.name}`)
        void client.invalidateQueries({ queryKey: ['plugins'] })
        void client.invalidateQueries({ queryKey: ['commands'] })
      }
      setPurge(false)
      onClose()
    },
  })
  return (
    <Dialog
      open={plugin !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`卸载 ${plugin?.name ?? ''}`}
      description={
        plugin?.source === 'package'
          ? `将通过 npm 卸载插件包 ${plugin.package?.name ?? ''}。`
          : '将删除插件目录中的插件文件。依赖它的插件会被停用。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={uninstall.isPending}
            onClick={() => plugin && uninstall.mutate(plugin)}
          >
            <Trash2 className="size-3.5" />
            卸载
          </Button>
        </>
      }
    >
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border px-4 py-3">
        <label htmlFor="purge" className="cursor-pointer">
          <span className="block text-[13px] font-medium">同时清理数据</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-fg-3">
            删除它的配置、存储的数据、数据表和数据目录。不清理的话，重新安装后可以继续使用原来的数据。
          </span>
        </label>
        <Switch id="purge" checked={purge} onCheckedChange={setPurge} />
      </div>
    </Dialog>
  )
}

// ─── Market ────────────────────────────────────────────────────────────────

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
  const debounced = useDebounced(query.trim(), 350)
  const [installing, setInstalling] = useState<PackageSearchItem | null>(null)
  const search = useQuery({
    queryKey: ['packageSearch', debounced],
    queryFn: () => api.searchPackages(debounced),
    placeholderData: (previous) => previous,
    retry: false,
  })

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
        {search.data && <span className="text-[12.5px] text-fg-3">共 {search.data.total} 个结果</span>}
      </div>
      {search.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {['a', 'b', 'c', 'd'].map((key) => (
            <Skeleton key={key} className="h-[132px] rounded-xl" />
          ))}
        </div>
      ) : search.error ? (
        <Card>
          <EmptyState
            icon={<PackageSearch />}
            title="无法连接插件源"
            description={`${search.error.message}。可以在配置的 packages.registry 中换成可访问的镜像。`}
          />
        </Card>
      ) : search.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<PackageSearch />} title="没有找到插件包" description="换个关键词试试。" />
        </Card>
      ) : (
        <motion.div
          key={debounced}
          variants={stagger}
          initial="initial"
          animate="animate"
          className={cn(
            'grid gap-3 sm:grid-cols-2 transition-opacity',
            search.isPlaceholderData && 'opacity-60',
          )}
        >
          {search.data.items.map((item) => (
            <MarketCard key={item.name} item={item} onInstall={() => setInstalling(item)} />
          ))}
        </motion.div>
      )}
      <InstallDialog item={installing} onClose={() => setInstalling(null)} />
    </div>
  )
}

function MarketCard({ item, onInstall }: { item: PackageSearchItem; onInstall: () => void }) {
  const upgradable = item.installed && item.installedVersion !== item.version
  return (
    <motion.div variants={staggerItem} whileHover={{ y: -2 }} transition={softSpring}>
      <Card className="flex h-full flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[13.5px] font-semibold">{item.name}</span>
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
            <Button size="sm" variant="primary" onClick={onInstall}>
              <Download className="size-3.5" />
              安装
            </Button>
          )}
        </div>
        <p className="mt-3 line-clamp-2 min-h-[38px] text-[13px] leading-relaxed text-fg-2">
          {item.description || '没有描述'}
        </p>
        <div className="mt-auto flex gap-3 pt-3 text-[12px]">
          {[
            ['npm', item.links.npm],
            ['主页', item.links.homepage],
            ['源码', item.links.repository],
          ]
            .filter((link): link is [string, string] => Boolean(link[1]))
            .map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-fg-3 transition-colors hover:text-fg"
              >
                {label}
                <ExternalLink className="size-3" />
              </a>
            ))}
        </div>
      </Card>
    </motion.div>
  )
}

function InstallDialog({ item, onClose }: { item: PackageSearchItem | null; onClose: () => void }) {
  const track = useTrackOperation()
  const [force, setForce] = useState(false)
  const [incompatible, setIncompatible] = useState<string | null>(null)
  const install = useMutation({
    mutationFn: (target: PackageSearchItem) => api.installPackage({ name: target.name, force }),
    meta: { silent: true },
    onSuccess: (operation) => {
      track(operation)
      setForce(false)
      setIncompatible(null)
      onClose()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setIncompatible(error.message)
      else toast.error(error.message)
    },
  })
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (open) return
        setForce(false)
        setIncompatible(null)
        onClose()
      }}
      title={`安装 ${item?.name ?? ''}`}
      description={item?.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={install.isPending}
            disabled={incompatible !== null && !force}
            onClick={() => item && install.mutate(item)}
          >
            <Download className="size-3.5" />
            安装 v{item?.version}
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

// ─── Operations dock ───────────────────────────────────────────────────────

const kindLabel = { install: '安装', update: '升级', uninstall: '卸载' } as const

/** Floating panel for npm operations, visible on every page while a task runs or just finished. */
export function OperationsDock() {
  const operations = usePackageOperations()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(timer)
  }, [])
  // Running tasks stay; finished ones linger briefly (failures longer, so the error can be read).
  const visible = operations.filter(
    (operation) =>
      !dismissed.has(operation.id) &&
      (operation.status === 'queued' ||
        operation.status === 'running' ||
        now - (operation.finishedAt ?? now) < (operation.status === 'failed' ? 60_000 : 8_000)),
  )
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {visible.map((operation) => (
          <OperationCard
            key={operation.id}
            operation={operation}
            onDismiss={() => setDismissed((set) => new Set(set).add(operation.id))}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

function OperationCard({ operation, onDismiss }: { operation: PackageOperation; onDismiss: () => void }) {
  const [open, setOpen] = useState(operation.status === 'failed')
  const logRef = useRef<HTMLPreElement>(null)
  const active = operation.status === 'queued' || operation.status === 'running'
  useEffect(() => {
    if (operation.status === 'failed') setOpen(true)
  }, [operation.status])
  useEffect(() => {
    if (open && operation.log.length > 0) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [open, operation.log.length])
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
      transition={spring}
      className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg',
            active && 'bg-accent-soft text-accent-soft-fg',
            operation.status === 'succeeded' && 'bg-success-soft text-success',
            operation.status === 'failed' && 'bg-danger-soft text-danger',
          )}
        >
          {active ? (
            <Spinner className="size-3.5" />
          ) : operation.status === 'succeeded' ? (
            <Check className="size-3.5" strokeWidth={2.5} />
          ) : (
            <X className="size-3.5" strokeWidth={2.5} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">
            {kindLabel[operation.kind]} <span className="font-mono">{operation.name}</span>
          </div>
          <div className="truncate text-[12px] text-fg-3">
            {operation.status === 'queued'
              ? '排队中…'
              : operation.status === 'running'
                ? (operation.log.at(-1) ?? '正在执行 npm…')
                : operation.status === 'succeeded'
                  ? `完成${operation.plugin ? `，插件 ${operation.plugin.name} 已${operation.kind === 'uninstall' ? '移除' : '加载'}` : ''}`
                  : (operation.error ?? '失败')}
          </div>
        </div>
        {operation.log.length > 0 && (
          <Button variant="ghost" size="icon-sm" aria-label="查看日志" onClick={() => setOpen(!open)}>
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={softSpring}>
              <ChevronDown className="size-3.5" />
            </motion.span>
          </Button>
        )}
        {!active && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={onDismiss}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      {active && (
        <div className="h-0.5 overflow-hidden bg-surface-2">
          <motion.div
            className="h-full w-1/3 rounded-full bg-accent"
            animate={{ x: ['-100%', '300%'] }}
            transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
          />
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={softSpring}
            className="overflow-hidden border-t border-border"
          >
            <pre
              ref={logRef}
              className="max-h-48 overflow-y-auto bg-surface-2/60 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2"
            >
              {operation.log.join('\n')}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** Small inline action used on plugin cards and the drawer for package plugins with a newer version. */
export function UpdateButton({ plugin, size = 'sm' }: { plugin: PluginView; size?: 'sm' | 'md' }) {
  const track = useTrackOperation()
  const update = useMutation({
    mutationFn: () => api.updatePackage(plugin.package?.name ?? plugin.name),
    onSuccess: track,
  })
  if (!hasUpdate(plugin)) return null
  return (
    <Button variant="soft" size={size} loading={update.isPending} onClick={() => update.mutate()}>
      <ArrowUpCircle className="size-3.5" />
      升级到 v{plugin.package?.latest}
    </Button>
  )
}
