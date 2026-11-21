const messages = {
  INVALID_INPUT: '请求参数无效',
  MODEL_FORBIDDEN: '插件无权使用此模型',
  MODEL_UNAVAILABLE: '模型或渠道不存在或已停用',
  MODEL_NOT_CONFIGURED: '尚未为这项能力配置默认模型',
  CAPABILITY_UNSUPPORTED: '模型未启用此请求所需的能力',
  CREDENTIAL_UNAVAILABLE: '渠道密钥不可用，请检查环境变量或重新设置密钥',
  CATALOG_UNSUPPORTED: '此渠道不提供模型列表，请手动添加',
  TIMEOUT: 'AI 请求超时',
  CANCELLED: 'AI 请求已取消',
  INTERRUPTED: 'AsaBot 重启，调用未完成',
  UPSTREAM_AUTH: '上游拒绝鉴权，请检查渠道密钥和权限',
  UPSTREAM_RATE_LIMIT: '上游限流或配额不足',
  UPSTREAM_REQUEST: '无法完成上游请求，请检查渠道地址、协议和模型',
  UPSTREAM_OUTPUT: '上游输出不符合预期格式，或生成内容被过滤',
  NOT_FOUND: '指定的记录不存在',
  CONFLICT: '此项仍被引用或已存在',
  INTERNAL: 'AI 服务发生内部错误，请查看 AsaBot 日志',
} as const

export type AiErrorCode = keyof typeof messages

export class AiError extends Error {
  readonly code: AiErrorCode
  readonly requestId?: string
  readonly httpStatus?: number

  constructor(
    code: AiErrorCode,
    options: { requestId?: string; httpStatus?: number; message?: string } = {},
  ) {
    super(options.message ?? messages[code])
    this.name = 'AiError'
    this.code = code
    this.requestId = options.requestId
    this.httpStatus = options.httpStatus
  }

  forRequest(requestId: string): AiError {
    return new AiError(this.code, { requestId, httpStatus: this.httpStatus, message: this.message })
  }
}

export function upstreamError(status?: number): AiError {
  return new AiError(
    status === 401 || status === 403
      ? 'UPSTREAM_AUTH'
      : status === 429
        ? 'UPSTREAM_RATE_LIMIT'
        : 'UPSTREAM_REQUEST',
    { httpStatus: status },
  )
}
