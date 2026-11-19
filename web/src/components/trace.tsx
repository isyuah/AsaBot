import { type DispatchTrace, Skeleton, TraceView } from '@asabot/panel-ui'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api } from '../lib/api.ts'

/** Loads a trace from the history plugin and the matching logs still in the server's memory buffer. */
export function TraceLoader({ eventId }: { eventId: string }) {
  const trace = useQuery({
    queryKey: ['trace', eventId],
    queryFn: () => api.ext<DispatchTrace>('history', 'GET', `/traces/${encodeURIComponent(eventId)}`),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const logs = useQuery({
    queryKey: ['logs', 'event', eventId],
    queryFn: () => api.logs(200, eventId),
    staleTime: 30_000,
  })
  if (trace.isPending) return <Skeleton className="h-20" />
  if (trace.error)
    return (
      <p className="text-[12.5px] text-fg-3">
        {trace.error instanceof ApiError && trace.error.status === 404
          ? '这条消息没有处理记录（可能早于记录开始，或已被清理）。'
          : `无法加载处理记录：${trace.error.message}`}
      </p>
    )
  return <TraceView trace={trace.data} logs={logs.data} />
}
