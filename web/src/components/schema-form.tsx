import { Braces, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { softSpring } from '../lib/motion.ts'
import type { JsonSchema } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Field, Input, Textarea } from './ui/input.tsx'
import { Select } from './ui/select.tsx'
import { Switch } from './ui/switch.tsx'

type Value = unknown
type Issues = Record<string, string>

const primitives = new Set(['string', 'number', 'integer', 'boolean'])
/** Keys whose values the server masks; mirrors the redaction list of the backend. */
const secretKeys = new Set(['accessToken', 'token', 'password', 'apiToken', 'appSecret'])

/**
 * The field type, with one addition: `scalar` for an anyOf of primitives (e.g. durations accepted as 30000 or
 * "30s"), edited as text where a purely numeric entry is stored as a number.
 */
function typeOf(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== 'null')
  if (schema.type === undefined && schema.anyOf?.every((option) => primitives.has(typeOf(option) ?? '')))
    return 'scalar'
  return schema.type
}

/** Whether every field of this schema can be rendered as a form control (otherwise fall back to JSON). */
/** Labelled choices: the standard JSON Schema idiom `oneOf: [{ const, title }]`. */
function labelledChoices(schema: JsonSchema): { value: unknown; label: string }[] | undefined {
  if (!schema.oneOf?.length || !schema.oneOf.every((option) => option.const !== undefined)) return undefined
  return schema.oneOf.map((option) => ({ value: option.const, label: option.title ?? String(option.const) }))
}

function isSupported(schema: JsonSchema): boolean {
  const type = typeOf(schema)
  if (schema.enum || schema.const !== undefined || labelledChoices(schema)) return true
  if (type === 'scalar' || primitives.has(type ?? '')) return true
  if (type === 'array') {
    const item = schema.items ? typeOf(schema.items) : undefined
    if (item === 'object') return isSupported(schema.items as JsonSchema)
    return item === 'string' || item === 'number' || item === 'integer'
  }
  if (type === 'object') return Object.values(schema.properties ?? {}).every(isSupported)
  return false
}

function defaultsOf(schema: JsonSchema): Value {
  if (schema.const !== undefined) return schema.const
  if (schema.default !== undefined) return schema.default
  if (typeOf(schema) === 'object') {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, child]) => [key, defaultsOf(child)]),
    )
  }
  return undefined
}

function setAt(value: Value, path: string[], next: Value): Value {
  if (path.length === 0) return next
  const [head, ...rest] = path as [string, ...string[]]
  if (Array.isArray(value)) {
    const copy = [...value]
    copy[Number(head)] = setAt(copy[Number(head)], rest, next)
    return copy
  }
  const base = value && typeof value === 'object' ? (value as Record<string, Value>) : {}
  return { ...base, [head]: setAt(base[head], rest, next) }
}

/** Server issue paths look like `a.b[0].c`; the form keys fields by `a.b.0.c`. */
function normalizeIssueKeys(issues: Issues): Issues {
  return Object.fromEntries(
    Object.entries(issues).map(([path, message]) => [path.replace(/\[(\d+)\]/g, '.$1'), message]),
  )
}

function defaultHint(schema: JsonSchema): string | undefined {
  const value = schema.default
  if (value === undefined || value === '' || typeof value === 'object') return undefined
  return `默认 ${String(value)}`
}

function getAt(value: Value, path: string[]): Value {
  return path.reduce<Value>(
    (current, key) =>
      current && typeof current === 'object' ? (current as Record<string, Value>)[key] : undefined,
    value,
  )
}

/**
 * Renders a config form from its JSON Schema (generated server-side by z.toJSONSchema). Objects, primitives, enums,
 * primitive unions, primitive arrays and arrays of objects get real controls; anything else falls back to a JSON
 * editor so no config is uneditable.
 */
export function SchemaForm({
  schema,
  value,
  issues: rawIssues,
  saving,
  onSubmit,
  note = '保存后写回配置文件并重载插件',
  submitLabel = '保存并重载',
  submitWhenPristine = false,
}: {
  schema: JsonSchema
  value: Value
  issues: Issues
  saving: boolean
  onSubmit: (value: Value) => void
  note?: ReactNode
  submitWhenPristine?: boolean
  submitLabel?: string
}) {
  const issues = useMemo(() => normalizeIssueKeys(rawIssues), [rawIssues])
  const initialText = JSON.stringify(value ?? defaultsOf(schema))
  const initial = useMemo<Value>(
    () => (initialText === undefined ? undefined : JSON.parse(initialText)),
    [initialText],
  )
  const supported = useMemo(() => isSupported(schema), [schema])
  const [draft, setDraft] = useState<Value>(initial)
  const [jsonMode, setJsonMode] = useState(!supported)
  const [jsonText, setJsonText] = useState(() => JSON.stringify(initial, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(initial)
    setJsonText(JSON.stringify(initial, null, 2))
  }, [initial])

  const dirty = jsonMode
    ? jsonText !== JSON.stringify(initial, null, 2)
    : JSON.stringify(draft) !== JSON.stringify(initial)

  const submit = () => {
    if (!jsonMode) return onSubmit(draft)
    let value: Value
    try {
      value = JSON.parse(jsonText)
    } catch {
      setJsonError('不是合法的 JSON')
      return
    }
    setJsonError(null)
    onSubmit(value)
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12.5px] text-fg-3">{note}</p>
        {supported && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!jsonMode) setJsonText(JSON.stringify(draft, null, 2))
              else {
                try {
                  setDraft(JSON.parse(jsonText))
                  setJsonError(null)
                } catch {
                  setJsonError('JSON 有误，无法切回表单')
                  return
                }
              }
              setJsonMode(!jsonMode)
            }}
          >
            <Braces className="size-3.5" />
            {jsonMode ? '表单' : 'JSON'}
          </Button>
        )}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {jsonMode ? (
          <motion.div
            key="json"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Textarea
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              spellCheck={false}
              className="min-h-64 font-mono text-[12.5px]"
              aria-invalid={jsonError !== null}
            />
            {jsonError && <p className="mt-1.5 text-[12px] text-danger">{jsonError}</p>}
            {Object.keys(issues).length > 0 && (
              <ul className="mt-3 space-y-1 rounded-xl bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
                {Object.entries(issues).map(([path, message]) => (
                  <li key={path}>
                    <span className="font-mono">{path || '(根)'}</span>：{message}
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="space-y-5"
          >
            <SchemaFields
              schema={schema}
              value={draft}
              path={[]}
              issues={issues}
              onChange={(path, next) => setDraft((current: Value) => setAt(current, path, next))}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(dirty || submitWhenPristine) && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={softSpring}
            className="sticky bottom-0 mt-6 -mx-6 flex items-center justify-between gap-3 border-t border-border bg-surface/90 px-6 py-3 backdrop-blur"
          >
            <span className="text-[12.5px] text-fg-3">{dirty ? '有未保存的修改' : '填写完成后保存'}</span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(initial)
                  setJsonText(JSON.stringify(initial, null, 2))
                  setJsonError(null)
                }}
              >
                <RotateCcw className="size-3.5" />
                还原
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={submit}>
                {submitLabel}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function SchemaFields({
  schema,
  value,
  path,
  issues,
  onChange,
}: {
  schema: JsonSchema
  value: Value
  path: string[]
  issues: Issues
  onChange: (path: string[], value: Value) => void
}) {
  const properties = Object.entries(schema.properties ?? {})
  if (properties.length === 0) return <p className="text-[13px] text-fg-3">这个插件没有可配置项。</p>
  return (
    <>
      {properties.map(([key, child]) => {
        const childPath = [...path, key]
        const id = `field-${childPath.join('-')}`
        const label = child.title ?? key
        const required = schema.required?.includes(key) && child.default === undefined
        const error = issues[childPath.join('.')]
        const current = getAt(value, [key])
        const type = typeOf(child)
        // Constants (e.g. a discriminator like type: 'forward') are filled in by defaultsOf, not edited.
        if (child.const !== undefined) return null

        if (type === 'array' && child.items && typeOf(child.items) === 'object') {
          const itemSchema = child.items
          return (
            <Field key={key} label={label} hint={child.description} error={error} htmlFor={id}>
              <ObjectListControl
                schema={itemSchema}
                value={Array.isArray(current) ? current : []}
                path={childPath}
                issues={issues}
                onChange={onChange}
              />
            </Field>
          )
        }

        if (type === 'object' && !child.enum) {
          return (
            <fieldset key={key} className="space-y-4 rounded-xl border border-border p-4">
              <legend className="px-1 text-[12.5px] font-medium text-fg-2">{label}</legend>
              <SchemaFields
                schema={child}
                value={current}
                path={childPath}
                issues={issues}
                onChange={onChange}
              />
            </fieldset>
          )
        }

        if (type === 'boolean') {
          return (
            <div
              key={key}
              className="flex items-start justify-between gap-4 rounded-xl border border-border px-4 py-3"
            >
              <div>
                <label htmlFor={id} className="text-[13px] font-medium text-fg">
                  {label}
                </label>
                {child.description && <p className="mt-0.5 text-[12px] text-fg-3">{child.description}</p>}
                {error && <p className="mt-0.5 text-[12px] text-danger">{error}</p>}
              </div>
              <Switch
                aria-label={label}
                checked={current === true}
                onCheckedChange={(checked) => onChange(childPath, checked)}
              />
            </div>
          )
        }

        return (
          <Field
            key={key}
            label={label}
            hint={child.description}
            error={error}
            required={required}
            htmlFor={id}
          >
            <PrimitiveControl
              id={id}
              schema={child}
              value={current}
              secret={secretKeys.has(key) || child.writeOnly === true}
              invalid={Boolean(error)}
              onChange={(next) => onChange(childPath, next)}
            />
          </Field>
        )
      })}
    </>
  )
}

function PrimitiveControl({
  id,
  schema,
  value,
  secret = false,
  invalid,
  onChange,
}: {
  id: string
  schema: JsonSchema
  value: Value
  secret?: boolean
  invalid: boolean
  onChange: (value: Value) => void
}) {
  const type = typeOf(schema)
  if (type === 'scalar') {
    const numeric = schema.anyOf?.some(
      (option) => typeOf(option) === 'number' || typeOf(option) === 'integer',
    )
    return (
      <Input
        id={id}
        value={value === undefined ? '' : String(value)}
        placeholder={defaultHint(schema)}
        aria-invalid={invalid}
        onChange={(event) => {
          const text = event.target.value.trim()
          onChange(text === '' ? undefined : numeric && /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text)
        }}
        className="font-mono"
      />
    )
  }
  const choices = labelledChoices(schema)
  if (choices) {
    return (
      <Select
        aria-label={id}
        className="w-full"
        value={value === undefined ? undefined : String(value)}
        onValueChange={(next) =>
          onChange(choices.find((option) => String(option.value) === next)?.value as Value)
        }
        options={choices.map((option) => ({ value: String(option.value), label: option.label }))}
      />
    )
  }
  if (schema.enum) {
    return (
      <Select
        aria-label={id}
        className="w-full"
        value={value === undefined ? undefined : String(value)}
        onValueChange={(next) => onChange(schema.enum?.find((option) => String(option) === next))}
        options={schema.enum.map((option) => ({ value: String(option), label: String(option) }))}
      />
    )
  }
  if (type === 'number' || type === 'integer') {
    return (
      <Input
        id={id}
        type="number"
        inputMode={type === 'integer' ? 'numeric' : 'decimal'}
        step={type === 'integer' ? 1 : 'any'}
        min={schema.minimum}
        max={schema.maximum}
        value={typeof value === 'number' ? value : ''}
        placeholder={defaultHint(schema)}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        className="tabular"
      />
    )
  }
  if (type === 'array')
    return (
      <ListControl
        id={id}
        itemType={schema.items ? typeOf(schema.items) : 'string'}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
      />
    )
  const text = typeof value === 'string' ? value : ''
  // `${VAR}` references are not secrets themselves; literal secrets come back masked and are replaced wholesale.
  const masked = secret && !text.startsWith('${')
  return (
    <Input
      id={id}
      type={masked ? 'password' : 'text'}
      autoComplete={secret ? 'off' : undefined}
      value={text}
      placeholder={defaultHint(schema)}
      aria-invalid={invalid}
      onFocus={secret ? (event) => event.target.select() : undefined}
      onChange={(event) => onChange(event.target.value)}
      className={cn(secret && 'font-mono')}
    />
  )
}

function ObjectListControl({
  schema,
  value,
  path,
  issues,
  onChange,
}: {
  schema: JsonSchema
  value: Value[]
  path: string[]
  issues: Issues
  onChange: (path: string[], value: Value) => void
}) {
  // Items have no identity of their own; a parallel list of keys keeps animations and inputs stable on removal.
  const [keys, setKeys] = useState<string[]>(() => value.map(() => crypto.randomUUID()))
  const ids = value.map((_, index) => keys[index] ?? `item-${index}`)
  return (
    <div className="space-y-2.5">
      <AnimatePresence initial={false}>
        {value.map((item, index) => (
          <motion.div
            key={ids[index]}
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={softSpring}
            className="rounded-xl border border-border bg-surface-2/40 p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[12px] font-medium text-fg-3 tabular">#{index + 1}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除第 ${index + 1} 项`}
                onClick={() => {
                  setKeys(ids.filter((_, i) => i !== index))
                  onChange(
                    path,
                    value.filter((_, i) => i !== index),
                  )
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-4">
              <SchemaFields
                schema={schema}
                value={item}
                path={[...path, String(index)]}
                issues={issues}
                onChange={onChange}
              />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setKeys([...ids, crypto.randomUUID()])
          onChange(path, [...value, defaultsOf(schema)])
        }}
      >
        <Plus className="size-3.5" />
        添加一项
      </Button>
    </div>
  )
}

export function ListControl({
  id,
  itemType,
  value,
  onChange,
}: {
  id: string
  itemType?: string
  value: Value[]
  onChange: (value: Value) => void
}) {
  const [input, setInput] = useState('')
  const numeric = itemType === 'number' || itemType === 'integer'
  const add = () => {
    const text = input.trim()
    if (!text) return
    const item = numeric ? Number(text) : text
    if (numeric && Number.isNaN(item)) return
    // Values are kept unique, so each chip can be keyed by its value.
    if (!value.includes(item)) onChange([...value, item])
    setInput('')
  }
  return (
    <div className="rounded-[10px] border border-border bg-surface p-1.5 transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
      <div className="flex flex-wrap gap-1.5">
        <AnimatePresence initial={false}>
          {value.map((item, index) => (
            <motion.span
              key={String(item)}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={softSpring}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-surface-2 pr-1 pl-2.5 font-mono text-[12.5px] text-fg"
            >
              {String(item)}
              <button
                type="button"
                aria-label={`移除 ${String(item)}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="flex size-5 cursor-pointer items-center justify-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <div className="flex min-w-32 flex-1 items-center">
          <input
            id={id}
            value={input}
            inputMode={numeric ? 'numeric' : undefined}
            placeholder={value.length === 0 ? '输入后按回车添加' : ''}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              } else if (event.key === 'Backspace' && !input && value.length > 0) onChange(value.slice(0, -1))
            }}
            className="h-7 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-fg-3"
          />
          <button
            type="button"
            aria-label="添加"
            onClick={add}
            className={cn(
              'flex size-7 cursor-pointer items-center justify-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg',
              !input && 'invisible',
            )}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
