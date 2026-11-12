/** 文本段可使用的样式名称。 */
export type TextStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler'

/** 框架定义的中立消息段联合类型。 */
export type KnownSegment =
  | { type: 'text'; data: { text: string; style?: TextStyle[] } }
  | { type: 'markdown'; data: { content: string } }
  | { type: 'button'; data: { label: string; kind: 'link' | 'command'; value: string } }
  | { type: 'at'; data: { id: string } }
  | { type: 'face'; data: { id: string } }
  | { type: 'image'; data: { file: string; url?: string; summary?: string } }
  | { type: 'audio'; data: { file: string; url?: string } }
  | { type: 'video'; data: { file: string; url?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'file'; data: { file: string; name?: string } }
  | { type: 'forward'; data: { id: string } }

/** 平台专属或未知类型的消息段；平台专属类型使用平台名前缀。 */
export type UnknownSegment = { type: string; data: Record<string, unknown> }
/** 中立或平台专属的单个消息段。 */
export type Segment = KnownSegment | UnknownSegment

/** 按顺序排列的消息段列表。 */
export type Message = Segment[]
/** 可发送的纯文本、单个消息段或消息段列表。 */
export type Sendable = string | Segment | Segment[]
