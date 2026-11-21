import { z } from 'zod'
import type { CredentialStore } from '../storage/credentials.ts'
import { constantTimeEqual } from '../utils/security.ts'

export const credentialGroupId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
export const credentialGroupsSchema = z.record(
  credentialGroupId,
  z.strictObject({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500).optional(),
  }),
)

/** 插件声明的凭据用途，以稳定的用途 ID 为键。 */
export type PluginCredentialGroups = z.input<typeof credentialGroupsSchema>

export interface PluginCredentialGroup {
  readonly id: string
  readonly title: string
  readonly description?: string
}

/** 单条凭据的元数据。 */
export interface PluginCredentialInfo {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly createdAt: number
  readonly active: boolean
}

/** 含原值的凭据，仅用于插件自己的验签或鉴权。 */
export interface PluginCredentialValue extends PluginCredentialInfo {
  readonly value: string
}

export interface PluginCredentialFilter {
  group: string
}

/** 由框架绑定到当前插件的凭据查询与鉴权工具。 */
export class PluginCredentials {
  private readonly store: CredentialStore
  private readonly owner: string
  private readonly assertActive: () => void

  constructor(store: CredentialStore, owner: string, assertActive: () => void) {
    this.store = store
    this.owner = owner
    this.assertActive = assertActive
  }

  /** 列出当前插件的有效凭据元数据，可按用途筛选。 */
  list(filter?: PluginCredentialFilter): readonly PluginCredentialInfo[] {
    this.assertActive()
    return this.store.list(this.owner, { group: filter?.group, activeOnly: true })
  }

  /** 读取指定用途的有效凭据原值，用于 HMAC 等需要原值的场景。 */
  readAll({ group }: PluginCredentialFilter): readonly PluginCredentialValue[] {
    this.assertActive()
    return this.store.readAll(this.owner, group)
  }

  /** 安全比较原值；匹配时返回元数据，否则返回 undefined。 */
  match(value: string | undefined | null, filter: PluginCredentialFilter): PluginCredentialInfo | undefined {
    this.assertActive()
    if (!value) return undefined
    let matched: PluginCredentialInfo | undefined
    for (const { value: secret, ...info } of this.store.readAll(this.owner, filter.group)) {
      if (constantTimeEqual(value, secret)) matched = info
    }
    return matched
  }

  /** 解析 Authorization: Bearer … 后匹配；由插件决定失败时的 HTTP 响应。 */
  bearer(request: Request, filter: PluginCredentialFilter): PluginCredentialInfo | undefined {
    const token = /^Bearer[ \t]+([a-z\d._~+/-]+=*)$/i.exec(request.headers.get('Authorization') ?? '')?.[1]
    return this.match(token, filter)
  }
}
