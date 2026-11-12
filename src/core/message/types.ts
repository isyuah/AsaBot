export type KnownSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { id: string } }
  | { type: 'face'; data: { id: string } }
  | { type: 'image'; data: { file: string; url?: string; summary?: string } }
  | { type: 'audio'; data: { file: string; url?: string } }
  | { type: 'video'; data: { file: string; url?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'file'; data: { file: string; name?: string } }
  | { type: 'forward'; data: { id: string } }

export type UnknownSegment = { type: string; data: Record<string, unknown> }
export type Segment = KnownSegment | UnknownSegment

export type Message = Segment[]
export type Sendable = string | Segment | Segment[]
