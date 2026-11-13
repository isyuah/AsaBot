import {
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCheck,
  Code2,
  Database,
  FileCode2,
  Layers3,
  Menu,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
  Terminal,
  TestTube2,
  X,
} from 'lucide-react'
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'motion/react'
import { useState } from 'react'
import { Playground, Toolkit } from './playground.tsx'
import { Link } from './router.tsx'
import { CopyButton, Mark, Reveal } from './shared.tsx'

const startCommands = ['npm create @asabot@latest', 'cd asabot-bot', 'npm install', 'npm run dev'].join('\n')
const management = [
  {
    icon: PackageOpen,
    title: '插件与配置',
    text: '搜索 npm 插件，安装、升级，再按需要调整配置。',
    href: '/docs/plugin-management',
    tag: 'PLUGINS',
  },
  {
    icon: ShieldCheck,
    title: '权限与范围',
    text: '管理访问控制与群开关，让每个功能出现在合适的地方。',
    href: '/docs/plugin-management#管理命令与访问控制',
    tag: 'CONTROL',
  },
  {
    icon: TestTube2,
    title: '调试与测试',
    text: '在虚拟适配器中验证消息，用测试保留预期的行为。',
    href: '/docs/testing',
    tag: 'DEVELOPER TOOLS',
  },
  {
    icon: Database,
    title: '消息与数据',
    text: '查询消息历史，使用独立存储，让日常有迹可循。',
    href: '/docs/services',
    tag: 'HISTORY & STORAGE',
  },
]

export function Site() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const { scrollY } = useScroll()
  useMotionValueEvent(scrollY, 'change', (value) => setScrolled(value > 20))
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
            <a href="#approach">框架能力</a>
            <a href="#developers">插件开发</a>
            <Link href="/docs/introduction">开发文档</Link>
          </div>
          <Link className="nav-docs" href="/docs/quickstart">
            开始使用 <ArrowUpRight size={15} />
          </Link>
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
                框架能力 <ArrowUpRight size={16} />
              </a>
              <a href="#developers" onClickCapture={() => setMenuOpen(false)}>
                插件开发 <ArrowUpRight size={16} />
              </a>
              <Link href="/docs/introduction" onClick={() => setMenuOpen(false)}>
                开发文档 <ArrowUpRight size={16} />
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </header>
      <main id="main" className="site-main" tabIndex={-1}>
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
              用 TypeScript 编写插件，连接聊天平台。
              <br />
              命令、多轮对话与管理面板，都已经准备好。
            </p>
          </Reveal>
          <Reveal className="hero-actions" delay={0.18}>
            <Link className="button button-primary" href="/docs/quickstart">
              创建你的机器人 <ArrowUpRight size={17} />
            </Link>
            <a className="button button-quiet" href="#playground">
              先看一段代码 <ArrowDown size={16} />
            </a>
          </Reveal>
          <Reveal className="hero-detail" delay={0.22}>
            <span>TypeScript 原生</span>
            <span>OneBot 11</span>
            <span>MIT 开源</span>
          </Reveal>
          <Reveal className="hero-demo" delay={0.24}>
            <Playground />
          </Reveal>
          <Reveal className="demo-caption">
            <span>
              <Code2 size={14} /> 一个文件，一个新能力。
            </span>
            <span>
              试试切换示例，再发送一条命令。
              <ArrowDown size={13} />
            </span>
          </Reveal>
        </section>
        <section className="approach-section container" id="approach" aria-labelledby="approach-title">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow">01 / BUILT FOR CONVERSATION</span>
              <h2 id="approach-title">
                从一个命令，
                <br />
                <span>到一整套日常。</span>
              </h2>
            </div>
            <p>
              把通用的工作交给框架。
              <br />
              用熟悉的 TypeScript，
              <br />
              写下你真正想实现的部分。
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
              <span className="feature-number">01 — COMMANDS</span>
              <h3>好好说话，简单写法。</h3>
              <p>参数、选项、权限与冷却，在一条声明里完成。帮助信息随命令一起准备好。</p>
              <Link className="text-link" href="/docs/commands">
                了解命令系统 <ArrowUpRight size={14} />
              </Link>
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
              <span className="feature-number">02 — ADAPTERS</span>
              <h3>平台不同，写法如一。</h3>
              <p>适配器处理平台差异，统一事件与消息段。多账号接入，插件依然专注业务。</p>
              <Link className="text-link" href="/docs/connections">
                连接聊天平台 <ArrowUpRight size={14} />
              </Link>
            </Reveal>
            <Reveal className="principle" delay={0.14}>
              <div className="principle-visual reload-visual" aria-hidden="true">
                <div className="reload-file">
                  <FileCode2 size={18} />
                  <span>hello.ts</span>
                  <kbd>Save</kbd>
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
              <span className="feature-number">03 — WORKFLOW</span>
              <h3>保存，然后继续。</h3>
              <p>开发时自动重载插件，卸载时回收资源。少一点反复启停，留住创造的节奏。</p>
              <Link className="text-link" href="/docs/first-plugin">
                编写第一个插件 <ArrowUpRight size={14} />
              </Link>
            </Reveal>
          </div>
        </section>
        <section className="developer-section" id="developers" aria-labelledby="developer-title">
          <div className="container">
            <Reveal className="developer-heading">
              <span className="eyebrow">02 / ROOM TO BUILD</span>
              <h2 id="developer-title">
                一份 Context，<span>许多种可能。</span>
              </h2>
              <p>
                存储、调度、服务与生命周期，都有顺手的入口。
                <br />
                从一个小功能开始，让插件自然长大。
              </p>
            </Reveal>
            <Reveal>
              <Toolkit />
            </Reveal>
            <Reveal className="developer-bottom">
              <div>
                <span>
                  <Check size={15} />
                  类型提示，一路相随
                </span>
                <span>
                  <Check size={15} />
                  资源回收，交给框架
                </span>
              </div>
              <Link className="text-link" href="/docs/context">
                查阅 Context API <ArrowUpRight size={15} />
              </Link>
            </Reveal>
          </div>
        </section>
        <section className="management-section container" aria-labelledby="management-title">
          <Reveal className="management-heading">
            <span className="eyebrow">03 / BEYOND THE CODE</span>
            <h2 id="management-title">
              写得顺手，
              <br />
              <span>也管得从容。</span>
            </h2>
            <p>
              从插件安装到日常维护，
              <br />
              内置面板照顾代码之外的工作。
            </p>
            <Link className="text-link" href="/docs/http-api">
              认识管理面板 <ArrowUpRight size={15} />
            </Link>
            <div className="management-signature">
              <Layers3 size={17} />
              <span>ONE FRAMEWORK. YOUR WORKFLOW.</span>
            </div>
          </Reveal>
          <div className="management-features">
            {management.map((item, index) => {
              const Icon = item.icon
              return (
                <Reveal key={item.title} delay={index * 0.04}>
                  <Link href={item.href} className="management-feature">
                    <span className="management-icon">
                      <Icon size={22} strokeWidth={1.6} />
                    </span>
                    <span>
                      <small>{item.tag}</small>
                      <h3>{item.title}</h3>
                      <p>{item.text}</p>
                    </span>
                    <ArrowUpRight size={18} />
                  </Link>
                </Reveal>
              )
            })}
          </div>
        </section>
        <section className="start-section container" id="start" aria-labelledby="start-title">
          <Reveal className="start-copy">
            <span className="eyebrow">04 / MAKE IT YOURS</span>
            <h2 id="start-title">
              下一句，
              <br />
              <span>由你来写。</span>
            </h2>
            <p>
              给群聊添一点乐趣，为日常省一点时间。
              <br />
              从创建项目开始，把那个点子变成现实。
            </p>
            <Link className="button button-primary" href="/docs/quickstart">
              跟随入门指南 <ArrowUpRight size={17} />
            </Link>
            <span className="start-requirement">
              Node.js 24+ <span>/</span> npm <span>/</span> TypeScript
            </span>
          </Reveal>
          <Reveal className="start-terminal" delay={0.08}>
            <div className="terminal-heading">
              <span>
                <Terminal size={17} />
                创建 AsaBot 项目
              </span>
              <CopyButton text={startCommands} label="复制命令" />
            </div>
            <div className="terminal-body">
              <div className="terminal-step">
                <span className="terminal-comment">01 / 创建机器人项目</span>
                <code>
                  <span>$</span> npm create @asabot@latest
                </code>
              </div>
              <div className="terminal-step">
                <span className="terminal-comment">02 / 进入项目，安装依赖</span>
                <code>
                  <span>$</span> cd asabot-bot
                </code>
                <code>
                  <span>$</span> npm install
                </code>
              </div>
              <div className="terminal-step">
                <span className="terminal-comment">03 / 开始开发</span>
                <code>
                  <span>$</span> npm run dev
                  <span className="terminal-caret" />
                </code>
              </div>
            </div>
            <div className="terminal-footer">
              <ArrowUpRight size={15} />
              <span>首次启动后，跟随面板向导完成设置。</span>
            </div>
          </Reveal>
        </section>
      </main>
      <footer className="site-footer container">
        <div className="footer-main">
          <a className="brand" href="#top">
            <Mark />
            AsaBot
          </a>
          <span>认真对待每一个小想法。</span>
          <nav aria-label="页脚导航">
            <Link href="/docs/introduction">文档</Link>
            <Link href="/docs/first-plugin">插件开发</Link>
            <Link href="/docs/deployment">部署指南</Link>
          </nav>
        </div>
        <div className="footer-bottom">
          <span>
            © 2026 AsaBot <span className="footer-slash">/</span> MIT License
          </span>
          <a href="#top">
            回到顶部 <ArrowUp size={14} />
          </a>
        </div>
      </footer>
    </>
  )
}
