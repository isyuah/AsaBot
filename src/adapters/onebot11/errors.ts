/** OneBot API 返回失败状态时的错误，包含 action、retcode 和原因。 */
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
