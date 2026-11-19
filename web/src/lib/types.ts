// Types of the panel HTTP API. They mirror docs/DESIGN.md §18 exactly; that section is the contract.

export type BotStatus = 'connecting' | 'online' | 'offline'

export interface BotView {
  platform: string
  selfId: string
  nickname?: string
  status: BotStatus
  /** Display text supplied by the adapter, e.g. '正向 WS'. */
  connection: string
  connectionId?: string
  url?: string
  avatar?: string
  capabilities: BotCapabilities
}

export type TextStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler'

export interface BotCapabilities {
  /** Segment types the platform sends natively; '<platform>:*' covers a whole platform namespace. */
  segments: string[]
  textStyles: TextStyle[]
  /** Supported Bot methods, e.g. 'sendForward', 'muteMember'. */
  actions: string[]
}

export type PluginStateName = 'loading' | 'active' | 'failed' | 'disabled'

export interface JsonSchema {
  writeOnly?: boolean
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
  override?: CommandOverride
  /** Group keys where the command is turned off. */
  disabledGroups: string[]
  /** Problems applying the override, e.g. an alias that conflicts with another command. */
  overrideIssues: string[]
}

export type CommandPermission = 'everyone' | 'superuser' | 'bot.admin' | 'group.admin' | 'group.owner'
export type CooldownScope = 'user' | 'group' | 'global'

export interface CommandOverride {
  enabled?: boolean
  /** Extra aliases (full paths) appended after the plugin's own. */
  aliases?: string[]
  /** Replaces the plugin's permission; 'everyone' removes it. */
  permission?: CommandPermission
  /** `false` removes the plugin's cooldown. */
  cooldown?: { duration: string | number; scope?: CooldownScope } | false
  hidden?: boolean
}

export interface PluginView {
  name: string
  version?: string
  description?: string
  depends?: string[]
  source: 'builtin' | 'file' | 'package'
  /** file and package plugins can be uninstalled; builtin ones only disabled. */
  removable: boolean
  package?: PackageInfo
  path?: string
  state: PluginStateName
  error?: string
  enabled: boolean
  configSchema?: JsonSchema
  capabilities?: { required?: Partial<BotCapabilities>; optional?: Partial<BotCapabilities> }
  commands: CommandView[]
  /** Current effective config (parsed by the plugin schema); absent when the plugin has no schema. */
  config?: unknown
  /** Services this plugin provides to others (ctx.provide). */
  provides: string[]
  /** Services this plugin uses (definePlugin inject); it only loads while all required ones are available. */
  inject: { name: string; optional: boolean }[]
  /** A page the plugin adds to the panel (ctx.panel.page), shown in a sandboxed iframe. */
  page?: { title: string; icon?: string }
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

export interface Session {
  authenticated: boolean
  /** First run: no panel password yet, the setup wizard must be completed with the console setup code. */
  setup?: boolean
}

export interface SetupInput {
  code: string
  password: string
  superusers: ActorIdentity[]
}

export interface CommandSettings {
  prefixes: string[]
  mentionAsPrefix: boolean
  privateRequirePrefix: boolean
  replyOnError: boolean
  replyOnDenied: boolean
  /** Reply "did you mean /x?" for near-miss commands: off, only in private chats / when mentioned, or always. */
  suggest: 'off' | 'direct' | 'always'
}

export interface Settings {
  superusers: ActorIdentity[]
  timezone: string
  command: CommandSettings
  /** Saved settings that only apply after a restart, e.g. ['timezone']. */
  restartRequired: string[]
}

export interface SettingsUpdate {
  superusers?: ActorIdentity[]
  timezone?: string
  command?: Partial<CommandSettings>
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
  /** The dispatched event this record was logged while handling. */
  eventId?: string
  [key: string]: unknown
}

/** A log record as held by the panel, with a client-side sequence number used as a stable list key. */
export type LogEntry = LogRecord & { seq: number }

/** A thread and the message the adapter replies to when posting to it. */
export interface MessageThread {
  id: string
  rootMessageId: string
}

/** A conversation on a bot (bot-level target). */
export interface ChannelTarget {
  type: 'group' | 'private'
  id: string
  thread?: MessageThread
}

/** A serializable send target; without selfId the first online bot of the platform is used. */
export interface Target extends ChannelTarget {
  platform: string
  selfId?: string
}

/** A group in one bot's group list (GET /bots/:platform/:selfId/groups). */
export interface BotGroup {
  groupId: string
  groupName: string
  memberCount?: number
}

/** A group known to the panel: from online bots' group lists or from any per-group rule. */
export interface GroupView {
  selfId: string
  groupKey: string
  platform: string
  groupId: string
  name?: string
  /** Bots (selfIds) that are in this group. */
  bots: string[]
  rules: { plugins: number; configs: number; commands: number }
  access?: AccessList
}

export interface GroupDetail {
  group: GroupView
  plugins: {
    name: string
    enabled: boolean
    configurable: boolean
    override?: Record<string, unknown>
    effectiveConfig?: unknown
    inheritedConfig?: unknown
    configSources?: Record<string, string>
  }[]
  commands: { path: string; owner: string; enabled: boolean }[]
}

export interface PluginGroupSetting {
  groupKey: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export type TraceStage = 'filter' | 'observer' | 'middleware' | 'prompt' | 'command' | 'matcher' | 'suggest'
export type TraceOutcome =
  | 'handled'
  | 'passed'
  | 'blocked'
  | 'denied'
  | 'cooldown'
  | 'invalid'
  | 'error'
  | 'timeout'

export interface TraceStep {
  stage: TraceStage
  plugin?: string
  command?: string
  outcome: TraceOutcome
  duration: number
  error?: string
}

export interface DispatchTrace {
  eventId: string
  name: string
  platform: string
  selfId: string
  channel?: string
  userId?: string
  time: number
  duration: number
  steps: TraceStep[]
  /** Message IDs sent while handling the event. */
  sent: string[]
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

export interface PlaygroundUser {
  id: string
  nickname?: string
  role?: 'owner' | 'admin' | 'member'
  superuser?: boolean
}

export interface PlaygroundRequest {
  text?: string
  message?: Segment[]
  user: PlaygroundUser
  group?: string | null
  capabilities?: Partial<BotCapabilities>
}

export type PlaygroundEventName =
  | 'notice.member.join'
  | 'notice.member.leave'
  | 'notice.member.mute'
  | 'notice.poke'
  | 'notice.message.recall'
  | 'request.friend'
  | 'request.group.join'
  | 'request.group.invite'

export interface PlaygroundEventRequest {
  name: PlaygroundEventName
  user: PlaygroundUser
  group?: string | null
  fields?: Record<string, unknown>
  capabilities?: Partial<BotCapabilities>
}

export interface PlaygroundReply {
  messageId: string
  message: Segment[]
  text: string
}

export interface PlaygroundResult {
  /** Present for message requests: the ID the simulated incoming message got (it can be quoted). */
  incoming?: { messageId: string }
  replies: PlaygroundReply[]
  /** Group management and request handling the virtual bot recorded, e.g. approve / muteMember. */
  actions: { action: string; params: Record<string, unknown> }[]
  traces: DispatchTrace[]
  logs: LogRecord[]
}

export interface LiveMessage {
  direction: 'in' | 'out'
  platform: string
  selfId: string
  channel: ChannelTarget
  userId?: string
  nickname?: string
  avatar?: string
  preview: string
  time: number
}

export type ServerFrame =
  | { type: 'connections' }
  | { type: 'policies' }
  | { type: 'task'; id?: string }
  | { type: 'hello'; overview: Overview }
  | { type: 'log'; record: LogRecord }
  | { type: 'bot'; bot: BotView }
  | { type: 'plugin'; plugin: PluginView }
  | ({ type: 'message' } & LiveMessage)
  | { type: 'stats'; point: StatsPoint }
  | { type: 'package'; operation: PackageOperation }
  | { type: 'plugin-event'; plugin: string; topic: string; data: unknown }

export interface ApiErrorBody {
  error: { code: string; message: string; issues?: { path: string; message: string }[] }
}

export type TaskState =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export interface TaskRecord {
  id: string
  plugin: string
  name: string
  key: string
  payload: unknown
  state: TaskState
  runAt: number
  nextRunAt: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  attempt: number
  failures: number
  policy: { maxRetries: number; delay: number; maxDelay: number; timeout?: number }
  error?: string
  blockedReason?: string
  canRetry: boolean
}
export interface TaskAttempt {
  id: string
  taskId: string
  attempt: number
  startedAt: number
  finishedAt?: number
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'timeout'
  error?: string
}

export interface ActorIdentity {
  platform: string
  selfId: string
  userId: string
}
export interface ConnectionInput {
  id: string
  name: string
  adapter: string
  enabled: boolean
  config: unknown
}
export interface ConnectionView extends ConnectionInput {
  platform: string
  state: 'disabled' | 'connecting' | 'waiting' | 'online' | 'retrying' | 'error' | 'offline' | 'reauthorize'
  changedAt: number
  lastConnectedAt?: number
  lastError?: string
  errorAt?: number
  nextRetryAt?: number
  endpoints: string[]
  bots: { platform: string; selfId: string }[]
}
export interface AdapterView {
  id: string
  platform: string
  name: string
  version: string
  description: string
  source: string
  connectionTypes: string[]
  capabilities: BotCapabilities
  configSchema: JsonSchema
  setup?: { kind: 'qr' }
}
export type ConnectionSetup = { id: string; expiresAt: number } & (
  | { status: 'starting' | 'scanned' | 'expired' | 'already-bound' }
  | { status: 'failed'; detail?: string }
  | { status: 'waiting'; image: string }
  | { status: 'verification'; retry: boolean }
  | { status: 'authorized'; selfId: string; replaces?: string; missingAdmin: boolean }
  | { status: 'saved'; connectionId: string }
)
export interface Compatibility {
  declared: boolean
  required: { kind: keyof BotCapabilities; name: string }[]
  optional: { kind: keyof BotCapabilities; name: string }[]
}
export interface BotPluginView extends PluginView {
  botEnabled: boolean
  overrideEnabled?: boolean
  override?: Record<string, unknown>
  effectiveConfig?: unknown
  configSources: Record<string, string>
  compatibility: Compatibility
}
export interface BotDetail {
  bot: BotView
  admins: string[]
  plugins: BotPluginView[]
}
