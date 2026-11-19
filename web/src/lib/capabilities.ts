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
  sendThread: '话题内发送',
}

const platformLabels: Record<string, string> = {
  'feishu:card': '飞书卡片',
  'feishu:emoji': '飞书表情',
  'feishu:sticker': '飞书表情包',
  'feishu:share_chat': '分享群名片',
  'feishu:share_user': '分享个人名片',
  'feishu.sendCard': '发送飞书卡片',
  'feishu.updateCard': '更新飞书卡片',
  'feishu.downloadResource': '下载消息资源',
  'feishu.replyInThread': '开话题回复',
  'feishu.listMessages': '会话与话题历史',
  'feishu.forwardMessage': '转发消息',
  'feishu.forwardThread': '转发话题',
  'feishu.mergeForward': '合并转发已有消息',
  'feishu.editMessage': '编辑文本消息',
  'feishu.addReaction': '添加表情回复',
  'feishu.removeReaction': '撤销表情回复',
  'feishu.listReactions': '查询表情回复',
  'feishu.pinMessage': '标记群消息',
  'feishu.unpinMessage': '取消标记群消息',
  'feishu.listPins': '查询群消息标记',
  'feishu.listReadUsers': '查询消息已读成员',
  'feishu.getChat': '查询会话信息',
  'feishu.setChatMessageMode': '切换群消息模式',
  'feishu.addChatMembers': '添加群成员',
  'feishu.urgentApp': '应用内加急',
  'wecom:card': '企业微信模板卡片',
  'wecom.reply': '回复原消息',
  'wecom.downloadMedia': '下载并解密媒体',
  'wecom.stream.update': '更新流式回复',
  'wecom.stream.finish': '结束流式回复',
  'wecom.replyWelcome': '回复欢迎语',
  'wecom.updateCard': '更新模板卡片',
  'weixin-clawbot.downloadMedia': '下载并解密媒体',
  'weixin-clawbot.setTyping': '设置或取消正在输入',
}

export interface CapabilityRow {
  key: string
  label: string
  supported: boolean
}

/** 通用能力显示支持状态，平台专属能力只在实现它的适配器中显示。 */
function rows(labels: Record<string, string>, supported: readonly string[]): CapabilityRow[] {
  const set = new Set(supported)
  const known = Object.entries(labels).map(([key, label]) => ({ key, label, supported: set.has(key) }))
  const extra = supported
    .filter((key) => !(key in labels))
    .map((key) => ({
      key,
      label: platformLabels[key] ?? (key.endsWith(':*') ? `${key.slice(0, -2)} 专属段` : key),
      supported: true,
    }))
  return [...known, ...extra]
}

export function capabilityRows(capabilities: BotCapabilities) {
  return {
    segments: rows(segmentLabels, capabilities.segments),
    styles: rows(styleLabels, capabilities.textStyles),
    actions: rows(actionLabels, capabilities.actions),
  }
}
