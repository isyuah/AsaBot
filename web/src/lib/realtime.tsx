import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react'
import { api } from './api.ts'
import type {
  BotView,
  LiveMessage,
  LogEntry,
  LogRecord,
  Overview,
  PackageOperation,
  PluginView,
  ServerFrame,
  StatsPoint,
} from './types.ts'
import { createStore, type Store } from './utils.ts'

const maxLogs = 2000
const maxMessages = 60

let logSeq = 0
const toEntry = (record: LogRecord): LogEntry => ({ ...record, seq: ++logSeq })

export type ConnectionState = 'connecting' | 'open' | 'closed'

interface Realtime {
  connection: Store<ConnectionState>
  logs: Store<LogEntry[]>
  messages: Store<LiveMessage[]>
  operations: Store<PackageOperation[]>
}

const RealtimeContext = createContext<Realtime | null>(null)

const botKey = (bot: Pick<BotView, 'platform' | 'selfId'>) => `${bot.platform}:${bot.selfId}`

function upsertBot(list: BotView[] | undefined, bot: BotView): BotView[] | undefined {
  if (!list) return list
  const index = list.findIndex((item) => botKey(item) === botKey(bot))
  return index === -1 ? [...list, bot] : list.map((item, i) => (i === index ? bot : item))
}

function applyFrame(
  frame: ServerFrame,
  client: QueryClient,
  realtime: Realtime,
  pendingLogs: LogRecord[] | null,
) {
  switch (frame.type) {
    case 'hello':
      client.setQueryData<Overview>(['overview'], frame.overview)
      client.setQueryData<BotView[]>(['bots'], frame.overview.bots)
      break
    case 'bot':
      client.setQueryData<BotView[]>(['bots'], (list) => upsertBot(list, frame.bot))
      client.setQueryData<Overview>(['overview'], (overview) =>
        overview ? { ...overview, bots: upsertBot(overview.bots, frame.bot) ?? overview.bots } : overview,
      )
      break
    case 'plugin':
      client.setQueryData<PluginView[]>(['plugins'], (list) =>
        list?.map((item) => (item.name === frame.plugin.name ? frame.plugin : item)),
      )
      void client.invalidateQueries({ queryKey: ['overview'] })
      void client.invalidateQueries({ queryKey: ['commands'] })
      break
    case 'message': {
      const { type: _type, ...message } = frame
      realtime.messages.set((list) => [message, ...list].slice(0, maxMessages))
      client.setQueryData<Overview>(['overview'], (overview) =>
        overview
          ? {
              ...overview,
              today: {
                received: overview.today.received + (message.direction === 'in' ? 1 : 0),
                sent: overview.today.sent + (message.direction === 'out' ? 1 : 0),
              },
            }
          : overview,
      )
      break
    }
    case 'stats':
      client.setQueryData<StatsPoint[]>(['stats', '1h'], (points) => {
        if (!points) return points
        const rest = points.filter((point) => point.t !== frame.point.t)
        return [...rest, frame.point].sort((a, b) => a.t - b.t).slice(-60)
      })
      break
    case 'package': {
      const operation = frame.operation
      realtime.operations.set((list) =>
        [operation, ...list.filter((item) => item.id !== operation.id)]
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 20),
      )
      if (operation.status === 'succeeded' || operation.status === 'failed') {
        void client.invalidateQueries({ queryKey: ['plugins'] })
        void client.invalidateQueries({ queryKey: ['overview'] })
        void client.invalidateQueries({ queryKey: ['commands'] })
        void client.invalidateQueries({ queryKey: ['packageSearch'] })
      }
      break
    }
    case 'log':
      if (pendingLogs) pendingLogs.push(frame.record)
      else realtime.logs.set((list) => [...list, toEntry(frame.record)].slice(-maxLogs))
      break
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const realtime = useRealtimeStores()

  useEffect(() => {
    let socket: WebSocket | undefined
    let retry: number | undefined
    let attempt = 0
    let disposed = false

    const connect = () => {
      realtime.connection.set('connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${protocol}://${window.location.host}/api/panel/ws`)
      socket = ws
      // Log frames that arrive while the backlog is loading are held and merged afterwards.
      let pendingLogs: LogRecord[] | null = []

      ws.onopen = () => {
        attempt = 0
        realtime.connection.set('open')
        api
          .logs(500)
          .then((backlog) => {
            const last = backlog.at(-1)?.time ?? 0
            const fresh = (pendingLogs ?? []).filter((record) => record.time > last)
            realtime.logs.set([...backlog, ...fresh].slice(-maxLogs).map(toEntry))
          })
          .catch(() => {
            realtime.logs.set((list) => [...list, ...(pendingLogs ?? []).map(toEntry)].slice(-maxLogs))
          })
          .finally(() => {
            pendingLogs = null
          })
        api
          .packageOperations()
          .then((list) => realtime.operations.set(list))
          .catch(() => {})
        // Data fetched before the socket existed may be stale after a reconnect.
        void client.invalidateQueries()
      }
      ws.onmessage = (event) => {
        applyFrame(JSON.parse(String(event.data)) as ServerFrame, client, realtime, pendingLogs)
      }
      ws.onclose = () => {
        if (disposed) return
        realtime.connection.set('closed')
        const delay = Math.min(15_000, 1000 * 2 ** attempt)
        attempt += 1
        retry = window.setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [client, realtime])

  return <RealtimeContext value={realtime}>{children}</RealtimeContext>
}

let stores: Realtime | undefined
function useRealtimeStores(): Realtime {
  stores ??= {
    connection: createStore<ConnectionState>('connecting'),
    logs: createStore<LogEntry[]>([]),
    messages: createStore<LiveMessage[]>([]),
    operations: createStore<PackageOperation[]>([]),
  }
  return stores
}

function useRealtime(): Realtime {
  const value = useContext(RealtimeContext)
  if (!value) throw new Error('Realtime hooks must be used inside RealtimeProvider')
  return value
}

function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}

export const useConnection = () => useStore(useRealtime().connection)
export const useLiveLogs = () => useStore(useRealtime().logs)
export const useLiveMessages = () => useStore(useRealtime().messages)
export const usePackageOperations = () => useStore(useRealtime().operations)
/** Seed operations started from this tab before their first push frame arrives. */
export const useTrackOperation = () => {
  const { operations } = useRealtime()
  return (operation: PackageOperation) =>
    operations.set((list) => [operation, ...list.filter((item) => item.id !== operation.id)].slice(0, 20))
}
export const useClearLogs = () => {
  const { logs } = useRealtime()
  return () => logs.set([])
}
