import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FileCode2,
  Hash,
  Menu,
  Search,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Children, isValidElement, useEffect, useId, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocPage } from './docs-content.ts'
import { docGroups, docHref, docPages, slugify, tableOfContents } from './docs-content.ts'
import { Link, navigate } from './router.tsx'
import { Code, CopyButton, Mark } from './shared.tsx'
import './docs.css'

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : '',
    )
    .join('')
}

function CodeBlock({ children }: { children: ReactNode }) {
  const text = textOf(children).replace(/\n$/, '')
  const child = Children.toArray(children)[0]
  const language = isValidElement<{ className?: string }>(child)
    ? (child.props.className?.replace('language-', '') ?? 'text')
    : 'text'
  return (
    <div className="docs-code-block">
      <div className="docs-code-toolbar">
        <span>
          <FileCode2 size={14} />
          {language === 'ts' ? 'TypeScript' : language === 'sh' ? 'Terminal' : language}
        </span>
        <CopyButton text={text} />
      </div>
      {language === 'ts' || language === 'typescript' ? (
        <Code code={text} numbers={false} />
      ) : (
        <pre>{children}</pre>
      )}
    </div>
  )
}

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => (
          <h2 id={slugify(textOf(children))}>
            <a
              href={`#${slugify(textOf(children))}`}
              className="heading-anchor"
              aria-label={`跳转到${textOf(children)}`}
            >
              <Hash size={17} />
            </a>
            {children}
          </h2>
        ),
        h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => (
          <div className="docs-table-scroll">
            <table>{children}</table>
          </div>
        ),
        a: ({ href, children }) => {
          const target =
            href === 'docs/DEPLOY.md'
              ? '/docs/deployment'
              : href === 'asabot.config.example.yaml'
                ? '/docs/configuration#完整配置示例'
                : href
          return target?.startsWith('/') ? (
            <Link href={target}>{children}</Link>
          ) : (
            <a
              href={target}
              target={target?.startsWith('http') ? '_blank' : undefined}
              rel={target?.startsWith('http') ? 'noreferrer' : undefined}
            >
              {children}
            </a>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function DocsNavigation({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <nav className="docs-navigation" aria-label="文档目录">
      {docGroups.map((group) => (
        <div className="docs-nav-group" key={group}>
          <h2>{group}</h2>
          {docPages
            .filter((page) => page.group === group)
            .map((page) => (
              <Link
                key={page.slug}
                href={docHref(page)}
                aria-current={current === page.slug ? 'page' : undefined}
                onClick={onNavigate}
              >
                <span>{page.title}</span>
                {current === page.slug && <ChevronRight size={13} />}
              </Link>
            ))}
        </div>
      ))}
      <div className="docs-sidebar-note">
        <BookOpen size={15} />
        <span>从第一条命令，到你的下一个插件。</span>
      </div>
    </nav>
  )
}

function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const uid = useId()
  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length)
      return docPages.filter((page) =>
        ['quickstart', 'first-plugin', 'commands', 'context'].includes(page.slug),
      )
    return docPages
      .map((page) => {
        const haystack = (page.title + page.description + page.content + (page.appendix ?? '')).toLowerCase()
        const score = words.every((word) => haystack.includes(word))
          ? words.reduce(
              (total, word) =>
                total +
                (page.title.toLowerCase().includes(word)
                  ? 100
                  : page.description.toLowerCase().includes(word)
                    ? 20
                    : 1),
              0,
            )
          : 0
        return { page, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 7)
      .map((item) => item.page)
  }, [query])
  function select(page: DocPage) {
    setQuery('')
    setActive(0)
    onOpenChange(false)
    navigate(docHref(page))
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) {
          setQuery('')
          setActive(0)
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" />
        <Dialog.Content
          className="search-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            document.querySelector<HTMLButtonElement>('.docs-search-button')?.focus()
          }}
        >
          <Dialog.Title className="sr-only">搜索文档</Dialog.Title>
          <Dialog.Description className="sr-only">
            搜索指南、API 与代码示例，使用方向键选择，Enter 打开。
          </Dialog.Description>
          <div className="search-input-row">
            <Search size={20} />
            <input
              aria-label="搜索文档内容"
              placeholder="搜索指南、API 或一个想法…"
              value={query}
              autoComplete="off"
              role="combobox"
              aria-expanded="true"
              aria-controls={uid}
              aria-activedescendant={results[active] ? `${uid}-${results[active].slug}` : undefined}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (!results.length) return
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setActive((value) => (value + 1) % results.length)
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActive((value) => (value + results.length - 1) % results.length)
                }
                if (event.key === 'Enter' && results[active]) {
                  event.preventDefault()
                  select(results[active])
                }
              }}
            />
            <Dialog.Close className="icon-button" aria-label="关闭搜索">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="search-results-label">{query ? `${results.length} 篇相关文档` : '从这里开始'}</div>
          <div id={uid} role="listbox" aria-label="搜索结果" className="search-results">
            {results.map((page, index) => (
              <button
                type="button"
                role="option"
                aria-selected={active === index}
                key={page.slug}
                id={`${uid}-${page.slug}`}
                onPointerMove={() => setActive(index)}
                onClick={() => select(page)}
              >
                <span className="search-result-icon">
                  <FileCode2 size={18} />
                </span>
                <span>
                  <span className="search-result-group">{page.group}</span>
                  <strong>{page.title}</strong>
                  <span className="search-result-description">{page.description}</span>
                </span>
                <ArrowUpRight size={17} />
              </button>
            ))}
          </div>
          {!results.length && (
            <div className="search-empty">
              <Search size={24} />
              <strong>还没有找到相关内容</strong>
              <p>试试「命令」「存储」或「ctx.store」。</p>
            </div>
          )}
          <div className="search-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开
            </span>
            <span>
              <kbd>Esc</kbd> 关闭
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Docs({ pathname }: { pathname: string }) {
  const slug =
    pathname === '/docs' || pathname === '/docs/'
      ? 'introduction'
      : pathname.slice('/docs/'.length).replace(/\/$/, '')
  const page = docPages.find((entry) => entry.slug === slug)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')
  const toc = page ? tableOfContents(page.content) : []
  const index = docPages.findIndex((entry) => entry.slug === slug)
  const previous = docPages[index - 1]
  const next = docPages[index + 1]
  useEffect(() => {
    document.title = `${page?.title ?? '未找到文档'} — AsaBot 文档`
    if (window.location.hash) {
      document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView()
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    document.getElementById('doc-main')?.focus({ preventScroll: true })
  }, [page])
  useEffect(() => {
    function shortcut(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  useEffect(() => {
    const headings = document.getElementById(`article-${page?.slug}`)?.querySelectorAll('h2')
    if (!headings?.length) return
    setActiveHeading(headings[0]?.id ?? '')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActiveHeading(entry.target.id)
      },
      { rootMargin: '-90px 0px -65% 0px', threshold: 0 },
    )
    for (const heading of headings) observer.observe(heading)
    return () => observer.disconnect()
  }, [page?.slug])
  return (
    <div className="documentation">
      <a href="#doc-main" className="skip-link">
        跳到文档内容
      </a>
      <header className="docs-topbar">
        <div className="docs-topbar-inner">
          <Link href="/" className="brand" aria-label="AsaBot 官网">
            <Mark />
            AsaBot
          </Link>
          <span className="docs-brand-divider">/</span>
          <Link href="/docs/introduction" className="docs-brand-label">
            文档
          </Link>
          <button
            type="button"
            className="docs-search-button"
            aria-label="搜索文档"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={16} />
            <span>搜索文档…</span>
            <kbd>{navigator.userAgent.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd>
          </button>
          <Link className="docs-home-link" href="/">
            返回官网 <ArrowUpRight size={14} />
          </Link>
          <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <Dialog.Trigger className="docs-menu-button icon-button" aria-label="打开文档目录">
              <Menu size={20} />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="docs-mobile-overlay" />
              <Dialog.Content className="docs-mobile-menu">
                <div className="docs-mobile-heading">
                  <Dialog.Title>文档目录</Dialog.Title>
                  <Dialog.Close className="icon-button" aria-label="关闭文档目录">
                    <X size={19} />
                  </Dialog.Close>
                </div>
                <Dialog.Description className="sr-only">选择你想阅读的文档章节。</Dialog.Description>
                <DocsNavigation current={slug} onNavigate={() => setMenuOpen(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <DocsNavigation current={slug} />
        </aside>
        <main className="docs-main" id="doc-main" tabIndex={-1}>
          {page ? (
            <>
              <div className="docs-breadcrumb">
                <Link href="/docs/introduction">文档</Link>
                <ChevronRight size={12} />
                <span>{page.group}</span>
                <ChevronRight size={12} />
                <span>{page.title}</span>
              </div>
              <header className="docs-article-header">
                <span className="eyebrow">ASABOT DOCUMENTATION</span>
                <h1>{page.title}</h1>
                <p>{page.description}</p>
              </header>
              <article className="docs-article" id={`article-${page.slug}`}>
                <Markdown content={page.content} />
                {page.appendix && (
                  <details className="config-details">
                    <summary>展开完整 YAML 配置</summary>
                    <CodeBlock>
                      <code className="language-yaml">{page.appendix}</code>
                    </CodeBlock>
                  </details>
                )}
              </article>
              <div className="docs-article-source">
                <BookOpen size={14} />
                <span>API 与示例来自 AsaBot 仓库文档。</span>
              </div>
              <nav className="docs-pagination" aria-label="相邻文档">
                {previous ? (
                  <Link href={docHref(previous)}>
                    <ArrowLeft size={17} />
                    <span>
                      <small>上一篇</small>
                      {previous.title}
                    </span>
                  </Link>
                ) : (
                  <span />
                )}
                {next && (
                  <Link href={docHref(next)}>
                    <span>
                      <small>继续阅读</small>
                      {next.title}
                    </span>
                    <ArrowRight size={17} />
                  </Link>
                )}
              </nav>
              <footer className="docs-page-footer">
                <Link href="/">AsaBot</Link>
                <span>轻巧的核心，开放的可能。</span>
                <span>MIT License</span>
              </footer>
            </>
          ) : (
            <div className="docs-not-found">
              <span className="eyebrow">404 / DOCUMENT NOT FOUND</span>
              <h1>这篇文档还不存在。</h1>
              <p>从目录选择一个主题，或者回到入门指南。</p>
              <Link className="button button-primary" href="/docs/introduction">
                打开入门指南 <ArrowRight size={16} />
              </Link>
            </div>
          )}
        </main>
        <aside className="docs-toc" aria-label="本页目录">
          <span>本页内容</span>
          <nav>
            {toc.map((heading) => (
              <a
                key={heading.id}
                href={`#${heading.id}`}
                aria-current={activeHeading === heading.id ? 'location' : undefined}
              >
                {heading.title}
              </a>
            ))}
          </nav>
          <div className="docs-toc-note">
            有了一个新想法？
            <Link href="/docs/first-plugin">
              把它写成插件 <ArrowUpRight size={13} />
            </Link>
          </div>
        </aside>
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  )
}
