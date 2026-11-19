# 微信 ClawBot 接入

`weixin-clawbot` 是 AsaBot 内置适配器，通过腾讯 [iLink HTTPS 接口](https://github.com/Tencent/openclaw-weixin/blob/c6643f6f0ac03574eb126f2d69569ea4267cc3c6/docs/protocol_zh_CN.md) 收发微信私聊。不需要安装 OpenClaw，也不需要公网回调地址；运行 AsaBot 的主机需要能访问微信 iLink 和媒体 CDN。

## 扫码绑定

1. 打开 AsaBot 面板，进入「机器人 → 连接 → 添加连接」，选择「微信 ClawBot」。
2. 用自己的手机微信扫描二维码，按手机提示确认。微信可能在确认后才显示 PIN 码；面板提示输入验证码时，填写手机上的数字并提交。二维码失效后可刷新。
3. 面板显示「已授权，待保存」后，设置连接名称和启用状态，再点击「保存连接」。退出面板或取消扫码时，未保存的授权不会创建连接。
4. 连接上线后，从手机给 Bot 发第一条消息。Bot 收到该会话的回复凭据后，才能给这位用户发送消息。

如果面板报告扫码失败，先看状态下方的原因；短暂的微信网络故障会自动重试。如果手机提示「运行环境存在风险」而面板一直等待扫码，请按微信提示处理，重复刷新二维码不会替代手机授权。

首次绑定时，微信返回的扫码用户会成为这台 Bot 的管理员，可使用如 `/bot plugin off <插件名>` 的本 Bot 管理指令。框架管理员仍在「设置」中单独管理。未识别扫码用户时，可到机器人详情手动添加管理员。其他私聊保持正常接收，仍遵循 AsaBot 的 ACL 和指令权限。

「立即重连」使用已有授权；出现「需要重新扫码」时，使用「重新扫码」更新授权。同一 Bot 续绑不会改变管理员名单。不同 Bot 必须确认替换：保留连接 ID、名称和启用状态，原 Bot 的管理员、插件设置、会话和历史不会迁移。每台 Bot 只能对应一条连接。

配置文件包含登录凭证，数据目录包含会话令牌及轮询游标。请将两者都视为私有数据，不要提交到版本库或放进公开的备份。重启会复用已保存的账号、轮询游标及会话令牌。

## 消息能力

| 内容 | 接收 | 发送 |
| --- | --- | --- |
| 文本 | 支持 | 支持，长文本分段发送 |
| 图片、视频、文件 | 支持，按需下载 | 支持，混合消息按原顺序分条发送 |
| 语音 | 原始语音和微信提供的转写；SILK 可转 WAV | 降级为文本提示 |
| 引用 | 映射为 `reply` 段；仅有 ID 时尝试从同会话的近期消息中还原 | 不发送原生引用 |
| Markdown、按钮 | — | 走框架能力降级 |

适配器不提供群聊、好友列表、撤回、原生流式气泡或工具进度消息。

## 插件 API

```ts
import { isSegment } from '@asabot/core'
import { isWeixinClawBot } from '@asabot/core/weixin-clawbot'

ctx.on('message.private', async (session) => {
  const { bot, userId, message } = session
  if (!isWeixinClawBot(bot)) return
  const audio = message.find((part) => isSegment(part, 'audio'))
  if (!audio || !isSegment(audio, 'audio')) return

  await bot.weixin.setTyping(userId, true)
  try {
    const bytes = await bot.weixin.downloadMedia(audio.data.file)
    await session.send(`收到语音（${bytes.length} 字节）`)
  } finally {
    await bot.weixin.setTyping(userId, false)
  }
})
```

`downloadMedia(file, 'wav')` 会尝试将 SILK 转为 24 kHz 单声道 PCM WAV；省略第二个参数获取原文件。消息段中的 `file` 是该 Bot 当前连接内的短期媒体标识，近期缓存淘汰或连接重建后需重新收取。需要长期保留媒体的插件应主动下载并管理文件。引用原文位于 `reply.data.message`，不会拼进 `session.text`。

出站媒体支持 `Buffer`、`base64://`、本地文件和公共 HTTP(S) 地址。单文件最多 25 MiB，媒体读取和传输设有超时；远程来源不跟随重定向，也不能访问内网地址。发送和下载都不会把微信媒体签名或加密密钥暴露给面板。
