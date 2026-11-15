# 飞书接入

适配器面向国内飞书的企业自建应用，使用官方 `@larksuiteoapi/node-sdk` 长连接，无需公网回调地址。机器人和用户使用 `open_id`，群使用 `chat_id`；不同应用的 open_id 不能混用。

## 配置

```yaml
adapters:
  feishu:
    accounts:
      - appId: ${FEISHU_APP_ID}
        appSecret: ${FEISHU_APP_SECRET}
    apiTimeout: 30s
    mediaMaxBytes: 20971520
    dedupCapacity: 10000
    dedupTtl: 10m
```

在 `.env` 或运行环境设置凭据。可添加多个账号，App ID 不能重复；移除账号关闭对应连接，更新凭据重建对应连接，其他账号保持运行。面板遮蔽 App Secret。

## 开放平台设置

1. 在飞书开发者后台创建企业自建应用，启用机器人能力、配置应用可用范围。
2. 添加所需权限并发布版本，按企业流程完成管理员审批。
3. 启动 AsaBot，在「事件与回调」将事件、回调订阅方式均设为「使用长连接接收」。
4. 添加所需事件，把机器人加入测试群；先验证私聊与群内 @机器人。

| 能力 | 权限 / 事件 |
| --- | --- |
| 发送消息 | `im:message:send_as_bot` |
| 接收私聊 | `im:message.p2p_msg:readonly`；`im.message.receive_v1` |
| 接收群内 @机器人 | `im:message.group_at_msg:readonly`；`im.message.receive_v1` |
| 接收全部群消息 | 按需申请敏感权限 `im:message.group_msg`，不需要时省略 |
| 上传与下载资源 | `im:resource` |
| 群信息与群角色 | `im:chat:read` |
| 成员列表 | `im:chat.members:read` |
| 用户进退群 | `im.chat.member.user.added_v1`、`im.chat.member.user.deleted_v1` |
| 机器人进退群 | `im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1` |
| 撤回通知 | `im.message.recalled_v1`；读取消息、撤回自身消息需开通后台对应的消息操作权限 |

群角色从群信息读取并缓存 30 秒；读取失败会记日志，事件不附加管理权限。框架 ACL、按群插件开关和命令权限照常生效。

## 消息与 API

通用 `bot.sendPrivate` / `bot.sendGroup` 支持文本、提及、引用、图片和文件。富文本接收保留顺序、样式、链接及图片。混合消息拆分时按原顺序发送，逐条派发 `bot.message.sent`，返回最后一个消息 ID。

```ts
import { seg } from '@asabot/core'
import { isFeishu } from '@asabot/core/feishu'

ctx.on('message', async (session) => {
  if (!isFeishu(session.bot)) return
  await session.reply([seg.text('已收到'), seg.image('img_example')])
  // const bytes = await session.bot.feishu.downloadResource(messageId, key, 'image')
})
```

媒体支持 Buffer、base64、HTTP(S)、file URL 及当前应用可访问的资源 key。上传、下载均有超时和大小限制，图片另限制 10 MiB、文件 30 MiB；适配器关闭时中止传输。

群列表、成员、消息查询及撤回已接入。合并转发、禁言、踢人、群名片及好友列表抛 `UnsupportedError`。其他 API 可用 `bot.call('GET /im/v1/chats', { params: { user_id_type: 'open_id' } })`，路径不含 `/open-apis` 前缀，参数与响应保持飞书格式。

事件按 event_id 在进程内有界 TTL 去重，重启后缓存重新建立。成员事件映射为通用通知，机器人进退群分别为 `notice.feishu.bot.added` / `notice.feishu.bot.removed`。撤回已缓存接收消息时映射为 `notice.message.recall`，发送者未知时保留原始 `notice.feishu.message.recall`。

## 联调

- 私聊命令、群内 @命令；核对身份、toMe 与引用回复。
- 文字、图片、文件、富文本、混合消息及逐条发送记录。
- ACL 屏蔽、按群关闭插件、普通用户与群管理权限。
- 网络断开后的重连状态、恢复上线、多账号移除和凭据更新。
- 日志与面板不出现 App Secret、Authorization。

仓库测试使用模拟 SDK 边界，不访问真实飞书；真实权限审批、应用可用范围和租户网络按上述步骤联调。

官方参考：[事件处理](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events)、[回调处理](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)。
