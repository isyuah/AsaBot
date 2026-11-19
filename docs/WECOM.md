# 企业微信接入

AsaBot 内置 `wecom` 适配器，使用企业微信 **智能机器人 → API 模式 → 长连接**，由官方 Node SDK 连接 `wss://openws.work.weixin.qq.com`。它不需要公网回调地址，也不需要自建应用的 CorpID、AgentID、回调 Token 或 EncodingAESKey。仅接入普通私聊和群机器人消息；智能助理、频道和微信客服使用其他接口。

## 创建与配置

1. 在企业微信客户端的「工作台 → 智能机器人」创建机器人，选择「API 模式 → 长连接」，复制 **BotID** 和 **Secret**，设置机器人可用范围。
2. 在 AsaBot 面板「机器人 → 连接 → 添加连接」选择「企业微信」，填写 BotID 和 Secret。也可以添加以下 YAML 配置，并在 `.env` 或运行环境设置对应变量：

   ```yaml
   connections:
     - id: wecom-main
       name: 企业微信主机器人
       adapter: wecom
       enabled: true
       config:
         botId: ${WECOM_BOT_ID}
         secret: ${WECOM_BOT_SECRET}
         botName: 研发助手
   ```

3. 等面板显示「在线」，在企微客户端私聊机器人发送 `/whoami`，再把机器人加入测试群，发送 `@研发助手 /help`。命令前缀按 AsaBot 项目配置为准。

`botName` 可省略；若群回调正文保留了 `@` 前缀，填写客户端显示的准确名称（包括内部空格）。普通群回调表示机器人已被 `@`；适配器只移除正文开头与 `botName` 完全匹配的 `@名称`，保留其他人的 `@`。不填时不猜测或删除正文前缀。

一个 BotID 只建一条连接，同一时间只运行在一个 AsaBot 实例上。普通断网会退避重连；认证失败、订阅超时或被同 BotID 的另一实例接管时停在「错误」。核对凭据、网络或停掉另一实例后，在面板手动重连。面板遮蔽 Secret；生产环境建议使用环境变量引用。

## 管理员与主动推送

- 以 `/whoami` 返回的 **用户 ID** 配置「机器人 → 对应机器人 → 设置」的机器人管理员；框架管理员使用 `{ platform: wecom, selfId: BotID, userId: 用户ID }`。`from.userid` 可能由企微加密，原样使用，不要换成微信号或昵称。
- 定时任务或插件可保存 `session.target`，再用 `ctx.send(target, content)` 主动推送。目标字符串为 `wecom:<BotID>:private:<userid>` 或 `wecom:<BotID>:group:<chatid>`；多账号时务必填 BotID。群 ID 取自 `session.groupId`。
- 主动发送前，该用户或群须先给**当前机器人**发消息（群内 `@`），推送资格由企微判定。回复和主动发送共享每会话 **30 条/分钟、1000 条/小时**的额度，分段分别计数。

## 消息和附件

| 用途 | 接口与行为 |
| --- | --- |
| 回复当前消息 | `session.reply(content)` 用原回调的 `req_id`，回复窗口为 24 小时；过期或被拒绝时返回错误，不切换到主动发送。 |
| 主动发送 | `session.send(content)`、`session.reply(content, { quote: false })`、`bot.sendPrivate`、`bot.sendGroup`，明确区分私聊和群聊。 |
| 文本、Markdown、卡片 | 纯文本用 Markdown 通道发送并转义语法；需要格式用 `seg.markdown()`。出站 `at` 降级为 `@用户ID` 文本。模板卡片使用 `wecom.card()`。 |
| 入站附件与引用 | 文本、图文混排、图片、文件、视频和语音转写。引用以 `reply` 段附带内容快照；企微不提供被引用消息的 ID，`wecom-quote:` ID 仅供本地记录。 |
| 下载原始附件 | `bot.wecom.downloadMedia(segment.data.file)` 返回解密后的 `Buffer`。入站句柄仅该机器人可用，最多 5 分钟；仅从公网 HTTPS 下载，不跟随重定向，超时 30 秒，解密后最大 20 MiB。 |
| 上传并发送 | `seg.image`：PNG/JPEG/GIF，10 MiB；`seg.video`：MP4，10 MiB；`seg.audio`：AMR，2 MiB；`seg.file`：20 MiB。最少 5 字节，不转码。来源支持 `Buffer`、绝对路径、HTTP(S) URL 或同账号的有效入站句柄。 |

通用发送经过发送前钩子；长消息分段保留原发送通道。文本和 Markdown 单帧上限为 20480 字节，混合媒体按顺序拆为多条平台消息。平台回执若无消息 ID，会返回 `wecom-local:` 开头的本地追踪 ID。媒体地址、解密密钥和原始回调不会进入消息记录或面板。企微长连接不提供远端历史、消息撤回、通讯录或群管理接口。

## 插件示例

```ts
import { definePlugin, isSegment } from '@asabot/core'
import { isWecomBot, isWecomCardAction, isWecomEnterChat, isWecomFeedback, isWecomSession, wecom } from '@asabot/core/wecom'

export default definePlugin({
  name: 'wecom-demo',
  setup(ctx) {
    ctx.command('progress').action(async ({ session }) => {
      if (!isWecomSession(session)) return
      const stream = session.wecom.createStream({ feedbackId: `progress-${session.id}` })
      await stream.update('正在处理…')
      await stream.finish('**处理完成**')
    })

    ctx.command('wecom-card').action(async ({ session }) => {
      if (!isWecomSession(session)) return
      await session.reply(wecom.card({
        card_type: 'button_interaction',
        main_title: { title: '任务确认' },
        button_list: [{ text: '确认', key: 'confirm', style: 1 }],
      }))
    })

    ctx.on('notice.wecom.enter_chat', async (event) => {
      if (isWecomEnterChat(event)) await event.replyWelcome('你好，可以发送 /help 查看命令。')
    })
    ctx.on('notice.wecom.card.action', async (event) => {
      if (!isWecomCardAction(event) || event.eventKey !== 'confirm') return
      await event.updateCard({
        card_type: 'button_interaction',
        main_title: { title: '已确认' },
        button_list: [{ text: '确认', key: 'confirm', style: 1 }],
      })
    })
    ctx.on('notice.wecom.feedback', (event) => {
      if (isWecomFeedback(event)) ctx.logger.info({ id: event.feedbackId, type: event.feedbackType }, '收到反馈')
    })

    ctx.on('message.private', async (session) => {
      if (!isWecomBot(session.bot)) return
      const file = session.message.find((item) => isSegment(item, 'file'))
      if (file) {
        const bytes = await session.bot.wecom.downloadMedia(file.data.file)
        await session.reply(`收到 ${bytes.length} 字节`)
      }
    })
  },
})
```

- 流式 `update()` 和 `finish()` 提交的是**完整内容**，不是增量。等待上一帧回执后再提交下一帧；从第一帧起 10 分钟内结束。仅在成功结束时写一条出站记录。长连接不支持流式图文混排、流式和模板卡片组合。
- 欢迎语支持文本或模板卡片，在 `enter_chat` 回调后 5 秒内发送一次。卡片更新也须在点击后 5 秒内完成一次，沿用原 `task_id`。交互卡片发出时未指定 `task_id` 会生成一个；点击只派发事件，不自动执行命令。
- `feedbackId` 或卡片的 `feedback.id` 是业务关联 ID。反馈事件包含准确（1）、不准确（2）、取消（3）和可用的文字、原因字段。收到卡片点击后，插件可从 `selectedItems` 读取投票和选择器结果。

## 官方接口

- [长连接接入与 WebSocket 命令](https://developer.work.weixin.qq.com/document/path/101463)：`aibot_subscribe`、`ping`、`aibot_msg_callback`、`aibot_event_callback`、`aibot_respond_msg`、`aibot_send_msg` 以及分片上传的 init、chunk、finish。
- [事件字段与反馈](https://developer.work.weixin.qq.com/document/path/101027)、[回复欢迎语与更新卡片](https://developer.work.weixin.qq.com/document/path/101031)、[模板卡片字段](https://developer.work.weixin.qq.com/document/path/101032)。
- [官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)：框架使用 `@wecom/aibot-node-sdk@1.0.7` 处理订阅、心跳、网络重连、回执和媒体上传。
