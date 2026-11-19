import { type Message, type Segment, seg } from '../../core/message/index.ts'
import { mediaName, type WeixinMedia } from './media.ts'
import type { Item } from './protocol.ts'

const maxRecent = 512

export class WeixinMessages {
  private readonly recent = new Map<string, Message>()
  private readonly media: WeixinMedia

  constructor(media: WeixinMedia) {
    this.media = media
  }

  incoming(userId: string, messageId: string, items: Item[]): Message {
    const message: Message = []
    const body: Message = []
    const quotes = new Set<string>()
    for (const [index, item] of items.entries()) {
      const ref = item.ref_msg
      if (ref) {
        const id = ref.svr_id ?? ref.message_item?.msg_id ?? `${messageId}:quote:${index}`
        if (!quotes.has(id)) {
          const inline = ref.message_item && this.content(ref.message_item)
          const quoted = inline?.length ? inline : this.recent.get(this.key(userId, id))
          message.push({
            type: 'reply',
            data: { id, ...(ref.title && { title: ref.title }), ...(quoted && { message: quoted }) },
          })
          quotes.add(id)
        }
      }
      const content = this.content(item)
      if (item.msg_id && item.msg_id !== messageId) this.remember(userId, item.msg_id, content)
      message.push(...content)
      body.push(...content)
    }
    this.remember(userId, messageId, body)
    return message
  }

  remember(userId: string, id: string, message: Message): void {
    if (!message.length) return
    const key = this.key(userId, id)
    this.recent.delete(key)
    this.recent.set(key, message.slice(0, 16))
    const first = this.recent.keys().next()
    if (this.recent.size > maxRecent && !first.done) this.recent.delete(first.value)
  }

  private key(userId: string, id: string): string {
    return JSON.stringify([userId, id])
  }

  private content(item: Item): Message {
    const single = (segment: Segment | undefined): Message => (segment ? [segment] : [])
    switch (item.type) {
      case 1:
        return item.text_item?.text ? [seg.text(item.text_item.text)] : []
      case 2:
        return item.image_item?.media
          ? single(this.media.remember('image', item.image_item.media, undefined, item.image_item.aeskey))
          : []
      case 3: {
        const message: Message = []
        const voice = item.voice_item
        const audio = voice?.media && this.media.remember('audio', voice.media)
        if (audio) message.push(audio)
        if (voice?.text) message.push(seg.text(voice.text))
        return message
      }
      case 4:
        return item.file_item?.media
          ? single(this.media.remember('file', item.file_item.media, mediaName(item.file_item.file_name)))
          : []
      case 5:
        return item.video_item?.media ? single(this.media.remember('video', item.video_item.media)) : []
      default:
        return []
    }
  }
}
