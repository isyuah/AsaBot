import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from './utils.ts'

const external = /^(?:https?:|mailto:)/i

function MissingImage({ alt }: { alt?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-fg-3">
      <ImageOff className="size-3.5" />
      {alt || '图片'}
    </span>
  )
}

function RemoteImage({ src, alt }: { src: string; alt?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <MissingImage alt={alt} />
  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

// README content comes from third-party packages: raw HTML is dropped (skipHtml), links leave the panel
// in a new tab, and only https images are fetched.
const components: Components = {
  a: ({ node: _node, href, children }) =>
    href && external.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ node: _node, src, alt }) =>
    typeof src === 'string' && src.startsWith('https://') ? (
      <RemoteImage src={src} alt={alt} />
    ) : (
      <MissingImage alt={alt} />
    ),
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  )
}
