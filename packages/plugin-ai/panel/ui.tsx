import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Field,
  Select,
  type SelectOption,
  Skeleton,
  type Tone,
} from '@asabot/panel-ui'
import { CircleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { Capability, Feature, QueryFilters, RequestState, UsageField } from '../src/contracts.ts'

declare global {
  interface Window {
    asabot?: {
      json<T>(path: string, options?: { method: string; body?: unknown }): Promise<T>
      toast(message: string, level?: 'success' | 'error' | 'info'): void
    }
  }
}

export const labels: Record<Capability | Feature, string> = {
  chat: '对话',
  image: '图片生成',
  speech: '语音合成',
  decision: '结构化决策',
  vision: '图片输入',
  stream: '流式输出',
  tools: '工具调用',
  structured: '结构化输出',
}

const states: Record<RequestState, { name: string; tone: Tone }> = {
  running: { name: '进行中', tone: 'info' },
  succeeded: { name: '成功', tone: 'success' },
  failed: { name: '失败', tone: 'danger' },
  rejected: { name: '未发出', tone: 'warning' },
  timeout: { name: '超时', tone: 'danger' },
  cancelled: { name: '已取消', tone: 'neutral' },
  interrupted: { name: '中断', tone: 'warning' },
}

export const usageLabels: Record<UsageField, string> = {
  inputTokens: '输入 Token',
  outputTokens: '输出 Token',
  cachedInputTokens: '缓存命中 Token',
  reasoningTokens: '推理 Token',
  images: '生成图片（张）',
  speechCharacters: '语音输入（字符）',
  audioSeconds: '音频时长（秒）',
  decisions: '已回答的决策问题',
}

export const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
export const clock = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'UTC',
})
export const asDuration = (value: number | null | undefined) =>
  value == null ? '—' : value < 1000 ? `${number.format(value)} ms` : `${number.format(value / 1000)} s`
export const sourceName = (value: string) => (value === '@panel' ? '面板测试' : value)
export const stateName = (value: RequestState) => states[value].name

export function Status({ value }: { value: RequestState }) {
  return <Badge tone={states[value].tone}>{states[value].name}</Badge>
}

export function rpc<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!window.asabot || window.parent === window)
    return Promise.reject(new Error('请从 AsaBot 控制台打开 AI 管理'))
  return window.asabot.json<T>(path, { method, body: method !== 'GET' && body === undefined ? {} : body })
}

export function useRemote<T>(path: string | null, version = 0) {
  const [retry, setRetry] = useState(0)
  const refresh = useCallback(() => setRetry((current) => current + 1), [])
  const [state, setState] = useState<{
    path: string
    version: number
    retry: number
    data?: T
    error?: Error
  }>()
  useEffect(() => {
    if (!path) return
    let current = true
    void rpc<T>(path).then(
      (data) => {
        if (current) setState({ path, version, retry, data })
      },
      (error: Error) => {
        if (current) setState({ path, version, retry, error })
      },
    )
    return () => {
      current = false
    }
  }, [path, version, retry])
  return {
    data: state?.path === path ? state.data : undefined,
    error:
      state?.path === path && state.version === version && state.retry === retry ? state.error : undefined,
    loading: path !== null && (state?.path !== path || state.version !== version || state.retry !== retry),
    refresh,
  }
}

export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (error) {
      setError(error instanceof Error ? error : new Error('操作失败'))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export function RemoteError({
  error,
  retry,
  loading,
}: {
  error: Error
  retry: () => void
  loading?: boolean
}) {
  return <ErrorState error={error} onRetry={retry} retrying={loading} />
}

export function Loading() {
  return (
    <div className="ai-stack" role="status" aria-label="正在加载">
      <Skeleton className="ai-skeleton" />
      <Skeleton className="ai-skeleton" />
    </div>
  )
}

export function FormError({ error }: { error?: Error }) {
  return (
    error && (
      <div className="ai-error" role="alert">
        <CircleAlert size={16} aria-hidden="true" />
        {error.message}
      </div>
    )
  )
}

export function PickField<Value extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
}: {
  label: string
  value: Value | undefined
  choices: readonly SelectOption<Value>[]
  onChange: (value: Value) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <Field label={label} htmlFor={id} className="min-w-0">
      <Select
        className="w-full"
        id={id}
        value={value}
        onValueChange={onChange}
        options={choices}
        disabled={disabled}
      />
    </Field>
  )
}

export function Confirm({
  title,
  description,
  onClose,
  remove,
}: {
  title: string
  description: string
  onClose: () => void
  remove: () => Promise<void>
}) {
  const action = useAction()
  return (
    <Dialog
      open
      title={title}
      description={description}
      onOpenChange={() => {
        if (!action.busy) onClose()
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={action.busy}
            onClick={() => {
              void action.run(remove)
            }}
          >
            删除
          </Button>
        </>
      }
    >
      <FormError error={action.error} />
    </Dialog>
  )
}

export function queryPath(
  path: string,
  values: QueryFilters & { before?: number; groupBy?: string },
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return params.size ? `${path}?${params}` : path
}
