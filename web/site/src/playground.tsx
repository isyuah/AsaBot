import {
  ArrowDownLeft,
  ArrowUp,
  ChevronRight,
  Code2,
  Command,
  Database,
  FileCode2,
  MessageSquare,
  Puzzle,
  Timer,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { FormEvent } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Code, CopyButton, ease, Mark, navigateTabs } from './shared.tsx'

type Example = 'hello' | 'greet' | 'coffee'
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
      '// 在 notes 插件里，用迁移管理数据表。',
      'ctx.migrate([',
      "  'CREATE TABLE p_notes_items (id INTEGER PRIMARY KEY, text TEXT)',",
      '])',
      '',
      "ctx.db.prepare('SELECT * FROM p_notes_items').all()",
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
export function Playground() {
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
          在对话中试试命令 <ArrowDownLeft size={14} />
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
              <strong>试试你的第一条命令</strong>
              <span>发送消息，看看机器人会怎样回复。</span>
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

export function Toolkit() {
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
