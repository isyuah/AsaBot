import type { BotCapabilities } from './types.ts'

// Display names for the neutral capability vocabulary (DESIGN §24.1). Anything not listed is shown verbatim.

export const segmentLabels: Record<string, string> = {
  text: '文本',
  at: '提及',
  face: '表情',
  image: '图片',
  audio: '语音',
  video: '视频',
  file: '文件',
  reply: '引用',
  forward: '合并转发',
  markdown: 'Markdown',
  button: '按钮',
}

export const styleLabels: Record<string, string> = {
  bold: '粗体',
  italic: '斜体',
  underline: '下划线',
  strike: '删除线',
  code: '代码',
  spoiler: '剧透',
}

export const actionLabels: Record<string, string> = {
  sendPrivate: '私聊发送',
  sendGroup: '群聊发送',
  sendForward: '发送合并转发',
  getForward: '读取合并转发',
  deleteMessage: '撤回消息',
  getMessage: '读取消息',
  getSelf: '账号信息',
  getGroupList: '群列表',
  getGroupMember: '群成员信息',
  getGroupMembers: '群成员列表',
  getFriendList: '好友列表',
  muteMember: '禁言',
  kickMember: '踢出群',
  setMemberCard: '修改群名片',
  call: '平台 API 透传',
}

export interface CapabilityRow {
  key: string
  label: string
  supported: boolean
}

/** Every known item of a vocabulary, plus extra supported items the platform declares (shown verbatim). */
function rows(labels: Record<string, string>, supported: readonly string[]): CapabilityRow[] {
  const set = new Set(supported)
  const known = Object.entries(labels).map(([key, label]) => ({ key, label, supported: set.has(key) }))
  const extra = supported
    .filter((key) => !(key in labels))
    .map((key) => ({ key, label: key.endsWith(':*') ? `${key.slice(0, -2)} 专属段` : key, supported: true }))
  return [...known, ...extra]
}

export function capabilityRows(capabilities: BotCapabilities) {
  return {
    segments: rows(segmentLabels, capabilities.segments),
    styles: rows(styleLabels, capabilities.textStyles),
    actions: rows(actionLabels, capabilities.actions),
  }
}
