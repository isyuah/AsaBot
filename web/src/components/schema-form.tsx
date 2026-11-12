import { Braces, Plus, RotateCcw, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { softSpring } from '../lib/motion.ts'
import type { JsonSchema } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Field, Input, Textarea } from './ui/input.tsx'
import { Select } from './ui/select.tsx'
import { Switch } from './ui/switch.tsx'

type Value = unknown
type Issues = Record<string, string>

function typeOf(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== 'null')
  return schema.type
}

/** Whether every field of this schema can be rendered as a form control (otherwise fall back to JSON). */
function isSupported(schema: JsonSchema): boolean {
  const type = typeOf(schema)
  if (schema.enum) return true
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return true
  if (type === 'array') {
    const item = schema.items ? typeOf(schema.items) : undefined
    return item === 'string' || item === 'number' || item === 'integer'
  }
  if (type === 'object') return Object.values(schema.properties ?? {}).every(isSupported)
  return false
}

function defaultsOf(schema: JsonSchema): Value {
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
  const base = value && typeof value === 'object' ? (value as Record<string, Value>) : {}
  return { ...base, [head]: setAt(base[head], rest, next) }
}

function getAt(value: Value, path: string[]): Value {
  return path.reduce<Value>(
    (current, key) =>
      current && typeof current === 'object' ? (current as Record<string, Value>)[key] : undefined,
    value,
  )
}

/**
 * Renders a plugin config form from its JSON Schema (generated server-side by z.toJSONSchema). Objects, primitives,
 * enums and primitive arrays get real controls; anything else falls back to a JSON editor so no config is uneditable.
 */
export function SchemaForm({
  schema,
  value,
  issues,
  saving,
  onSubmit,
}: {
  schema: JsonSchema
  value: Value
  issues: Issues
  saving: boolean
  onSubmit: (value: Value) => void
}) {
  const initial = useMemo(() => value ?? defaultsOf(schema), [schema, value])
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
    try {
      onSubmit(JSON.parse(jsonText))
      setJsonError(null)
    } catch {
      setJsonError('不是合法的 JSON')
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12.5px] text-fg-3">保存后写回配置文件并重载插件</p>
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
        {dirty && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={softSpring}
            className="sticky bottom-0 mt-6 -mx-6 flex items-center justify-between gap-3 border-t border-border bg-surface/90 px-6 py-3 backdrop-blur"
          >
            <span className="text-[12.5px] text-fg-3">有未保存的修改</span>
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
                保存并重载
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
  invalid,
  onChange,
}: {
  id: string
  schema: JsonSchema
  value: Value
  invalid: boolean
  onChange: (value: Value) => void
}) {
  const type = typeOf(schema)
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
  return (
    <Input
      id={id}
      value={typeof value === 'string' ? value : ''}
      aria-invalid={invalid}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function ListControl({
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
