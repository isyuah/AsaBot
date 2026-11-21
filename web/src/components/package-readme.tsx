import { cn, EmptyState, ErrorState, Skeleton } from '@asabot/panel-ui'
import { useQuery } from '@tanstack/react-query'
import { BookOpen } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { api } from '../lib/api.ts'
import type { PackageInfo } from '../lib/types.ts'

const Markdown = lazy(() =>
  import('@asabot/panel-ui/markdown').then((module) => ({ default: module.Markdown })),
)

function ReadmeSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)}>
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  )
}

export function PackageReadme({ readme, className }: { readme?: string; className?: string }) {
  if (!readme?.trim())
    return <EmptyState icon={<BookOpen />} title="没有 README" description="这个插件包没有提供说明文档。" />
  return (
    <Suspense fallback={<ReadmeSkeleton className={className} />}>
      <Markdown className={className}>{readme}</Markdown>
    </Suspense>
  )
}

export function InstalledPluginReadme({ name, info }: { name: string; info: PackageInfo }) {
  const result = useQuery({
    queryKey: ['pluginReadme', name, info.name, info.version],
    queryFn: () => api.pluginReadme(name),
  })
  if (result.error && !result.data)
    return (
      <ErrorState error={result.error} onRetry={() => void result.refetch()} retrying={result.isFetching} />
    )
  if (!result.data) return <ReadmeSkeleton />
  return <PackageReadme readme={result.data.readme} />
}
