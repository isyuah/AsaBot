export type Segment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'face'; data: { id: string } }
  | { type: 'image'; data: { file: string; url?: string; summary?: string; subType?: number } }
  | { type: 'record'; data: { file: string; url?: string } }
  | { type: 'video'; data: { file: string; url?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'file'; data: { file: string; name?: string } }
  | { type: 'json'; data: { data: string } }
  | { type: 'forward'; data: { id: string } }
  | { type: string; data: Record<string, unknown> }

export type Message = Segment[]
export type Sendable = string | Segment | Segment[]
