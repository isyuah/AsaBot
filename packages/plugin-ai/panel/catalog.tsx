import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  type SelectOption,
  Switch,
} from '@asabot/panel-ui'
import { Cable, Layers3, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import {
  type Capability,
  type CatalogView,
  type ChannelDraft,
  type ChannelView,
  type CredentialInput,
  capabilities,
  type Defaults,
  type DiscoveredModel,
  type Feature,
  features,
  type ModelDraft,
  type ModelView,
  protocolInfo,
  protocols,
} from '../src/contracts.ts'
import { Confirm, FormError, Loading, labels, PickField, rpc, useAction } from './ui.tsx'

type ChannelDialog = { kind: 'edit'; item?: ChannelView } | { kind: 'discover' | 'delete'; item: ChannelView }
type ModelDialog =
  | { kind: 'edit'; item?: ModelView }
  | { kind: 'test' | 'delete'; item: ModelView }
  | { kind: 'defaults' }
export type ModelSeed = { channelId: string; discovered: DiscoveredModel }

export function Channels({
  data,
  reload,
  onPickDiscovered,
}: {
  data: CatalogView
  reload: () => void
  onPickDiscovered: (seed: ModelSeed) => void
}) {
  const [dialog, setDialog] = useState<ChannelDialog>()
  const close = () => setDialog(undefined)
  const saved = () => {
    close()
    reload()
  }
  return (
    <div className="ai-stack">
      <div className="ai-head">
        <h2>API 渠道</h2>
        <Button variant="primary" onClick={() => setDialog({ kind: 'edit' })}>
          <Plus size={15} />
          添加渠道
        </Button>
      </div>
      {data.channels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Cable />}
            title="还没有 API 渠道"
            description="添加渠道后，就能拉取或手动添加模型。"
          />
        </Card>
      ) : (
        <Card className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col">渠道 / 地址</th>
                <th scope="col">协议</th>
                <th scope="col">凭据</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((channel) => (
                <tr key={channel.id}>
                  <td className="ai-cell-main">
                    <strong>{channel.name}</strong>
                    <code className="ai-cell-line ai-code">{channel.baseUrl}</code>
                  </td>
                  <td>{protocolInfo[channel.protocol].name}</td>
                  <td className="ai-nowrap">
                    {channel.credential.status === 'missing' ? (
                      <Badge tone="warning">密钥不可用</Badge>
                    ) : channel.credential.status === 'none' ? (
                      '无密钥'
                    ) : (
                      '已配置'
                    )}
                  </td>
                  <td>
                    <Badge tone={channel.enabled ? 'success' : 'neutral'}>
                      {channel.enabled ? '启用' : '停用'}
                    </Badge>
                  </td>
                  <td>
                    <div className="ai-actions">
                      {channel.protocol !== 'system-one' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'discover', item: channel })}
                        >
                          拉取模型
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`编辑渠道 ${channel.name}`}
                        title="编辑渠道"
                        onClick={() => setDialog({ kind: 'edit', item: channel })}
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        size="icon"
                        variant="danger-ghost"
                        aria-label={`删除渠道 ${channel.name}`}
                        title="删除渠道"
                        onClick={() => setDialog({ kind: 'delete', item: channel })}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {dialog?.kind === 'edit' && <ChannelEditor item={dialog.item} onClose={close} onSaved={saved} />}
      {dialog?.kind === 'discover' && (
        <Discovery
          item={dialog.item}
          data={data}
          onClose={close}
          onPick={(discovered) => {
            close()
            onPickDiscovered({ channelId: dialog.item.id, discovered })
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <Confirm
          title={`删除「${dialog.item.name}」？`}
          description="需要先移除这个渠道下的模型。已有的请求和用量记录会保留。"
          onClose={close}
          remove={async () => {
            await rpc(`/channels/${dialog.item.id}`, 'DELETE')
            saved()
          }}
        />
      )}
    </div>
  )
}

function ChannelEditor({
  item,
  onClose,
  onSaved,
}: {
  item?: ChannelView
  onClose: () => void
  onSaved: () => void
}) {
  const form = useId()
  const [draft, setDraft] = useState<ChannelDraft>(
    item
      ? {
          name: item.name,
          protocol: item.protocol,
          baseUrl: item.baseUrl,
          timeoutMs: item.timeoutMs,
          enabled: item.enabled,
        }
      : {
          name: '',
          protocol: 'openai-chat',
          baseUrl: protocolInfo['openai-chat'].baseUrl,
          timeoutMs: 90_000,
          enabled: true,
        },
  )
  const [kind, setKind] = useState<CredentialInput['kind'] | 'keep'>(item ? 'keep' : 'key')
  const credentialOptions: SelectOption<typeof kind>[] = [
    { value: 'key', label: '输入 API Key' },
    { value: 'env', label: '引用服务器环境变量' },
    { value: 'none', label: '无需密钥' },
  ]
  if (item) credentialOptions.unshift({ value: 'keep', label: '保留当前设置' })
  const [secret, setSecret] = useState('')
  const action = useAction()
  const save = (event: FormEvent) => {
    event.preventDefault()
    const credential =
      kind === 'keep'
        ? undefined
        : kind === 'none'
          ? { kind }
          : kind === 'env'
            ? { kind, variable: secret.trim() }
            : { kind, value: secret.trim() }
    void action.run(async () => {
      await rpc(item ? `/channels/${item.id}` : '/channels', item ? 'PUT' : 'POST', {
        ...draft,
        baseUrl: draft.baseUrl.trim(),
        credential,
      })
      setSecret('')
      onSaved()
    })
  }
  return (
    <Dialog
      open
      className="ai-dialog"
      title={item ? '编辑渠道' : '添加渠道'}
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            取消
          </Button>
          <Button form={form} type="submit" variant="primary" loading={action.busy}>
            保存
          </Button>
        </>
      }
    >
      <form id={form} className="ai-form" onSubmit={save}>
        <Field label="渠道名称" htmlFor={`${form}-name`} required>
          <Input
            id={`${form}-name`}
            required
            maxLength={100}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <PickField
          label="API 协议"
          value={draft.protocol}
          choices={protocols.map((value) => ({ value, label: protocolInfo[value].name }))}
          onChange={(protocol) => {
            setDraft({
              ...draft,
              protocol,
              baseUrl:
                draft.baseUrl === protocolInfo[draft.protocol].baseUrl
                  ? protocolInfo[protocol].baseUrl
                  : draft.baseUrl,
            })
          }}
        />
        <Field
          label="Base URL"
          required
          htmlFor={`${form}-url`}
          hint="填写 API 前缀（例如 https://api.openai.com/v1），不含 /models 或生成端点。"
        >
          <Input
            id={`${form}-url`}
            type="url"
            required
            maxLength={2048}
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        </Field>
        <PickField
          label="鉴权方式"
          value={kind}
          choices={credentialOptions}
          onChange={(value) => {
            setKind(value)
            setSecret('')
          }}
        />
        {(kind === 'key' || kind === 'env') && (
          <Field label={kind === 'key' ? 'API Key' : '环境变量名'} htmlFor={`${form}-secret`} required>
            <Input
              id={`${form}-secret`}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
              autoComplete="off"
              type={kind === 'key' ? 'password' : 'text'}
              maxLength={kind === 'key' ? 8192 : 128}
              pattern={kind === 'env' ? '[A-Za-z_][A-Za-z0-9_]*' : undefined}
              spellCheck={false}
            />
          </Field>
        )}
        <div className="ai-form-row">
          <Field label="请求超时（秒）" htmlFor={`${form}-timeout`} required>
            <Input
              id={`${form}-timeout`}
              type="number"
              min={1}
              max={600}
              step="any"
              required
              value={draft.timeoutMs ? draft.timeoutMs / 1000 : ''}
              onChange={(event) =>
                setDraft({ ...draft, timeoutMs: Math.round(Number(event.target.value) * 1000) })
              }
            />
          </Field>
          <div className="ai-switch">
            <Switch
              aria-label="启用渠道"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            启用渠道
          </div>
        </div>
        <FormError error={action.error} />
      </form>
    </Dialog>
  )
}

function Discovery({
  item,
  data,
  onClose,
  onPick,
}: {
  item: ChannelView
  data: CatalogView
  onClose: () => void
  onPick: (item: DiscoveredModel) => void
}) {
  const action = useAction()
  const [result, setResult] = useState<{ models: DiscoveredModel[]; truncated: boolean }>()
  const [search, setSearch] = useState('')
  const existing = new Set(
    data.models.filter((model) => model.channelId === item.id).map((model) => model.upstreamModel),
  )
  const matching =
    result?.models.filter((model) =>
      `${model.name} ${model.upstreamModel}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? []
  return (
    <Dialog
      open
      className="ai-dialog"
      title={`从「${item.name}」拉取模型`}
      description="选中模型后，在添加表单里勾选它实际支持的能力。"
      onOpenChange={onClose}
      footer={
        <Button
          variant={result ? 'secondary' : 'primary'}
          loading={action.busy}
          onClick={() => {
            void action.run(async () => {
              setResult(await rpc(`/channels/${item.id}/discover`))
            })
          }}
        >
          {result ? '重新拉取' : '拉取列表'}
        </Button>
      }
    >
      <div className="ai-form">
        <FormError error={action.error} />
        {action.busy && <Loading />}
        {result && (
          <>
            <Input
              aria-label="搜索上游模型"
              icon={<Search />}
              placeholder="按名称或上游模型名搜索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {matching.length === 0 ? (
              <p className="ai-muted">{search ? '没有匹配的模型' : '上游没有返回可添加的模型'}</p>
            ) : (
              <div className="ai-picker ai-pick-list">
                {matching.slice(0, 50).map((model) => (
                  <div className="ai-pick-row" key={model.upstreamModel}>
                    <span className="ai-cell-main">
                      <strong>{model.name}</strong>
                      {model.name !== model.upstreamModel && (
                        <code className="ai-cell-line ai-code">{model.upstreamModel}</code>
                      )}
                    </span>
                    <Button
                      size="sm"
                      disabled={existing.has(model.upstreamModel)}
                      onClick={() => onPick(model)}
                    >
                      {existing.has(model.upstreamModel) ? '已添加' : '选择'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {matching.length > 50 && <p className="ai-muted">显示前 50 条，请按名称搜索更多结果。</p>}
            {result.truncated && <p className="ai-muted">上游列表已截断，未列出的模型可手动添加。</p>}
          </>
        )}
      </div>
    </Dialog>
  )
}

export function Models({
  data,
  reload,
  seed,
  clearSeed,
  showRequest,
}: {
  data: CatalogView
  reload: () => void
  seed?: ModelSeed
  clearSeed: () => void
  showRequest: (id: string) => void
}) {
  const [dialog, setDialog] = useState<ModelDialog>()
  const [filter, setFilter] = useState('')
  const close = () => {
    setDialog(undefined)
    clearSeed()
  }
  const saved = () => {
    close()
    reload()
  }
  const channels = new Map(data.channels.map((item) => [item.id, item]))
  const models = data.models.filter((item) => !filter || item.channelId === filter)
  const editor = seed !== undefined || dialog?.kind === 'edit'
  return (
    <div className="ai-stack">
      <div className="ai-head">
        <h2>模型目录</h2>
        <div className="ai-actions">
          <Button onClick={() => setDialog({ kind: 'defaults' })}>全局默认</Button>
          <Button
            variant="primary"
            disabled={!data.channels.length}
            onClick={() => setDialog({ kind: 'edit' })}
          >
            <Plus size={15} />
            添加模型
          </Button>
        </div>
      </div>
      {data.channels.length > 1 && (
        <div className="ai-form-row">
          <PickField
            label="渠道"
            value={filter}
            choices={[
              { value: '', label: '全部渠道' },
              ...data.channels.map(({ id, name }) => ({ value: id, label: name })),
            ]}
            onChange={setFilter}
          />
        </div>
      )}
      {!models.length ? (
        <Card>
          <EmptyState
            icon={<Layers3 />}
            title="没有模型"
            description={
              data.channels.length
                ? '可以从渠道拉取模型，也可以手动填写上游模型名。'
                : '先在「渠道」添加 API 渠道。'
            }
          />
        </Card>
      ) : (
        <Card className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col">模型 / 本地 ID</th>
                <th scope="col">渠道 / 上游模型</th>
                <th scope="col">能力</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((item) => {
                const channel = channels.get(item.channelId)
                const active = item.enabled && channel?.enabled === true
                return (
                  <tr key={item.id}>
                    <td className="ai-cell-main">
                      <strong>{item.name}</strong>
                      <code className="ai-cell-line ai-code">{item.id}</code>
                    </td>
                    <td className="ai-cell-main">
                      <strong>{channel?.name}</strong>
                      <code className="ai-cell-line ai-code">{item.upstreamModel}</code>
                    </td>
                    <td>
                      <div className="ai-actions">
                        {item.capabilities.map((capability) => (
                          <Badge
                            key={capability}
                            tone={data.defaults[capability as Capability] === item.id ? 'info' : 'neutral'}
                          >
                            {labels[capability]}
                            {data.defaults[capability as Capability] === item.id ? ' · 默认' : ''}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="ai-nowrap">
                      <Badge tone={active ? 'success' : 'neutral'}>
                        {active ? '启用' : item.enabled ? '渠道已停用' : '已停用'}
                      </Badge>
                    </td>
                    <td>
                      <div className="ai-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!active}
                          onClick={() => setDialog({ kind: 'test', item })}
                        >
                          <Play size={14} />
                          测试
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`编辑模型 ${item.name}`}
                          title="编辑模型"
                          onClick={() => setDialog({ kind: 'edit', item })}
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          size="icon"
                          variant="danger-ghost"
                          aria-label={`删除模型 ${item.name}`}
                          title="删除模型"
                          onClick={() => setDialog({ kind: 'delete', item })}
                        >
                          <Trash2 size={15} />
                        </Button>
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
        <ModelEditor
          item={dialog?.kind === 'edit' ? dialog.item : undefined}
          seed={seed}
          channels={data.channels}
          onClose={close}
          onSaved={saved}
        />
      )}
      {dialog?.kind === 'defaults' && <DefaultEditor data={data} onClose={close} onSaved={saved} />}
      {dialog?.kind === 'test' && (
        <TestModel
          item={dialog.item}
          onClose={close}
          showRequest={(id) => {
            close()
            showRequest(id)
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <Confirm
          title={`删除「${dialog.item.name}」？`}
          description="若此模型仍被默认设置、插件指派或白名单引用，请先移除引用。"
          onClose={close}
          remove={async () => {
            await rpc(`/models/${dialog.item.id}`, 'DELETE')
            saved()
          }}
        />
      )}
    </div>
  )
}

function ModelEditor({
  item,
  seed,
  channels,
  onClose,
  onSaved,
}: {
  item?: ModelView
  seed?: ModelSeed
  channels: ChannelView[]
  onClose: () => void
  onSaved: () => void
}) {
  const form = useId()
  const action = useAction()
  const initialChannel = channels.find((item) => item.id === seed?.channelId) ?? channels[0]
  const [draft, setDraft] = useState<ModelDraft>(
    item
      ? {
          name: item.name,
          channelId: item.channelId,
          upstreamModel: item.upstreamModel,
          capabilities: item.capabilities,
          enabled: item.enabled,
        }
      : {
          name: seed?.discovered.name.slice(0, 100) ?? '',
          channelId: initialChannel?.id ?? '',
          upstreamModel: seed?.discovered.upstreamModel ?? '',
          capabilities: initialChannel?.protocol === 'system-one' ? ['decision'] : [],
          enabled: true,
        },
  )
  const channel = channels.find((item) => item.id === draft.channelId)
  const supported = channel ? protocolInfo[channel.protocol].supports : []
  const toggle = (value: Capability | Feature, checked: boolean) =>
    setDraft({
      ...draft,
      capabilities: checked
        ? [...draft.capabilities, value]
        : draft.capabilities.filter(
            (item) => item !== value && !(value === 'chat' && features.some((feature) => feature === item)),
          ),
    })

  return (
    <Dialog
      open
      className="ai-dialog"
      title={item ? '编辑模型' : '添加模型'}
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          <Button disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button
            form={form}
            type="submit"
            variant="primary"
            loading={action.busy}
            disabled={!draft.capabilities.length}
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
            await rpc(item ? `/models/${item.id}` : '/models', item ? 'PUT' : 'POST', draft)
            onSaved()
          })
        }}
      >
        <PickField
          label="所属渠道"
          value={draft.channelId}
          choices={channels.map(({ id, name }) => ({ value: id, label: name }))}
          disabled={!!item}
          onChange={(channelId) => {
            const next = channels.find((candidate) => candidate.id === channelId)
            setDraft({
              ...draft,
              channelId,
              capabilities: next?.protocol === 'system-one' ? ['decision'] : [],
            })
          }}
        />
        <Field required label="显示名称" htmlFor={`${form}-name`}>
          <Input
            id={`${form}-name`}
            required
            maxLength={100}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field
          required
          label="上游模型名"
          htmlFor={`${form}-model`}
          hint={channel?.protocol === 'system-one' ? '例如 jev-latest，也可以填写固定版本。' : undefined}
        >
          <Input
            id={`${form}-model`}
            required
            maxLength={250}
            value={draft.upstreamModel}
            onChange={(event) => setDraft({ ...draft, upstreamModel: event.target.value })}
          />
        </Field>
        {item && (
          <Field label="本地模型 ID" htmlFor={`${form}-id`}>
            <Input id={`${form}-id`} value={item.id} readOnly onFocus={(event) => event.target.select()} />
          </Field>
        )}
        <fieldset className="ai-checklist">
          <legend>模型能力</legend>
          {supported.map((value) => (
            <label key={value} className="ai-check">
              <input
                type="checkbox"
                checked={draft.capabilities.includes(value)}
                disabled={
                  features.some((feature) => feature === value) && !draft.capabilities.includes('chat')
                }
                onChange={(event) => toggle(value, event.target.checked)}
              />
              {labels[value]}
            </label>
          ))}
        </fieldset>
        <div className="ai-switch">
          <Switch
            aria-label="启用模型"
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          启用模型
        </div>
        <FormError error={action.error} />
      </form>
    </Dialog>
  )
}

export function DefaultFields({
  data,
  value,
  onChange,
  allowlist,
}: {
  data: CatalogView
  value: Defaults
  onChange: (value: Defaults) => void
  allowlist?: string[] | null
}) {
  const channels = new Map(data.channels.map((channel) => [channel.id, channel]))
  const available = data.models.filter((model) => allowlist == null || allowlist.includes(model.id))
  const inherited = { value: '', label: allowlist === undefined ? '不设默认' : '使用全局默认' }
  return (
    <div className="ai-form-row">
      {capabilities.map((capability) => (
        <PickField
          key={capability}
          label={labels[capability]}
          value={value[capability] ?? ''}
          choices={[
            inherited,
            ...available
              .filter((model) => model.capabilities.includes(capability))
              .map((model) => {
                const channel = channels.get(model.channelId)
                const location = channel ? ` · ${channel.name}` : ''
                const disabled = model.enabled && channel?.enabled ? '' : '（停用）'
                return { value: model.id, label: `${model.name}${location}${disabled}` }
              }),
          ]}
          onChange={(modelId) => {
            const next = { ...value }
            if (modelId) next[capability] = modelId
            else delete next[capability]
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}

function DefaultEditor({
  data,
  onClose,
  onSaved,
}: {
  data: CatalogView
  onClose: () => void
  onSaved: () => void
}) {
  const action = useAction()
  const [draft, setDraft] = useState(data.defaults)
  return (
    <Dialog
      open
      className="ai-dialog"
      title="全局默认模型"
      description="插件未显式指定模型、也没有专属默认时，使用此处的设置。"
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={action.busy}
            onClick={() => {
              void action.run(async () => {
                await rpc('/defaults', 'PUT', draft)
                onSaved()
              })
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="ai-form">
        <DefaultFields data={data} value={draft} onChange={setDraft} />
        <FormError error={action.error} />
      </div>
    </Dialog>
  )
}

function TestModel({
  item,
  onClose,
  showRequest,
}: {
  item: ModelView
  onClose: () => void
  showRequest: (id: string) => void
}) {
  const supported = capabilities.filter((capability) => item.capabilities.includes(capability))
  const [capability, setCapability] = useState<Capability | undefined>(supported[0])
  const [requestId, setRequestId] = useState<string>()
  const action = useAction()
  const run = () => {
    setRequestId(undefined)
    void action.run(async () => {
      try {
        const result = await rpc<{ requestId: string }>('/test', 'POST', { modelId: item.id, capability })
        setRequestId(result.requestId)
      } catch (error) {
        if (error instanceof Error && 'data' in error) {
          const response = error.data as { error?: { requestId?: string } } | undefined
          setRequestId(response?.error?.requestId)
        }
        throw error
      }
    })
  }
  return (
    <Dialog
      open
      className="ai-dialog"
      title={`测试「${item.name}」`}
      description="测试会实际调用上游，可能产生用量。"
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          {requestId && <Button onClick={() => showRequest(requestId)}>查看请求</Button>}
          <Button variant="primary" disabled={!capability} loading={action.busy} onClick={run}>
            发送测试
          </Button>
        </>
      }
    >
      <div className="ai-form">
        <PickField
          label="测试能力"
          value={capability}
          choices={supported.map((value) => ({ value, label: labels[value] }))}
          onChange={setCapability}
          disabled={action.busy}
        />
        <FormError error={action.error} />
        {requestId && !action.error && (
          <div role="status">
            <Badge tone="success">测试成功</Badge>
          </div>
        )}
      </div>
    </Dialog>
  )
}
