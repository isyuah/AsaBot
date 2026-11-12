export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

export class ApiError extends Error {
  readonly action: string
  readonly retcode: number
  readonly wording: string

  constructor(action: string, retcode: number, wording = 'Unknown API error') {
    super(`OneBot API ${action} failed (retcode ${retcode}): ${wording}`)
    this.name = 'ApiError'
    this.action = action
    this.retcode = retcode
    this.wording = wording
  }
}

export class ApiTimeoutError extends Error {
  readonly action: string
  readonly timeout: number

  constructor(action: string, timeout: number) {
    super(`OneBot API ${action} timed out after ${timeout}ms`)
    this.name = 'ApiTimeoutError'
    this.action = action
    this.timeout = timeout
  }
}

export class NotConnectedError extends Error {
  constructor(message = 'OneBot connection is not online') {
    super(message)
    this.name = 'NotConnectedError'
  }
}

export class SendQueueFullError extends Error {
  constructor() {
    super('OneBot send queue is full')
    this.name = 'SendQueueFullError'
  }
}

export class NoBotOnlineError extends Error {
  constructor() {
    super('No bot is online')
    this.name = 'NoBotOnlineError'
  }
}

export class PluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginError'
  }
}

export class PluginConfigError extends PluginError {
  readonly issues: { path: string; message: string }[]

  constructor(issues: { path: string; message: string }[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    this.name = 'PluginConfigError'
    this.issues = issues
  }
}

export class CommandConflictError extends Error {
  constructor(name: string, existingOwner: string, newOwner: string) {
    super(`Command or alias "${name}" conflicts between "${existingOwner}" and "${newOwner}"`)
    this.name = 'CommandConflictError'
  }
}
