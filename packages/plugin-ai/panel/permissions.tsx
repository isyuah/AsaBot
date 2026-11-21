import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Switch } from '@asabot/panel-ui'
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { type CatalogView, type Defaults, type Policy, protocolInfo } from '../src/contracts.ts'
import { DefaultFields } from './catalog.tsx'
import { Confirm, FormError, rpc, useAction } from './ui.tsx'

function policyFor(data: CatalogView, source: string): Policy | undefined {
  return Object.hasOwn(data.policies, source) ? data.policies[source] : undefined
}

export function Permissions({ data, reload }: { data: CatalogView; reload: () => void }) {
  const [editor, setEditor] = useState<{ source?: string }>()
  const [remove, setRemove] = useState<string>()
  const saved = () => {
    setEditor(undefined)
    setRemove(undefined)
    reload()
  }
  return (
    <div className="ai-stack">
      <div className="ai-head">
        <h2>调用插件</h2>
        <Button variant="primary" onClick={() => setEditor({})}>
          <Plus size={15} />
          配置插件
        </Button>
      </div>
      <p className="ai-note">
        插件不传模型 ID 时使用专属默认或全局默认。启用白名单后，显式调用和默认调用都受限制。
      </p>
      {data.consumers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldCheck />}
            title="还没有调用插件"
            description="声明依赖 AI 服务的插件会出现在这里，也可以按插件名称提前配置。"
          />
        </Card>
      ) : (
        <Card className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col">插件名</th>
                <th scope="col">白名单</th>
                <th scope="col">专属默认</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.consumers.map((source) => {
                const policy = policyFor(data, source)
                const assigned = Object.keys(policy?.defaults ?? {}).length
                return (
                  <tr key={source}>
                    <td>
                      <code className="ai-code">{source}</code>
                    </td>
                    <td>
                      {!policy || policy.allowlist === null ? (
                        '不限制'
                      ) : policy.allowlist.length === 0 ? (
                        <Badge tone="warning">禁止调用</Badge>
                      ) : (
                        <Badge tone="info">{policy.allowlist.length} 个模型</Badge>
                      )}
                    </td>
                    <td>{assigned ? `${assigned} 项能力` : '使用全局默认'}</td>
                    <td>
                      <div className="ai-actions">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="编辑权限"
                          aria-label={`编辑插件权限 ${source}`}
                          onClick={() => setEditor({ source })}
                        >
                          <Pencil size={15} />
                        </Button>
                        {policy && (
                          <Button
                            variant="danger-ghost"
                            size="icon"
                            title="移除配置"
                            aria-label={`移除插件权限配置 ${source}`}
                            onClick={() => setRemove(source)}
                          >
                            <Trash2 size={15} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
      {editor && (
        <PolicyEditor
          data={data}
          existingSource={editor.source}
          onClose={() => setEditor(undefined)}
          onSaved={saved}
        />
      )}
      {remove && (
        <Confirm
          title={`移除「${remove}」的配置？`}
          description="此插件将恢复使用全局默认，模型不再受白名单限制。"
          onClose={() => setRemove(undefined)}
          remove={async () => {
            await rpc(`/policies/${encodeURIComponent(remove)}`, 'DELETE')
            saved()
          }}
        />
      )}
    </div>
  )
}

function PolicyEditor({
  data,
  existingSource,
  onClose,
  onSaved,
}: {
  data: CatalogView
  existingSource?: string
  onClose: () => void
  onSaved: () => void
}) {
  const form = useId()
  const action = useAction()
  const [source, setSource] = useState(existingSource ?? '')
  const [policy, setPolicy] = useState<Policy>(
    (existingSource && policyFor(data, existingSource)) || { defaults: {}, allowlist: null },
  )
  const [search, setSearch] = useState('')
  const alreadyConfigured = existingSource === undefined && !!policyFor(data, source.trim())
  const matching = data.models.filter((item) =>
    `${item.name} ${item.upstreamModel}`.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const toggle = (id: string, checked: boolean) => {
    if (policy.allowlist === null) return
    const allowlist = checked ? [...policy.allowlist, id] : policy.allowlist.filter((item) => item !== id)
    const defaults: Defaults = Object.fromEntries(
      Object.entries(policy.defaults).filter(([, item]) => allowlist.includes(item)),
    )
    setPolicy({ allowlist, defaults })
  }
  const blocked = Object.values(data.defaults).some(
    (id) => policy.allowlist !== null && !policy.allowlist.includes(id),
  )
  return (
    <Dialog
      open
      className="ai-dialog"
      title={existingSource ? `插件权限 · ${existingSource}` : '配置插件权限'}
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            取消
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            loading={action.busy}
            disabled={alreadyConfigured}
          >
            保存
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="ai-form"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            await rpc(`/policies/${encodeURIComponent(source.trim())}`, 'PUT', policy)
            onSaved()
          })
        }}
      >
        {existingSource === undefined && (
          <Field
            label="插件名"
            htmlFor={`${form}-plugin`}
            required
            hint="使用插件的注册名称，而不是 npm 包名。"
            error={alreadyConfigured ? '该插件已配置，请从列表中编辑。' : undefined}
          >
            <Input
              id={`${form}-plugin`}
              list={`${form}-sources`}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              required
              maxLength={100}
              pattern="[a-z0-9][a-z0-9_\-]*"
              autoComplete="off"
            />
            <datalist id={`${form}-sources`}>
              {data.consumers.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </Field>
        )}
        <div className="ai-switch">
          <Switch
            aria-label="启用模型白名单"
            checked={policy.allowlist !== null}
            onCheckedChange={(checked) =>
              setPolicy({
                ...policy,
                allowlist: checked ? [...new Set(Object.values(policy.defaults))] : null,
              })
            }
          />
          启用模型白名单
        </div>
        {policy.allowlist !== null && (
          <>
            <Input
              aria-label="搜索白名单模型"
              placeholder="搜索模型"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <fieldset className="ai-picker ai-pick-list">
              <legend className="ai-muted">允许使用的模型（已选 {policy.allowlist.length} 个）</legend>
              {matching.map((item) => {
                const channel = data.channels.find((candidate) => candidate.id === item.channelId)
                return (
                  <label key={item.id} className="ai-check">
                    <input
                      type="checkbox"
                      checked={policy.allowlist?.includes(item.id) === true}
                      onChange={(event) => toggle(item.id, event.target.checked)}
                    />
                    <span>
                      {item.name}{' '}
                      <small className="ai-muted">
                        {channel?.name ?? ''}
                        {channel ? ` · ${protocolInfo[channel.protocol].name}` : ''}
                      </small>
                    </span>
                  </label>
                )
              })}
              {!matching.length && <p className="ai-muted">没有可选模型</p>}
            </fieldset>
            <p className="ai-note">
              {policy.allowlist.length === 0
                ? '空白名单将禁止此插件的全部 AI 调用。'
                : blocked
                  ? '不在白名单内的全局默认模型不会被调用。'
                  : '从白名单移除模型也会移除它的专属默认设置。'}
            </p>
          </>
        )}
        <h3 className="ai-subhead">专属默认模型</h3>
        <DefaultFields
          data={data}
          value={policy.defaults}
          allowlist={policy.allowlist}
          onChange={(defaults) => setPolicy({ ...policy, defaults })}
        />
        <FormError error={action.error} />
      </form>
    </Dialog>
  )
}
