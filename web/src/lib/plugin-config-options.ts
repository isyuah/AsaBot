import type { SchemaOptionsResolver } from '@asabot/panel-ui'
import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'
import type { PluginStateName } from './types.ts'

const labels: Record<PluginStateName, string> = {
  active: '',
  loading: '（加载中）',
  disabled: '（已停用）',
  failed: '（加载失败）',
}

export function usePluginConfigOptions(emptyLabel?: string): SchemaOptionsResolver {
  const catalog = useQuery({
    queryKey: ['pluginCatalog'],
    queryFn: ({ signal }) => api.pluginCatalog(signal),
  })
  return ({ consumes }) => {
    if (!catalog.data)
      return catalog.error && !catalog.isFetching
        ? { state: 'error', retry: () => void catalog.refetch() }
        : { state: 'loading' }
    return {
      state: 'ready',
      emptyLabel,
      options: catalog.data
        .filter((plugin) => consumes === undefined || plugin.inject.some(({ name }) => name === consumes))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, state }) => ({ value: name, label: `${name}${labels[state]}` })),
    }
  }
}
