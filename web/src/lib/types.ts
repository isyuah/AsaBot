// Types of the panel HTTP API. They mirror docs/DESIGN.md §18 exactly; that section is the contract.

export type BotStatus = 'connecting' | 'online' | 'offline'

export interface BotView {
  platform: string
  selfId: string
  nickname?: string
  status: BotStatus
  /** Display text supplied by the adapter, e.g. '正向 WS'. */
  connection: string
  url?: string
  avatar?: string
}

export type PluginStateName = 'loading' | 'active' | 'failed' | 'disabled'

export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
}

export interface CommandView {
  owner: string
  path: string
  usage: string
  description: string
  aliases: string[]
  options: { flags: string[]; description?: string; default?: unknown }[]
  examples: string[]
  permission: boolean
  scope: 'all' | 'group' | 'private'
  hidden: boolean
}

export interface PluginView {
  name: string
  version?: string
  description?: string
  source: 'builtin' | 'file' | 'package'
  /** file and package plugins can be uninstalled; builtin ones only disabled. */
  removable: boolean
  package?: PackageInfo
  path?: string
  state: PluginStateName
  error?: string
  enabled: boolean
  configSchema?: JsonSchema
  commands: CommandView[]
  /** Current effective config (parsed by the plugin schema); absent when the plugin has no schema. */
  config?: unknown
}

export interface PackageInfo {
  name: string
  version: string
  latest?: string
  peerRange?: string
  compatible: boolean
}

export interface PackageOperation {
  id: string
  kind: 'install' | 'update' | 'uninstall'
  name: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  startedAt: number
  finishedAt?: number
  log: string[]
  error?: string
  plugin?: PluginView
}

export interface PackageSearchItem {
  name: string
  version: string
  description?: string
  author?: string
  date?: string
  links: { npm: string; homepage?: string; repository?: string }
  installed: boolean
  installedVersion?: string
}

export type PackageSort = 'relevance' | 'updated' | 'name'

export interface PackageVersion {
  version: string
  date?: string
  peerRange?: string
  compatible: boolean
  deprecated?: string
}

export interface PackageDetail {
  name: string
  description?: string
  license?: string
  links: PackageSearchItem['links']
  readme?: string
  latest?: string
  installed?: string
  /** Newest first. */
  versions: PackageVersion[]
}

export interface Overview {
  version: string
  node: string
  startedAt: number
  memory: { rss: number; heapUsed: number }
  bots: BotView[]
  plugins: { active: number; failed: number; disabled: number }
  today: { received: number; sent: number }
}

export interface StatsPoint {
  t: number
  received: number
  sent: number
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  time: number
  level: number
  msg: string
  plugin?: string
  [key: string]: unknown
}

/** A log record as held by the panel, with a client-side sequence number used as a stable list key. */
export type LogEntry = LogRecord & { seq: number }

export interface Target {
  type: 'group' | 'private'
  id: string
}

export interface GroupView {
  groupId: string
  groupName: string
  memberCount?: number
}

export type AccessList = 'block' | 'allow'
export type AccessSubject = 'user' | 'group'

export interface AccessEntry {
  list: AccessList
  subject: AccessSubject
  key: string
}

export interface Segment {
  type: string
  data: Record<string, unknown>
}

export interface PlaygroundRequest {
  text?: string
  message?: Segment[]
  user: { id: string; nickname?: string; role?: 'owner' | 'admin' | 'member'; superuser?: boolean }
  group?: string | null
}

export interface PlaygroundReply {
  message: Segment[]
  text: string
}

export interface LiveMessage {
  direction: 'in' | 'out'
  platform: string
  selfId: string
  channel: Target
  userId?: string
  nickname?: string
  avatar?: string
  preview: string
  time: number
}

export type ServerFrame =
  | { type: 'hello'; overview: Overview }
  | { type: 'log'; record: LogRecord }
  | { type: 'bot'; bot: BotView }
  | { type: 'plugin'; plugin: PluginView }
  | ({ type: 'message' } & LiveMessage)
  | { type: 'stats'; point: StatsPoint }
  | { type: 'package'; operation: PackageOperation }

export interface ApiErrorBody {
  error: { code: string; message: string; issues?: { path: string; message: string }[] }
}
