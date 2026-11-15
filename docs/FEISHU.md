# 飞书接入

适配器面向国内飞书的企业自建应用，使用官方 `@larksuiteoapi/node-sdk` 长连接，无需公网回调地址。机器人和用户使用 `open_id`，群使用 `chat_id`；不同应用的 open_id 不能混用。

## 配置

```yaml
connections:
  - id: feishu-main
    name: 飞书主机器人
    adapter: feishu
    enabled: true
    config:
      appId: ${FEISHU_APP_ID}
      appSecret: ${FEISHU_APP_SECRET}
      apiTimeout: 30s
      mediaMaxBytes: 20971520
      dedupCapacity: 10000
      dedupTtl: 10m
```

在 `.env` 或运行环境设置凭据。也可以在面板「机器人 → 连接 → 添加连接」选择飞书。每个应用单独创建一条连接，App ID 不能重复；独立修改、停用或删除连接，其他连接保持运行。连接详情可查看登录前异常、重试时间并手动重连，App Secret 会遮蔽。成功登录后展示平台返回的机器人名称和头像。

机器人管理员在「机器人 → 对应机器人 → 设置」中填写该应用下的用户 open_id；框架管理员在「设置」中填写平台、机器人 open_id 和用户 open_id。不要把 App ID 当作机器人 ID。

可先私聊机器人发送 `/whoami`（命令前缀以项目配置为准），复制回复中的「用户 ID」到机器人管理员列表，保存后再次发送命令确认「机器人管理员：是」。该命令无需管理员权限。飞书后台的 `user_id` 与适配器使用的 `open_id` 是两种 ID；这里需要以 `ou_` 开头且属于当前应用的 `open_id`，不需要为此额外开通通讯录查询权限。

默认 `info` 级别会记录飞书连接、机器人上下线、重连和消息收发。点击面板日志行可展开 `connectionId`、`selfId`、`userId`、`eventId` 和管理员判断等字段；收到的消息只记录经过凭据脱敏、最多 200 字符的摘要。将记录级别设为 `debug` 可查看已订阅事件的类型和事件 ID，日志不包含原始事件或 SDK 凭据。

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
| 卡片交互 | 在回调订阅中添加 `card.action.trigger`，使用长连接接收；更新卡片需开通对应的消息更新权限 |

群角色从群信息读取并缓存 30 秒；读取失败会记日志，事件不附加管理权限。框架 ACL、按群插件开关和命令权限照常生效。

## 消息与 API

通用 `bot.sendPrivate` / `bot.sendGroup` 支持文本、提及、引用、图片、文件、Markdown 与按钮。Markdown 和按钮通过原生卡片发送。富文本接收保留顺序、样式、链接及图片。混合消息拆分时按原顺序发送，逐条派发 `bot.message.sent`，返回最后一个消息 ID。

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

## 卡片与完整表单

从 `@asabot/core/feishu` 导入 JSON 2.0 构造器和事件守卫，也可直接传入原生 JSON 2.0 卡片。`feishu.card(card)` 是消息段，发送时仍经过发送前钩子、能力降级与发送记录。

```ts
import { feishu, isFeishuCardAction } from '@asabot/core/feishu'

const requestCard = feishu.message([
  feishu.form('request', [
    feishu.input('reason', { placeholder: '申请原因', required: true }),
    feishu.select('priority', [
      { label: '普通', value: 'normal' },
      { label: '紧急', value: 'high' },
    ], { required: true }),
    feishu.submit('提交', 'submit_request', { action: 'create' }),
  ]),
], '提交申请')

// await session.send(feishu.card(requestCard))
ctx.on('notice.feishu.card.action', (event) => {
  if (!isFeishuCardAction(event)) return
  // formValue 保留所有字段、数组和嵌套结构，由插件用自己的 schema 校验。
  const fields = event.action.formValue
  if (fields === undefined) return
  event.respond({ toast: { type: 'success', content: '已收到' } })
  // 耗时工作交给 ctx.task；完成后调用 event.bot 的 feishu.updateCard。
})
```

`action` 同时提供 `tag/name/value/inputValue/option/options/formValue/timezone`，原始字段保留在 `action.raw`。原始表单不会被拼接为命令。平台专属通知携带点击者 open_id、群 ID 与群角色，沿用 ACL 和按群插件开关。

`respond({toast?,card?})` 只接受首次且在回调开始后 2 秒内的响应，成功返回 true；到期返回空确认，晚到、重复和关闭后的响应返回 false。卡片响应支持 raw JSON 2.0 和 template；网络查询或业务工作尚未完成也不会拖延确认。耗时业务应尽早确认，再通过 `bot.feishu.updateCard(messageId, card)` 更新消息；可通过 `bot.feishu.sendCard(target, card)` 主动发送。

中立 `seg.button(label, {command:'/命令'})` 和 `bot.feishu.commandButton(label, command)` 生成带签名的命令按钮。点击后使用点击者身份进入正常命令管线，仍检查前缀、权限、ACL、冷却和群开关。其他 value、伪造签名以及表单提交均不触发命令。签名绑定应用凭据和机器人，轮换 App Secret 后需重新发送旧命令按钮。

## 联调

1. 打开「机器人 → 连接」，确认飞书连接为在线，再进入关联机器人核对名称和头像。
2. 在机器人「插件」中关闭一个业务插件，测试它不再响应；重新启用后恢复。全局插件详情的「机器人」页可以查看各机器人的应用和能力匹配。
3. 在全局、机器人和群配置中分别修改字段，核对有效配置与「字段来源」，再用「恢复继承」清除覆盖。
4. 在机器人设置中添加当前应用的用户 open_id，验证 `/bot plugin off <name>` 可用，而全局 `/plugin disable <name>` 仍需框架管理员。

- 私聊命令、群内 @命令；核对身份、toMe 与引用回复。
- 文字、图片、文件、富文本、混合消息及逐条发送记录。
- 卡片按钮、独立输入与选择、完整表单提交、重复回调、2 秒响应及后续卡片更新。
- ACL 屏蔽、按群关闭插件、普通用户与群管理权限。
- 网络断开后的重连状态、恢复上线、多账号移除和凭据更新。
- 日志与面板不出现 App Secret、Authorization。

仓库测试使用模拟 SDK 边界，不访问真实飞书；真实权限审批、应用可用范围和租户网络按上述步骤联调。

官方参考：[事件处理](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events)、[回调处理](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)。
