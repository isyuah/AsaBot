/** 框架共用的 zod schema 构造器。 */
export { z } from 'zod'
/** 可通过声明合并扩展的插件服务类型表。 */
export interface Services extends Record<never, never> {}
export { createApp } from './bootstrap.ts'
export type {
  Adapter,
  AdapterHost,
  BeforeSend,
  BotInfo,
  Delivery,
  OutgoingMessage,
  PreparedOutgoing,
  UpgradeHandler,
} from './core/adapter.ts'
export { App } from './core/app.ts'
export type {
  Bot,
  BotCapabilities,
  ForwardMessage,
  ForwardNode,
  GroupInfo,
  GroupMemberInfo,
  MessageInfo,
  MessageTarget,
  SendResult,
  UserInfo,
} from './core/bot.ts'
export { BotRegistry, supports } from './core/bot.ts'
export type { CommandDefinition, OptionDefinition, OptionSettings } from './core/command/builder.ts'
export { CommandBuilder } from './core/command/builder.ts'
export type { ArgumentSettings, ArgumentType } from './core/command/declaration.ts'
export { formatUsage } from './core/command/parse.ts'
export type { CommandAction, CommandArgs, CommandContext, OptionValue } from './core/command/types.ts'
export { interpolateConfigValues, loadConfig } from './core/config/load.ts'
export {
  type CommandOverride,
  type Config,
  commandOverrideSchema,
  configSchema,
} from './core/config/schema.ts'
export { writeConfigValue } from './core/config/write.ts'
export type { ApiCall, ApiInterceptor } from './core/dispatch/api.ts'
export { Dispatcher } from './core/dispatch/dispatcher.ts'
export type { DispatchTrace, TraceStep } from './core/dispatch/trace.ts'
export type {
  AccessFilter,
  DispatchEvent,
  Disposer,
  EnabledFilter,
  MatchHandler,
  MatchPattern,
  Middleware,
  Scope,
} from './core/dispatch/types.ts'
export { groupKeyOf } from './core/dispatch/types.ts'
export {
  ApiTimeoutError,
  CommandConflictError,
  ConfigError,
  NoBotOnlineError,
  NotConnectedError,
  PluginConfigError,
  PluginError,
  SendBlockedError,
  SendQueueFullError,
  UnsupportedError,
} from './core/errors.ts'
export type {
  AnyEvent,
  BaseEvent,
  BotOfflineEvent,
  BotOnlineEvent,
  DialogueOptions,
  DispatchTraceEvent,
  EventMap,
  FriendRequestEvent,
  GroupInviteRequestEvent,
  GroupJoinRequestEvent,
  GroupRequestEvent,
  GroupSession,
  KnownNoticeEvent,
  MemberJoinEvent,
  MemberLeaveEvent,
  MemberMuteEvent,
  MemberNoticeEvent,
  MemberRoleEvent,
  MemberUnmuteEvent,
  MessageRecallEvent,
  MessageSentEvent,
  MetaEvent,
  NoticeEvent,
  PlatformNoticeEvent,
  PokeEvent,
  PrivateSession,
  PromptOptions,
  RequestEvent,
  Session,
  SessionServices,
} from './core/event/index.ts'
export { createSession, stripLeadingMention } from './core/event/index.ts'
export {
  createLogger,
  getRecentLogs,
  type LogLevel,
  type LogRecord,
  type LogSubscriber,
  logger,
  subscribeLogs,
} from './core/logger.ts'
export type {
  KnownSegment,
  Message,
  Segment,
  Sendable,
  TextStyle,
  UnknownSegment,
} from './core/message/index.ts'
export {
  isSegment,
  normalizeSendable,
  plainText,
  seg,
} from './core/message/index.ts'
export type { Permission, Rule } from './core/permission.ts'
export { perm } from './core/permission.ts'
export { Context, type FilteredContext } from './core/plugin/context.ts'
export { definePlugin, type PluginDefinition } from './core/plugin/definition.ts'
export { PluginManager } from './core/plugin/manager.ts'
export type {
  TaskAttempt,
  TaskHandle,
  TaskHandler,
  TaskOptions,
  TaskOutcome,
  TaskPolicy,
  TaskQuery,
  TaskRecord,
  TaskRegistrationOptions,
  TaskState,
} from './core/plugin/tasks.ts'
export { TaskConflictError } from './core/plugin/tasks.ts'
export type { PanelPageOptions, PluginState, PluginStateEvent } from './core/plugin/types.ts'
export type { CooldownScope } from './core/ratelimit.ts'
export {
  type AccessEntry,
  type AccessList,
  type AccessSubject,
  KVStore,
  Storage,
} from './core/storage/index.ts'
export { formatTarget, parseTarget, type Target, targetSchema } from './core/target.ts'
export { type Duration, parseDuration } from './core/utils/duration.ts'
export { LruSet } from './core/utils/lru.ts'
export type { HistoryChannel, HistoryMessage, HistoryQuery, HistoryService } from './plugins/history.ts'
export { HttpError, type HttpInit, type HttpService } from './plugins/http.ts'
