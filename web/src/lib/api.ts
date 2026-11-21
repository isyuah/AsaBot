import type { LogRecord, Segment, StatsPoint } from '@asabot/panel-ui'
import type {
  AccessEntry,
  AdapterView,
  ApiErrorBody,
  BotDetail,
  BotGroup,
  BotPluginView,
  BotView,
  CommandOverride,
  CommandView,
  ConnectionInput,
  ConnectionSetup,
  ConnectionView,
  GroupDetail,
  GroupView,
  LogLevel,
  Overview,
  PackageDetail,
  PackageOperation,
  PackageSearchItem,
  PackageSort,
  PlaygroundEventRequest,
  PlaygroundRequest,
  PlaygroundResult,
  PluginGroupSetting,
  PluginView,
  Session,
  Settings,
  SettingsUpdate,
  SetupInput,
  Target,
  TaskAttempt,
  TaskRecord,
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

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/panel${path}`, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', '无法连接到 AsaBot，请确认服务正在运行')
  }
  // A wrong password or setup code is a 401 too, but it must not reset the screen the user is typing into.
  if (response.status === 401 && path !== '/login' && path !== '/setup') onUnauthorized()
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
  session: () => request<Session>('GET', '/session'),
  setup: (input: SetupInput) => request<{ ok: true }>('POST', '/setup', input),
  login: (password: string) => request<{ ok: true }>('POST', '/login', { password }),
  logout: () => request<unknown>('POST', '/logout', {}),

  overview: () => request<Overview>('GET', '/overview'),
  tasks: (filters: Record<string, string>) =>
    request<{ items: TaskRecord[]; total: number }>('GET', `/tasks?${new URLSearchParams(filters)}`),
  task: (id: string) => request<TaskRecord>('GET', `/tasks/${encode(id)}`),
  taskAttempts: (id: string) => request<TaskAttempt[]>('GET', `/tasks/${encode(id)}/attempts`),
  taskAction: (id: string, action: 'cancel' | 'retry', confirmDelivery = false) =>
    request<TaskRecord>(
      'POST',
      `/tasks/${encode(id)}/${action}${confirmDelivery ? '?confirmDelivery=1' : ''}`,
      {},
    ),
  stats: (range: '1h' | '24h') => request<StatsPoint[]>('GET', `/stats/messages?range=${range}`),

  bots: () => request<BotView[]>('GET', '/bots'),
  bot: (bot: Pick<BotView, 'platform' | 'selfId'>) =>
    request<BotDetail>('GET', `/bots/${encode(bot.platform)}/${encode(bot.selfId)}`),
  botAdmins: (bot: Pick<BotView, 'platform' | 'selfId'>, admins: string[]) =>
    request<{ admins: string[] }>('PUT', `/bots/${encode(bot.platform)}/${encode(bot.selfId)}/admins`, {
      admins,
    }),
  botPlugin: (
    bot: Pick<BotView, 'platform' | 'selfId'>,
    name: string,
    input: { enabled?: boolean | null; config?: Record<string, unknown> | null },
  ) =>
    request<BotPluginView>(
      'PUT',
      `/bots/${encode(bot.platform)}/${encode(bot.selfId)}/plugins/${encode(name)}`,
      input,
    ),
  pluginBots: (name: string) =>
    request<{ bot: BotView; application: BotPluginView }[]>('GET', `/plugins/${encode(name)}/bots`),
  adapters: () => request<AdapterView[]>('GET', '/adapters'),
  connections: () => request<ConnectionView[]>('GET', '/connections'),
  saveConnection: (input: ConnectionInput, create = false) =>
    create
      ? request<ConnectionView[]>('POST', '/connections', input)
      : request<ConnectionView[]>('PUT', `/connections/${encode(input.id)}`, {
          name: input.name,
          adapter: input.adapter,
          enabled: input.enabled,
          config: input.config,
        }),
  deleteConnection: (id: string) => request<ConnectionView[]>('DELETE', `/connections/${encode(id)}`, {}),
  reconnect: (id: string) => request<ConnectionView[]>('POST', `/connections/${encode(id)}/reconnect`, {}),
  startConnectionSetup: (adapter: string, connectionId?: string) =>
    request<ConnectionSetup>('POST', '/connection-setups', { adapter, connectionId }),
  connectionSetup: (id: string, signal: AbortSignal) =>
    request<ConnectionSetup>('GET', `/connection-setups/${encode(id)}`, undefined, signal),
  verifyConnectionSetup: (id: string, code: string) =>
    request<ConnectionSetup>('POST', `/connection-setups/${encode(id)}/verify`, { code }),
  saveConnectionSetup: (id: string, input: { name?: string; enabled?: boolean; replace?: boolean }) =>
    request<{ connectionId: string }>('POST', `/connection-setups/${encode(id)}/save`, input),
  cancelConnectionSetup: (id: string) => request<void>('DELETE', `/connection-setups/${encode(id)}`, {}),
  botGroups: (bot: Pick<BotView, 'platform' | 'selfId'>) =>
    request<BotGroup[]>('GET', `/bots/${encode(bot.platform)}/${encode(bot.selfId)}/groups`),
  send: (input: { target: Target | string; message: string | Segment[] }) =>
    request<{ messageId: string }>('POST', '/send', input),

  groups: (refresh = false) => request<GroupView[]>('GET', `/groups${refresh ? '?refresh=1' : ''}`),
  group: (groupKey: string) => request<GroupDetail>('GET', `/groups/${encode(groupKey)}`),

  plugins: () => request<PluginView[]>('GET', '/plugins'),
  pluginReadme: (name: string) => request<{ readme?: string }>('GET', `/plugins/${encode(name)}/readme`),
  pluginAction: (name: string, action: 'enable' | 'disable' | 'reload') =>
    request<PluginView>('POST', `/plugins/${encode(name)}/${action}`, {}),
  pluginBotDefault: (name: string, defaultOnNewBots: boolean) =>
    request<PluginView>('PUT', `/plugins/${encode(name)}/bot-default`, { defaultOnNewBots }),
  pluginConfig: (name: string, config: unknown) =>
    request<PluginView>('PUT', `/plugins/${encode(name)}/config`, { config }),
  pluginGroups: (name: string) => request<PluginGroupSetting[]>('GET', `/plugins/${encode(name)}/groups`),
  /** `config: null` removes the group's config override. */
  setPluginGroup: (
    name: string,
    groupKey: string,
    input: { enabled?: boolean; config?: Record<string, unknown> | null },
  ) => request<unknown>('PUT', `/plugins/${encode(name)}/groups/${encode(groupKey)}`, input),

  rescanPlugins: () =>
    request<{ added: string[]; removed: string[]; plugins: PluginView[] }>('POST', '/plugins/rescan', {}),
  uploadPlugin: (input: { filename: string; content: string; overwrite?: boolean }) =>
    request<PluginView>('POST', '/plugins/upload', input),
  uninstallPlugin: (name: string, purge: boolean) =>
    request<{ ok: true }>('POST', `/plugins/${encode(name)}/uninstall`, { purge }),

  searchPackages: (q: string, sort: PackageSort, from = 0) =>
    request<{ total: number; items: PackageSearchItem[] }>(
      'GET',
      `/packages/search?q=${encode(q)}&sort=${sort}&from=${from}`,
    ),
  packageInfo: (name: string) => request<PackageDetail>('GET', `/packages/info?name=${encode(name)}`),
  installPackage: (input: { name: string; version?: string; force?: boolean }) =>
    request<PackageOperation>('POST', '/packages/install', input),
  updatePackage: (name: string) => request<PackageOperation>('POST', '/packages/update', { name }),
  uninstallPackage: (name: string, purge: boolean) =>
    request<PackageOperation>('POST', '/packages/uninstall', { name, purge }),
  packageOperations: () => request<PackageOperation[]>('GET', '/packages/operations'),

  commands: () => request<CommandView[]>('GET', '/commands'),
  /** `override: null` clears it. The path goes in the body because it may contain spaces. */
  setCommandOverride: (path: string, override: CommandOverride | null) =>
    request<CommandView>('PUT', '/commands/override', { path, override }),
  setCommandGroup: (path: string, groupKey: string, enabled: boolean) =>
    request<unknown>('PUT', '/commands/groups', { path, groupKey, enabled }),

  acl: () => request<AccessEntry[]>('GET', '/acl'),
  addAcl: (entry: AccessEntry) => request<unknown>('POST', '/acl', entry),
  removeAcl: (entry: AccessEntry) => request<unknown>('DELETE', '/acl', entry),

  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (input: SettingsUpdate) => request<Settings>('PUT', '/settings', input),

  logs: (limit = 500, eventId?: string) =>
    request<LogRecord[]>(
      'GET',
      `/logs?limit=${limit}&level=10${eventId === undefined ? '' : `&eventId=${encode(eventId)}`}`,
    ),
  logLevel: () => request<{ level: LogLevel }>('GET', '/logs/level'),
  setLogLevel: (level: LogLevel) => request<{ level: LogLevel }>('PUT', '/logs/level', { level }),

  playground: (input: PlaygroundRequest) => request<PlaygroundResult>('POST', '/playground', input),
  playgroundEvent: (input: PlaygroundEventRequest) =>
    request<PlaygroundResult>('POST', '/playground/event', input),

  /** A plugin's own panel routes (ctx.panel.route), mounted at /api/panel/ext/<name>. */
  ext: <T>(plugin: string, method: string, path: string, body?: unknown) =>
    request<T>(method, `/ext/${encode(plugin)}${path}`, body),
}
