/** 配置读取、解析、校验或写入失败。 */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

export class QrSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QrSetupError'
  }
}

/** 平台不支持请求的操作。 */
export class UnsupportedError extends Error {
  readonly platform: string
  readonly operation: string

  constructor(platform: string, operation: string) {
    super(`${platform} 不支持 ${operation}`)
    this.name = 'UnsupportedError'
    this.platform = platform
    this.operation = operation
  }
}

/** 消息被发送前钩子拦截，plugin 标识拦截的插件。 */
export class SendBlockedError extends Error {
  readonly plugin: string

  constructor(plugin: string) {
    super(`发送被插件 ${plugin} 拦截`)
    this.name = 'SendBlockedError'
    this.plugin = plugin
  }
}

/** 平台 API 调用超过 timeout 毫秒。 */
export class ApiTimeoutError extends Error {
  readonly action: string
  readonly timeout: number

  constructor(action: string, timeout: number) {
    super(`API ${action} timed out after ${timeout}ms`)
    this.name = 'ApiTimeoutError'
    this.action = action
    this.timeout = timeout
  }
}

/** 操作所需的连接尚未上线或已断开。 */
export class NotConnectedError extends Error {
  constructor(message = 'Connection is not online') {
    super(message)
    this.name = 'NotConnectedError'
  }
}

/** 发送队列已满，无法继续排队。 */
export class SendQueueFullError extends Error {
  constructor() {
    super('Send queue is full')
    this.name = 'SendQueueFullError'
  }
}

/** 没有符合查询条件的在线机器人。 */
export class NoBotOnlineError extends Error {
  constructor() {
    super('No bot is online')
    this.name = 'NoBotOnlineError'
  }
}

/** 插件加载、服务或生命周期错误。 */
export class PluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginError'
  }
}

/** 插件配置校验失败；issues 包含字段路径和错误说明。 */
export class PluginConfigError extends PluginError {
  readonly issues: { path: string; message: string }[]

  constructor(issues: { path: string; message: string }[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    this.name = 'PluginConfigError'
    this.issues = issues
  }
}

/** 不同插件注册了冲突的命令或别名。 */
export class CommandConflictError extends Error {
  constructor(name: string, existingOwner: string, newOwner: string) {
    super(`Command or alias "${name}" conflicts between "${existingOwner}" and "${newOwner}"`)
    this.name = 'CommandConflictError'
  }
}
