import type {
  AccessEntry,
  ApiErrorBody,
  BotView,
  CommandView,
  GroupView,
  LogRecord,
  Overview,
  PackageOperation,
  PackageSearchItem,
  PlaygroundReply,
  PlaygroundRequest,
  PluginView,
  Segment,
  StatsPoint,
  Target,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: { path: string; message: string }[]

  constructor(
    status: number,
    code: string,
    message: string,
    issues: { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.issues = issues
  }
}

/** Called whenever the server answers 401, so the app can drop back to the login screen. */
let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/panel${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', '无法连接到 AsaBot，请确认服务正在运行')
  }
  if (response.status === 401 && path !== '/login') onUnauthorized()
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as ApiErrorBody | null
    const error = parsed?.error
    throw new ApiError(
      response.status,
      error?.code ?? 'http',
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      error?.issues,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const encode = encodeURIComponent

export const api = {
  session: () => request<{ authenticated: boolean }>('GET', '/session'),
  login: (password: string) => request<{ ok: true }>('POST', '/login', { password }),
  logout: () => request<unknown>('POST', '/logout', {}),

  overview: () => request<Overview>('GET', '/overview'),
  stats: (range: '1h' | '24h') => request<StatsPoint[]>('GET', `/stats/messages?range=${range}`),

  bots: () => request<BotView[]>('GET', '/bots'),
  groups: (bot: Pick<BotView, 'platform' | 'selfId'>) =>
    request<GroupView[]>('GET', `/bots/${encode(bot.platform)}/${encode(bot.selfId)}/groups`),
  send: (input: { platform?: string; selfId?: string; target: Target; message: string | Segment[] }) =>
    request<{ messageId: string }>('POST', '/send', input),

  plugins: () => request<PluginView[]>('GET', '/plugins'),
  pluginAction: (name: string, action: 'enable' | 'disable' | 'reload') =>
    request<PluginView>('POST', `/plugins/${encode(name)}/${action}`, {}),
  pluginConfig: (name: string, config: unknown) =>
    request<PluginView>('PUT', `/plugins/${encode(name)}/config`, { config }),
  pluginGroups: (name: string) =>
    request<{ groupKey: string; enabled: boolean }[]>('GET', `/plugins/${encode(name)}/groups`),
  setPluginGroup: (name: string, groupKey: string, enabled: boolean) =>
    request<unknown>('PUT', `/plugins/${encode(name)}/groups/${encode(groupKey)}`, { enabled }),

  rescanPlugins: () =>
    request<{ added: string[]; removed: string[]; plugins: PluginView[] }>('POST', '/plugins/rescan', {}),
  uploadPlugin: (input: { filename: string; content: string; overwrite?: boolean }) =>
    request<PluginView>('POST', '/plugins/upload', input),
  uninstallPlugin: (name: string, purge: boolean) =>
    request<{ ok: true }>('POST', `/plugins/${encode(name)}/uninstall`, { purge }),

  searchPackages: (q: string, from = 0) =>
    request<{ total: number; items: PackageSearchItem[] }>(
      'GET',
      `/packages/search?q=${encode(q)}&from=${from}`,
    ),
  installPackage: (input: { name: string; version?: string; force?: boolean }) =>
    request<PackageOperation>('POST', '/packages/install', input),
  updatePackage: (name: string) => request<PackageOperation>('POST', '/packages/update', { name }),
  uninstallPackage: (name: string, purge: boolean) =>
    request<PackageOperation>('POST', '/packages/uninstall', { name, purge }),
  packageOperations: () => request<PackageOperation[]>('GET', '/packages/operations'),

  commands: () => request<CommandView[]>('GET', '/commands'),

  acl: () => request<AccessEntry[]>('GET', '/acl'),
  addAcl: (entry: AccessEntry) => request<unknown>('POST', '/acl', entry),
  removeAcl: (entry: AccessEntry) => request<unknown>('DELETE', '/acl', entry),

  logs: (limit = 500) => request<LogRecord[]>('GET', `/logs?limit=${limit}&level=10`),

  playground: (input: PlaygroundRequest) =>
    request<{ replies: PlaygroundReply[] }>('POST', '/playground', input),
}
