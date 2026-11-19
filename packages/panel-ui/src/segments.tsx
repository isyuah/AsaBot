import { Paperclip, Reply, Share2 } from 'lucide-react'
import { lazy, type ReactNode, Suspense } from 'react'
import type { Segment } from './types.ts'
import { cn } from './utils.ts'

const Markdown = lazy(() => import('./markdown.tsx').then((module) => ({ default: module.Markdown })))

const styleClasses: Record<string, string> = {
  bold: 'font-semibold',
  italic: 'italic',
  underline: 'underline',
  strike: 'line-through',
  code: 'rounded bg-surface-3/70 px-1 font-mono text-[0.92em]',
  spoiler: 'rounded bg-fg-3/60 text-transparent transition-colors hover:bg-transparent hover:text-inherit',
}

function Placeholder({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-surface-3/60 px-1.5 text-[0.92em] text-fg-2">
      {icon}
      {children}
    </span>
  )
}

/** Image sources the panel may load: remote http(s) and inline base64 (history truncates base64, so those show a placeholder). */
function imageSource(segment: Segment): string | undefined {
  const source = String(segment.data.url ?? segment.data.file ?? '')
  if (/^https?:\/\//i.test(source)) return source
  if (source.startsWith('base64://') && !/\[\d+ bytes\]$/.test(source))
    return `data:image/png;base64,${source.slice('base64://'.length)}`
  return undefined
}

/**
 * Renders the neutral message model (DESIGN §5, §24.1). `renderReply` lets a caller show the quoted message;
 * without it a reply segment shows as a small chip.
 */
export function Segments({
  message,
  renderReply,
}: {
  message: Segment[]
  renderReply?: (id: string) => ReactNode
}) {
  return (
    <>
      {message.map((segment, index) => {
        const key = `${segment.type}-${index}`
        const data = segment.data
        switch (segment.type) {
          case 'text': {
            const style = Array.isArray(data.style) ? (data.style as string[]) : []
            return (
              <span key={key} className={cn(style.map((item) => styleClasses[item]))}>
                {String(data.text)}
              </span>
            )
          }
          case 'markdown':
            return (
              <Suspense
                key={key}
                fallback={<span className="whitespace-pre-wrap">{String(data.content)}</span>}
              >
                <Markdown className="markdown-compact">{String(data.content)}</Markdown>
              </Suspense>
            )
          case 'button': {
            const label = String(data.label)
            const value = String(data.value)
            return data.kind === 'link' && /^https?:\/\//i.test(value) ? (
              <a
                key={key}
                href={value}
                target="_blank"
                rel="noopener noreferrer"
                className="mx-0.5 my-0.5 inline-flex rounded-lg border border-border bg-surface px-2.5 py-0.5 text-[0.92em] font-medium text-accent hover:border-border-strong"
              >
                {label}
              </a>
            ) : (
              <span
                key={key}
                title={value}
                className="mx-0.5 my-0.5 inline-flex rounded-lg border border-border bg-surface px-2.5 py-0.5 text-[0.92em] font-medium text-fg"
              >
                {label}
              </span>
            )
          }
          case 'at':
            return (
              <span key={key} className="mx-0.5 rounded bg-accent-soft px-1 text-accent-soft-fg">
                @{data.id === 'all' ? '全体成员' : String(data.id)}
              </span>
            )
          case 'image': {
            const src = imageSource(segment)
            return src ? (
              <img
                key={key}
                src={src}
                alt={String(data.summary ?? '图片')}
                referrerPolicy="no-referrer"
                className="my-1 block max-h-60 max-w-full rounded-lg"
              />
            ) : (
              <Placeholder key={key}>图片</Placeholder>
            )
          }
          case 'face':
            return <Placeholder key={key}>表情</Placeholder>
          case 'audio':
            return <Placeholder key={key}>语音</Placeholder>
          case 'video':
            return <Placeholder key={key}>视频</Placeholder>
          case 'file':
            return (
              <Placeholder key={key} icon={<Paperclip className="size-3" />}>
                {String(data.name ?? '文件')}
              </Placeholder>
            )
          case 'forward':
            return (
              <Placeholder key={key} icon={<Share2 className="size-3" />}>
                合并转发
              </Placeholder>
            )
          case 'reply': {
            const quote = Array.isArray(data.message)
              ? data.message
                  .map((item: Segment) => {
                    if (item.type === 'text') return String(item.data.text)
                    if (item.type === 'file') return String(item.data.name ?? '[文件]')
                    return { image: '[图片]', audio: '[语音]', video: '[视频]' }[item.type] ?? ''
                  })
                  .join('')
              : ''
            const preview = quote || (typeof data.title === 'string' ? data.title : '')
            return (
              <span key={key} className="mb-1 block">
                {renderReply ? (
                  renderReply(String(data.id))
                ) : (
                  <Placeholder icon={<Reply className="size-3 shrink-0" />}>
                    <span className="line-clamp-2 break-all">{preview || '回复'}</span>
                  </Placeholder>
                )}
              </span>
            )
          }
          default:
            return <Placeholder key={key}>{segment.type}</Placeholder>
        }
      })}
    </>
  )
}
