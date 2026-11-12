import { marked, type Token, type Tokens } from 'marked'
import type { RenderNode } from './index.ts'

type Child = RenderNode | string
type Style = Record<string, string | number>

const palettes = {
  light: {
    background: '#ffffff',
    text: '#20242c',
    muted: '#667085',
    border: '#d0d5dd',
    code: '#f2f4f7',
    link: '#175cd3',
  },
  dark: {
    background: '#161b22',
    text: '#e6edf3',
    muted: '#9da7b3',
    border: '#495260',
    code: '#252d38',
    link: '#79b8ff',
  },
}
type Palette = (typeof palettes)[keyof typeof palettes]

function node(type: string, style: Style, children: Child | Child[]): RenderNode {
  return { type, props: { style, children } }
}

function inline(tokens: Token[], colors: Palette): Child[] {
  return tokens.flatMap((token): Child[] => {
    if (token.type === 'br') return ['\n']
    if (token.type === 'strong' || token.type === 'em' || token.type === 'del' || token.type === 'link') {
      const part = token as Tokens.Strong | Tokens.Em | Tokens.Del | Tokens.Link
      const style: Style = { display: 'flex' }
      if (token.type === 'strong') style.fontWeight = 700
      if (token.type === 'em') style.fontStyle = 'italic'
      if (token.type === 'del') style.textDecoration = 'line-through'
      if (token.type === 'link') style.color = colors.link
      return [node('span', style, inline(part.tokens, colors))]
    }
    if (token.type === 'codespan') {
      return [
        node(
          'span',
          { display: 'flex', backgroundColor: colors.code, borderRadius: 4, padding: '0 4px' },
          (token as Tokens.Codespan).text,
        ),
      ]
    }
    if ('tokens' in token && Array.isArray(token.tokens)) return inline(token.tokens, colors)
    return ['text' in token && typeof token.text === 'string' ? token.text : token.raw]
  })
}

function textBlock(tokens: Token[], colors: Palette, style: Style = {}): RenderNode {
  return node(
    'div',
    { display: 'flex', flexWrap: 'wrap', whiteSpace: 'pre-wrap', ...style },
    inline(tokens, colors),
  )
}

function blocks(tokens: Token[], colors: Palette): RenderNode[] {
  return tokens.flatMap((token): RenderNode[] => {
    switch (token.type) {
      case 'space':
      case 'def':
        return []
      case 'heading': {
        const heading = token as Tokens.Heading
        return [
          textBlock(heading.tokens, colors, {
            fontWeight: 700,
            fontSize: Math.max(22, 36 - heading.depth * 3),
            marginBottom: 14,
          }),
        ]
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph
        return [textBlock(paragraph.tokens, colors, { marginBottom: 14, lineHeight: 1.6 })]
      }
      case 'text': {
        const text = token as Tokens.Text
        return [textBlock(text.tokens ?? [text], colors, { lineHeight: 1.6 })]
      }
      case 'code':
        return [
          node(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              whiteSpace: 'pre-wrap',
              backgroundColor: colors.code,
              padding: 14,
              borderRadius: 6,
              marginBottom: 14,
              fontSize: 16,
            },
            (token as Tokens.Code).text,
          ),
        ]
      case 'blockquote':
        return [
          node(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              borderLeft: `4px solid ${colors.border}`,
              paddingLeft: 14,
              color: colors.muted,
              marginBottom: 14,
            },
            blocks((token as Tokens.Blockquote).tokens, colors),
          ),
        ]
      case 'list': {
        const list = token as Tokens.List
        const start = typeof list.start === 'number' ? list.start : 1
        return [
          node(
            'div',
            { display: 'flex', flexDirection: 'column', marginBottom: 14, paddingLeft: 8 },
            list.items.map((item, index) =>
              node('div', { display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }, [
                node(
                  'div',
                  { display: 'flex', width: 30, flexShrink: 0 },
                  list.ordered ? `${start + index}.` : '•',
                ),
                node(
                  'div',
                  { display: 'flex', flexDirection: 'column', flexGrow: 1 },
                  blocks(item.tokens, colors),
                ),
              ]),
            ),
          ),
        ]
      }
      case 'hr':
        return [
          node(
            'div',
            { display: 'flex', height: 1, backgroundColor: colors.border, marginBottom: 14, marginTop: 4 },
            '',
          ),
        ]
      case 'table': {
        const table = token as Tokens.Table
        return [
          node(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              marginBottom: 14,
              border: `1px solid ${colors.border}`,
            },
            [table.header, ...table.rows].map((row, index) =>
              node(
                'div',
                { display: 'flex', flexDirection: 'row' },
                row.map((cell) =>
                  textBlock(cell.tokens, colors, {
                    flex: 1,
                    padding: 8,
                    fontWeight: index === 0 ? 700 : 400,
                    border: `1px solid ${colors.border}`,
                  }),
                ),
              ),
            ),
          ),
        ]
      }
      default:
        return [
          node(
            'div',
            { display: 'flex', flexDirection: 'column', whiteSpace: 'pre-wrap' },
            'text' in token && typeof token.text === 'string' ? token.text : token.raw,
          ),
        ]
    }
  })
}

export function markdownNode(markdown: string, theme: 'light' | 'dark'): RenderNode {
  const colors = palettes[theme]
  return node(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      boxSizing: 'border-box',
      padding: 32,
      backgroundColor: colors.background,
      color: colors.text,
      fontSize: 20,
    },
    blocks(marked.lexer(markdown), colors),
  )
}

export function textNode(text: string, theme: 'light' | 'dark'): RenderNode {
  const colors = palettes[theme]
  return node(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      boxSizing: 'border-box',
      padding: 32,
      backgroundColor: colors.background,
      color: colors.text,
      fontSize: 20,
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
    },
    text,
  )
}
