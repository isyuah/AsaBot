import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  Command,
  Copy,
  Database,
  FileCode2,
  Layers3,
  Menu,
  MessageSquare,
  Plus,
  Puzzle,
  RefreshCw,
  Terminal,
  Timer,
  X,
} from 'lucide-react'
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

type Example = 'hello' | 'greet' | 'coffee'
type DocTopic = 'start' | 'plugins' | 'deploy'
type Capability = 'storage' | 'tasks' | 'services'
type ChatMessage = { id: number; role: 'bot' | 'user'; text: string }
const nl = '\n'
const examples: Record<Example, { label: string; file: string; input: string; intro: string; code: string }> =
  {
    hello: {
      label: '一句问候',
      file: 'hello.ts',
      input: '/hello 世界',
      intro: '每一个好点子，都可以从一句问候开始。',
      code: [
        "import { definePlugin } from '@asabot/core'",
        '',
        'export default definePlugin({',
        "  name: 'hello',",
        '  setup(ctx) {',
        "    ctx.command('hello [name=朋友]')",
        "      .description('打个招呼')",
        '      .action(({ args }) => {',
        "        return '你好，' + args.name + '！'",
        '      })',
        '  },',
        '})',
      ].join(nl),
    },
    greet: {
      label: '一段对话',
      file: 'greet.ts',
      input: '/greet',
      intro: '对话可以继续。试试让机器人认识你。',
      code: [
        "import { definePlugin } from '@asabot/core'",
        '',
        'export default definePlugin({',
        "  name: 'greet',",
        '  setup(ctx) {',
        "    ctx.command('greet')",
        '      .action(async ({ session }) => {',
        '        const reply = await session.prompt(',
        "          '你叫什么名字？',",
        '        )',
        '        if (!reply) return',
        "        return '很高兴认识你，' + reply.text + '。'",
        '      })',
        '  },',
        '})',
      ].join(nl),
    },
    coffee: {
      label: '一点记忆',
      file: 'coffee.ts',
      input: '/coffee',
      intro: '为日常留下一点记忆。来杯咖啡吧。',
      code: [
        "import { definePlugin } from '@asabot/core'",
        '',
        'export default definePlugin({',
        "  name: 'coffee',",
        '  setup(ctx) {',
        "    ctx.command('coffee').action(() => {",
        '      const cups =',
        "        (ctx.store.get<number>('cups') ?? 0) + 1",
        "      ctx.store.set('cups', cups)",
        "      return '第 ' + cups + ' 杯咖啡，慢慢享用。'",
        '    })',
        '  },',
        '})',
      ].join(nl),
    },
  }
const capabilities: Record<
  Capability,
  { title: string; description: string; file: string; code: string; icon: typeof Database }
> = {
  storage: {
    title: '数据，有自己的位置',
    description: '轻量数据存进插件独立的 KV，复杂查询交给 SQLite。存储和迁移，都在手边。',
    file: 'storage.ts',
    icon: Database,
    code: [
      '// 一个插件，一个独立的命名空间。',
      "ctx.store.set('theme', 'morning')",
      "const theme = ctx.store.get<string>('theme')",
      '',
      '// 需要更多？直接使用 SQLite。',
      'ctx.migrate([',
      "  'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)',",
      '])',
      '',
      "ctx.db.prepare('SELECT * FROM notes').all()",
    ].join(nl),
  },
  tasks: {
    title: '把时间，也写进插件',
    description: '定时执行、周期调度，使用熟悉的表达方式。插件卸载时，任务随之自动回收。',
    file: 'schedule.ts',
    icon: Timer,
    code: [
      '// 每天早上，做一点有趣的事。',
      "ctx.cron('0 9 * * *', () => {",
      "  ctx.logger.info('新的一天，早上好。')",
      '})',
      '',
      '// 也可以简单地，每隔一小时。',
      "ctx.interval('1h', () => {",
      "  ctx.logger.info('起来走走，喝杯水。')",
      '})',
    ].join(nl),
  },
  services: {
    title: '好能力，值得被复用',
    description: '通过服务注入连接插件，让独立的功能彼此协作。依赖关系明确，类型提示一路相随。',
    file: 'services.ts',
    icon: Puzzle,
    code: [
      "import { definePlugin } from '@asabot/core'",
      '',
      'export default definePlugin({',
      "  name: 'shared',",
      '  setup(ctx) {',
      '    // 让一个插件的能力，成为另一个的起点。',
      "    ctx.provide('greeting', {",
      "      hello: (name: string) => '你好，' + name,",
      '    })',
      '  },',
      '})',
    ].join(nl),
  },
}
const startCommands = ['pnpm install', 'pnpm --filter web build', 'pnpm start'].join(nl)
const ease = [0.22, 1, 0.36, 1] as const
const keywords = new Set([
  'import',
  'from',
  'export',
  'default',
  'const',
  'return',
  'async',
  'await',
  'if',
  'new',
])
const functions = new Set([
  'definePlugin',
  'setup',
  'command',
  'description',
  'action',
  'prompt',
  'set',
  'get',
  'migrate',
  'prepare',
  'all',
  'cron',
  'interval',
  'inject',
  'provide',
  'info',
])

function navigateTabs(event: KeyboardEvent<HTMLDivElement>, vertical = false) {
  const activeTab = event.target
  if (!(activeTab instanceof HTMLButtonElement)) return
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'))
  const index = tabs.indexOf(activeTab)
  const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
  const previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
  const nextIndex =
    event.key === nextKey
      ? (index + 1) % tabs.length
      : event.key === previousKey
        ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : undefined
  if (nextIndex === undefined) return
  event.preventDefault()
  tabs[nextIndex]?.focus()
  tabs[nextIndex]?.click()
}

function Mark({ className = '' }: { className?: string }) {
  return (
    <svg className={`brand-mark ${className}`} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="m9.5 23 6.5-15 6.5 15M12 17.5h8"
        stroke="var(--logo-stroke, white)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.8, ease, delay }}
    >
      {children}
    </motion.div>
  )
}
function CopyButton({
  text,
  label = '复制代码',
  className = '',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2200)
    return () => window.clearTimeout(timer)
  }, [state])
  return (
    <button
      type="button"
      className={`copy-button ${className}`}
      aria-label={state === 'copied' ? '已复制' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setState('copied')
        } catch {
          setState('error')
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {state === 'copied' ? <Check size={15} /> : <Copy size={15} />}
        </motion.span>
      </AnimatePresence>
      <span aria-live="polite">
        {state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请手动选择' : label}
      </span>
    </button>
  )
}
function highlight(line: string) {
  const parts: ReactNode[] = []
  let index = 0
  while (index < line.length) {
    const char = line.charAt(index)
    if (line.slice(index, index + 2) === '//') {
      parts.push(
        <span className="token-comment" key={index}>
          {line.slice(index)}
        </span>,
      )
      break
    }
    if (char === "'" || char === '"' || char === '`') {
      const closing = line.indexOf(char, index + 1)
      const end = closing === -1 ? line.length : closing + 1
      parts.push(
        <span className="token-string" key={index}>
          {line.slice(index, end)}
        </span>,
      )
      index = end
    } else if (/[a-zA-Z0-9_]/.test(char)) {
      let end = index + 1
      while (end < line.length && /[a-zA-Z0-9_]/.test(line.charAt(end))) end++
      const word = line.slice(index, end)
      const kind = keywords.has(word)
        ? 'keyword'
        : functions.has(word)
          ? 'function'
          : word === 'string' || word === 'number'
            ? 'type'
            : /^[0-9]/.test(word)
              ? 'number'
              : ''
      parts.push(
        kind ? (
          <span className={`token-${kind}`} key={index}>
            {word}
          </span>
        ) : (
          word
        ),
      )
      index = end
    } else {
      parts.push(char)
      index++
    }
  }
  return parts
}
function Code({ code, numbers = true }: { code: string; numbers?: boolean }) {
  let offset = 0
  return (
    <pre className={`code ${numbers ? 'with-lines' : ''}`}>
      <code>
        {code.split(nl).map((line, index) => {
          const start = offset
          offset += line.length + 1
          return (
            <span className="code-line" key={start}>
              {numbers && (
                <span className="line-number" aria-hidden="true">
                  {index + 1}
                </span>
              )}
              <span>{highlight(line)}</span>
            </span>
          )
        })}
      </code>
    </pre>
  )
}

function Playground() {
  const [selected, setSelected] = useState<Example>('hello')
  const [input, setInput] = useState(examples.hello.input)
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 0, role: 'bot', text: examples.hello.intro },
  ])
  const [pending, setPending] = useState(false)
  const waiting = useRef(false)
  const cups = useRef(0)
  const nextId = useRef(1)
  const timer = useRef<number | undefined>(undefined)
  const chat = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const uid = useId()
  const example = examples[selected]
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    chat.current?.scrollTo({
      top: chat.current.scrollHeight,
      behavior: reduced || pending || messages.at(-1)?.role === 'user' ? 'instant' : 'smooth',
    })
  }, [messages, pending, reduced])
  function selectExample(value: Example) {
    if (value === selected) return
    window.clearTimeout(timer.current)
    setSelected(value)
    setInput(examples[value].input)
    setMessages([{ id: nextId.current++, role: 'bot', text: examples[value].intro }])
    setPending(false)
    waiting.current = false
    cups.current = 0
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const text = input.trim()
    if (!text || pending) return
    const [command, ...args] = text.split(' ')
    let reply: string
    if (selected === 'hello') {
      reply =
        command === '/hello' || command === 'hello'
          ? `你好，${args.join(' ').trim() || '朋友'}！`
          : '试试 /hello 你的名字，和我打个招呼。'
    } else if (selected === 'greet') {
      if (waiting.current) {
        reply = `很高兴认识你，${text}。`
        waiting.current = false
      } else if (text === '/greet' || text === 'greet') {
        reply = '你叫什么名字？'
        waiting.current = true
      } else {
        reply = '发送 /greet，我们就可以开始一段对话。'
      }
    } else if (text === '/coffee' || text === 'coffee') {
      cups.current += 1
      reply = `第 ${cups.current} 杯咖啡，慢慢享用。`
    } else {
      reply = '发送 /coffee，为自己添一杯咖啡。'
    }
    setMessages((current) => [...current.slice(-15), { id: nextId.current++, role: 'user', text }])
    setInput('')
    setPending(true)
    timer.current = window.setTimeout(
      () => {
        setMessages((current) => [...current, { id: nextId.current++, role: 'bot', text: reply }])
        setPending(false)
      },
      reduced ? 0 : 440,
    )
  }
  return (
    <div className="playground" id="playground">
      <div className="playground-toolbar">
        <div className="example-tabs" role="tablist" aria-label="插件示例">
          {(Object.keys(examples) as Example[]).map((key) => (
            <button
              type="button"
              role="tab"
              aria-selected={key === selected}
              aria-controls={`${uid}-panel`}
              id={`${uid}-${key}`}
              tabIndex={key === selected ? 0 : -1}
              key={key}
              onClick={() => selectExample(key)}
              onKeyDown={(event) => {
                const keys = Object.keys(examples) as Example[]
                const index = keys.indexOf(key)
                const target =
                  event.key === 'ArrowRight'
                    ? keys[(index + 1) % keys.length]
                    : event.key === 'ArrowLeft'
                      ? keys[(index + keys.length - 1) % keys.length]
                      : event.key === 'Home'
                        ? keys[0]
                        : event.key === 'End'
                          ? keys[keys.length - 1]
                          : undefined
                if (target) {
                  event.preventDefault()
                  selectExample(target)
                  document.getElementById(`${uid}-${target}`)?.focus()
                }
              }}
            >
              {key === 'hello' ? (
                <Command size={15} />
              ) : key === 'greet' ? (
                <MessageSquare size={15} />
              ) : (
                <Database size={15} />
              )}
              {examples[key].label}
              {key === selected && (
                <motion.span
                  className="tab-indicator"
                  layoutId="example-tab"
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                />
              )}
            </button>
          ))}
        </div>
        <span className="playground-hint">
          一点代码，一点可能 <ArrowDownLeft size={14} />
        </span>
      </div>
      <div
        className="playground-body"
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={`${uid}-${selected}`}
      >
        <div className="editor-pane">
          <div className="editor-header">
            <span>
              <FileCode2 size={14} /> plugins/{example.file}
            </span>
            <CopyButton text={example.code} />
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selected}
              initial={{ opacity: 0, y: 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.19 }}
            >
              <Code code={example.code} />
            </motion.div>
          </AnimatePresence>
          <div className="editor-status">
            <span>TypeScript</span>
            <span>
              UTF-8 <span className="status-separator">/</span> 轻巧，从第一行开始
            </span>
          </div>
        </div>
        <div className="chat-pane">
          <div className="chat-heading">
            <span className="chat-heading-icon">
              <MessageSquare size={16} />
            </span>
            <div>
              <strong>想法的第一声回响</strong>
              <span>改个名字，或者试试另一段代码。</span>
            </div>
          </div>
          <div className="chat-messages" ref={chat} role="log" aria-label="示例对话" aria-live="polite">
            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  className={`chat-message ${message.role}`}
                  initial={{ opacity: 0, y: reduced ? 0 : 10, scale: reduced ? 1 : 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3, ease }}
                >
                  {message.role === 'bot' && <Mark className="chat-avatar" />}
                  <div className="chat-bubble">{message.text}</div>
                </motion.div>
              ))}
              {pending && (
                <motion.div
                  className="chat-message bot"
                  key="pending"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <Mark className="chat-avatar" />
                  <div className="chat-thinking" role="status" aria-label="正在回复">
                    <span />
                    <span />
                    <span />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <form className="chat-input" onSubmit={submit}>
            <label className="sr-only" htmlFor={`${uid}-input`}>
              发送示例命令
            </label>
            <input
              id={`${uid}-input`}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                selected === 'greet' && waiting.current ? '输入你的名字…' : `试试 ${example.input}`
              }
              autoComplete="off"
              maxLength={120}
            />
            <button type="submit" aria-label="发送消息" disabled={!input.trim() || pending}>
              <ArrowUp size={17} />
            </button>
          </form>
          <div className="chat-footnote">
            在这里试一试{' '}
            <span>
              <kbd>Enter</kbd> 发送
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Toolkit() {
  const [selected, setSelected] = useState<Capability>('storage')
  const uid = useId()
  const item = capabilities[selected]
  return (
    <div className="toolkit">
      <div
        className="toolkit-options"
        role="tablist"
        aria-label="插件开发能力"
        aria-orientation="vertical"
        onKeyDown={(event) => navigateTabs(event, true)}
      >
        {(Object.keys(capabilities) as Capability[]).map((key) => {
          const capability = capabilities[key]
          const Icon = capability.icon
          return (
            <button
              type="button"
              role="tab"
              aria-selected={selected === key}
              tabIndex={selected === key ? 0 : -1}
              aria-controls={`${uid}-panel`}
              id={`${uid}-${key}`}
              key={key}
              className={selected === key ? 'selected' : ''}
              onClick={() => setSelected(key)}
            >
              <span className="toolkit-icon">
                <Icon size={19} strokeWidth={1.6} />
              </span>
              <span>
                <strong>{capability.title}</strong>
                <span className="toolkit-description">{capability.description}</span>
              </span>
              <ChevronRight size={16} className="toolkit-chevron" />
            </button>
          )
        })}
      </div>
      <div
        className="toolkit-editor"
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={`${uid}-${selected}`}
      >
        <div className="editor-header">
          <span>
            <FileCode2 size={14} /> {item.file}
          </span>
          <CopyButton text={item.code} />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={selected}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            <Code code={item.code} numbers={false} />
          </motion.div>
        </AnimatePresence>
        <div className="toolkit-editor-footer">
          <Code2 size={14} />
          <span>熟悉的 TypeScript，顺手的开发体验。</span>
        </div>
      </div>
    </div>
  )
}

function Docs({
  open,
  onOpenChange,
  topic,
  setTopic,
  onReturnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  topic: DocTopic
  setTopic: (topic: DocTopic) => void
  onReturnFocus: () => void
}) {
  const uid = useId()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="docs-overlay" />
        <Dialog.Content
          className="docs-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onReturnFocus()
          }}
        >
          <div className="docs-header">
            <span className="brand">
              <Mark />
              AsaBot <span className="docs-badge">指南</span>
            </span>
            <Dialog.Close className="icon-button" aria-label="关闭指南">
              <X size={20} />
            </Dialog.Close>
          </div>
          <Dialog.Title className="sr-only">AsaBot 开发指南</Dialog.Title>
          <Dialog.Description className="sr-only">从启动框架到编写插件的简明指南。</Dialog.Description>
          <div className="docs-tabs" role="tablist" aria-label="指南章节" onKeyDown={navigateTabs}>
            {(
              [
                ['start', '快速开始'],
                ['plugins', '编写插件'],
                ['deploy', '运行与部署'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                id={`${uid}-${key}`}
                role="tab"
                type="button"
                aria-selected={topic === key}
                tabIndex={topic === key ? 0 : -1}
                aria-controls={`${uid}-panel`}
                onClick={() => setTopic(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="docs-content"
            role="tabpanel"
            id={`${uid}-panel`}
            aria-labelledby={`${uid}-${topic}`}
            key={topic}
          >
            {topic === 'start' ? (
              <>
                <span className="eyebrow">GETTING STARTED</span>
                <h2>从第一条命令开始。</h2>
                <p>
                  准备 Node.js 24 或更高版本、pnpm，以及配置好账号的 OneBot 11 实现。在 AsaBot
                  项目目录中执行：
                </p>
                <div className="docs-code">
                  <CopyButton text={startCommands} />
                  <pre>{startCommands}</pre>
                </div>
                <h3>打开初始化向导</h3>
                <p>
                  访问 <code>http://127.0.0.1:5140</code>
                  ，输入启动终端中显示的一次性设置码，按照向导设置面板密码、超管和适配器。
                </p>
                <h3>试试第一条命令</h3>
                <p>
                  在机器人所在的群或私聊中发送 <code>/help</code> 或 <code>/ping</code>。接下来，在{' '}
                  <code>plugins/</code> 中放入自己的插件。
                </p>
                <button type="button" className="text-link" onClick={() => setTopic('plugins')}>
                  接下来，写一个插件 <ArrowRight size={15} />
                </button>
              </>
            ) : topic === 'plugins' ? (
              <>
                <span className="eyebrow">YOUR FIRST PLUGIN</span>
                <h2>一个文件，一个新能力。</h2>
                <p>
                  创建 <code>plugins/hello.ts</code>，默认导出插件定义。命令、事件和存储，都通过{' '}
                  <code>ctx</code> 使用。
                </p>
                <div className="docs-code">
                  <CopyButton text={examples.hello.code} />
                  <Code code={examples.hello.code} />
                </div>
                <h3>把重复的事交给框架</h3>
                <p>
                  <code>ctx.on</code> 订阅事件，<code>ctx.command</code> 声明命令，<code>ctx.store</code>{' '}
                  保存数据。用 <code>pnpm dev</code> 开启热重载，保存后即可试用新逻辑。
                </p>
                <p>
                  插件卸载时，注册的命令、监听器和定时任务会自动回收。自定义资源可通过{' '}
                  <code>ctx.onDispose</code> 清理。
                </p>
                <div className="docs-note">
                  <FileCode2 size={18} />
                  <span>完整 API 与更多示例位于项目的 README、plugins/ 和 docs/ 目录中。</span>
                </div>
              </>
            ) : (
              <>
                <span className="eyebrow">BUILT TO RUN</span>
                <h2>让好点子，走进日常。</h2>
                <p>
                  开发时使用 <code>pnpm dev</code>，日常运行使用 <code>pnpm start</code>。框架直接运行
                  TypeScript，管理面板需要先构建一次。
                </p>
                <h3>配置与密钥</h3>
                <p>
                  配置位于 <code>asabot.config.yaml</code>，也可用 <code>ASABOT_CONFIG</code>{' '}
                  指定路径。将敏感值放在环境变量或 <code>.env</code> 中，配置支持{' '}
                  <code>$&#123;VAR&#125;</code> 引用。
                </p>
                <h3>保留你的数据</h3>
                <p>
                  默认数据目录为 <code>data/</code>，包含 SQLite
                  数据库和插件文件。备份时先停止框架，再备份整个目录。
                </p>
                <h3>选择部署方式</h3>
                <p>
                  可以直接使用 Node.js，也可以使用项目提供的 Docker 配置。详细的容器、反向代理与备份说明见{' '}
                  <code>docs/DEPLOY.md</code>。
                </p>
                <div className="docs-code">
                  <CopyButton text={['pnpm --filter web build', 'pnpm start'].join(nl)} />
                  <pre>{['pnpm --filter web build', 'pnpm start'].join(nl)}</pre>
                </div>
              </>
            )}
          </div>
          <div className="docs-footer">
            <span>AsaBot · 开发者指南</span>
            <span>
              <kbd>Esc</kbd> 关闭
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Site() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [docsOpen, setDocsOpen] = useState(false)
  const [topic, setTopic] = useState<DocTopic>('start')
  const [scrolled, setScrolled] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const { scrollY } = useScroll()
  useMotionValueEvent(scrollY, 'change', (value) => setScrolled(value > 20))
  function openDocs(value: DocTopic = 'start') {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setTopic(value)
    setDocsOpen(true)
    setMenuOpen(false)
  }
  return (
    <>
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <header className={`site-header ${scrolled ? 'is-scrolled' : ''}`} id="top">
        <nav className="navigation container" aria-label="主导航">
          <a className="brand" href="#top" aria-label="AsaBot 首页">
            <Mark />
            AsaBot
          </a>
          <div className="nav-links">
            <a href="#approach">设计理念</a>
            <a href="#developers">插件开发</a>
            <a href="#start">快速开始</a>
          </div>
          <button className="nav-docs" type="button" onClick={() => openDocs()}>
            阅读文档 <ArrowUpRight size={14} />
          </button>
          <button
            className="menu-button icon-button"
            type="button"
            aria-label={menuOpen ? '关闭导航' : '打开导航'}
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </nav>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              className="mobile-navigation"
              id="mobile-navigation"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
            >
              <a href="#approach" onClickCapture={() => setMenuOpen(false)}>
                设计理念 <ArrowUpRight size={16} />
              </a>
              <a href="#developers" onClickCapture={() => setMenuOpen(false)}>
                插件开发 <ArrowUpRight size={16} />
              </a>
              <a href="#start" onClickCapture={() => setMenuOpen(false)}>
                快速开始 <ArrowUpRight size={16} />
              </a>
              <button type="button" onClick={() => openDocs()}>
                阅读文档 <ArrowUpRight size={16} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </header>
      <main id="main">
        <section className="hero container" aria-labelledby="hero-title">
          <Reveal>
            <span className="hero-eyebrow">
              <span className="eyebrow-line" />
              THE TYPESCRIPT BOT FRAMEWORK
            </span>
          </Reveal>
          <Reveal delay={0.06}>
            <h1 id="hero-title">
              让想法，
              <br />
              <span>在对话里发生。</span>
            </h1>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="hero-description">
              一个轻巧、开放的 TypeScript 机器人框架。
              <br />
              从几行代码开始，让日常多一点可能。
            </p>
          </Reveal>
          <Reveal className="hero-actions" delay={0.18}>
            <a className="button button-primary" href="#start">
              开始构建 <ArrowUpRight size={16} />
            </a>
            <a className="button button-quiet" href="#playground">
              看看怎么写 <ArrowDown size={16} />
            </a>
          </Reveal>
          <Reveal className="hero-detail" delay={0.22}>
            <span>TypeScript 原生</span>
            <span className="detail-divider" />
            <span>为插件而设计</span>
            <span className="detail-divider" />
            <span>MIT 开源</span>
          </Reveal>
          <Reveal className="hero-demo" delay={0.24}>
            <Playground />
          </Reveal>
          <Reveal className="demo-caption">
            <span>代码是起点，对话是开始。</span>
            <span>
              写一点，试一下。
              <ArrowDown size={13} />
            </span>
          </Reveal>
        </section>
        <section className="stack-section container" aria-label="技术栈">
          <Reveal className="stack-row">
            <p>
              基于熟悉的工具，
              <br />
              做一点不一样的事。
            </p>
            <div className="stack-items">
              <span className="stack-item typescript">
                <span>TS</span>TypeScript
              </span>
              <span className="stack-item">
                <svg viewBox="0 0 28 30" aria-hidden="true">
                  <path d="M14 2 26 9v13l-12 7L2 22V9Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
                  <text x="7" y="21" fill="currentColor" fontSize="13" fontWeight="600">
                    JS
                  </text>
                </svg>
                Node.js
              </span>
              <span className="stack-item">
                <Database size={24} strokeWidth={1.5} />
                SQLite
              </span>
              <span className="stack-item">
                <Layers3 size={25} strokeWidth={1.5} />
                OneBot 11
              </span>
            </div>
          </Reveal>
        </section>
        <section className="approach-section container" id="approach" aria-labelledby="approach-title">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow">01 / LESS FRICTION, MORE IDEAS</span>
              <h2 id="approach-title">
                小小的核心。
                <br />
                <span>刚刚好的能力。</span>
              </h2>
            </div>
            <p>
              从一句问候，到整个群聊的日常。
              <br />
              AsaBot 处理通用的事，
              <br />
              为你的想法留出更多空间。
            </p>
          </Reveal>
          <div className="principles">
            <Reveal className="principle">
              <div className="principle-visual command-visual" aria-hidden="true">
                <div className="command-chip">
                  <span>/</span> hello <span className="visual-selection">世界</span>
                  <span className="visual-caret" />
                </div>
                <div className="command-result">
                  <ArrowDownLeft size={17} />
                  <span>你好，世界！</span>
                  <CheckCheck size={15} />
                </div>
              </div>
              <span className="feature-number">01 —</span>
              <h3>命令，自然表达。</h3>
              <p>
                声明参数与选项，连接一段逻辑。
                <br />
                命令解析、权限和帮助信息，顺手就有。
              </p>
            </Reveal>
            <Reveal className="principle" delay={0.07}>
              <div className="principle-visual protocol-visual" aria-hidden="true">
                <div className="protocol-input">
                  OneBot 11 <ArrowRight size={14} />
                </div>
                <div className="protocol-core">
                  <Mark />
                </div>
                <div className="protocol-output">
                  <span>命令</span>
                  <span>事件</span>
                  <span>消息</span>
                </div>
              </div>
              <span className="feature-number">02 —</span>
              <h3>协议，各司其职。</h3>
              <p>
                适配器处理平台差异，插件专注业务。
                <br />
                用统一的事件与消息接口，连接你的想法。
              </p>
            </Reveal>
            <Reveal className="principle" delay={0.14}>
              <div className="principle-visual reload-visual" aria-hidden="true">
                <div className="reload-file">
                  <FileCode2 size={18} />
                  <span>hello.ts</span>
                  <kbd>⌘ S</kbd>
                </div>
                <div className="reload-track">
                  <span />
                  <RefreshCw size={16} />
                  <span />
                </div>
                <div className="reload-ready">
                  <Check size={14} />
                  新想法，已就位
                </div>
              </div>
              <span className="feature-number">03 —</span>
              <h3>保存，然后继续。</h3>
              <p>
                开发模式下，插件随修改自动重载。
                <br />
                减少反复启停，让创作的节奏留在手中。
              </p>
            </Reveal>
          </div>
        </section>
        <section className="developer-section" id="developers" aria-labelledby="developer-title">
          <div className="container">
            <Reveal className="developer-heading">
              <span className="eyebrow">02 / A LITTLE CONTEXT GOES A LONG WAY</span>
              <h2 id="developer-title">插件不必从零开始。</h2>
              <p>
                配置、存储、调度与生命周期，由同一个 Context 串起来。
                <br />
                你只需要专注于，插件要做的事。
              </p>
            </Reveal>
            <Reveal>
              <Toolkit />
            </Reveal>
            <Reveal className="developer-bottom">
              <div>
                <span>
                  <Check size={14} />
                  类型提示，一路相随
                </span>
                <span>
                  <Check size={14} />
                  资源回收，交给框架
                </span>
              </div>
              <button className="text-link" type="button" onClick={() => openDocs('plugins')}>
                认识插件开发 <ArrowUpRight size={15} />
              </button>
            </Reveal>
          </div>
        </section>
        <section className="start-section container" id="start" aria-labelledby="start-title">
          <Reveal className="start-copy">
            <span className="eyebrow">03 / YOUR NEXT IDEA STARTS HERE</span>
            <h2 id="start-title">
              下一句，
              <br />
              由你来写。
            </h2>
            <p>
              给群聊添一点乐趣，为日常省一点时间。
              <br />
              或者，只是实现那个一直想试试的点子。
            </p>
            <button className="button button-primary" type="button" onClick={() => openDocs()}>
              开始你的第一个插件 <ArrowUpRight size={16} />
            </button>
            <span className="start-requirement">
              Node.js 24+ <span>/</span> pnpm <span>/</span> 一个好点子
            </span>
          </Reveal>
          <Reveal className="start-terminal" delay={0.08}>
            <div className="terminal-heading">
              <span>
                <Terminal size={16} />
                从这里开始
              </span>
              <CopyButton text={startCommands} label="复制命令" />
            </div>
            <div className="terminal-body">
              <div className="terminal-step">
                <span className="terminal-comment"># 安装依赖</span>
                <code>
                  <span>$</span> pnpm install
                </code>
              </div>
              <div className="terminal-step">
                <span className="terminal-comment"># 构建管理面板</span>
                <code>
                  <span>$</span> pnpm --filter web build
                </code>
              </div>
              <div className="terminal-step">
                <span className="terminal-comment"># 让想法开始运行</span>
                <code>
                  <span>$</span> pnpm start
                  <span className="terminal-caret" />
                </code>
              </div>
            </div>
            <div className="terminal-footer">
              <ArrowUpRight size={14} />
              <span>在项目目录执行，首次启动将引导你完成配置。</span>
            </div>
          </Reveal>
        </section>
        <div className="closing-line container">
          <Reveal>
            <span className="closing-symbol">
              <Plus size={15} strokeWidth={1} />
            </span>
            <p>认真对待每一个小想法。</p>
          </Reveal>
        </div>
      </main>
      <footer className="site-footer container">
        <div className="footer-main">
          <a className="brand" href="#top">
            <Mark />
            AsaBot
          </a>
          <span>轻巧的核心，开放的可能。</span>
          <div>
            <button type="button" onClick={() => openDocs()}>
              开发文档
            </button>
            <a href="#developers">插件开发</a>
            <a href="#start">快速开始</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            © 2026 AsaBot <span className="footer-slash">/</span> MIT License
          </span>
          <a href="#top">
            回到顶部 <ArrowUp size={13} />
          </a>
        </div>
      </footer>
      <Docs
        open={docsOpen}
        onOpenChange={setDocsOpen}
        topic={topic}
        setTopic={setTopic}
        onReturnFocus={() => {
          const target = returnFocus.current?.isConnected
            ? returnFocus.current
            : document.querySelector<HTMLButtonElement>('.nav-docs')
          target?.focus()
        }}
      />
    </>
  )
}
