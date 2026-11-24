# @asabot/plugin-ai

AsaBot 的可选 AI 基础插件。需要 `@asabot/core` 0.3.0、已启用的内置 `http` 插件和 Node.js 24 或更高版本。启用后，进入控制台「插件页面 → AI 管理」。

- **渠道**：配置协议、Base URL、API Key 或服务器环境变量。可以配置同一协议的多个渠道，包括自建网关；拉取列表与实际测试调用是两个操作。
- **模型**：拉取或手动添加模型，再选择其实际提供的能力。每个模型有不随名称变动的本地 ID；上游模型名填写提供商要求的值。
- **插件权限**：不传模型 ID 时，按「插件专属默认 → 全局默认」查找。显式 ID 优先；白名单同时约束列表和调用。空白名单禁止全部调用，不设置白名单则可调用所有已启用的模型。找不到、不可用或越权时不会切换到别的模型。
- **请求记录 / 用量统计**：查找来源、模型、状态、耗时、事件 ID 和已有用量。面板测试单独归因。统计按 UTC 日聚合，可悬停或点按趋势图查看当天的调用次数。不估算费用，未上报的 Token 不记作零。

| 渠道协议 | 对话 | 图片生成 | 语音合成 | 决策 |
| --- | --- | --- | --- | --- |
| OpenAI Chat Completions / Responses | 对应的独立协议 | `/images/generations`（Base64 图片） | `/audio/speech` | — |
| Anthropic Messages | `/messages` | — | — | — |
| Gemini 原生 | `generateContent` / `streamGenerateContent` | 支持图像输出的 Gemini 模型 | 支持音频输出的 Gemini TTS 模型 | — |
| TypeSafe AI System One | — | — | — | [`/systemone`](https://docs.typesafe.ai/concepts/system-one)，可手动添加如 `jev-latest` 的上游模型 |

Base URL 填协议的前缀（例如 `https://api.openai.com/v1`、`https://generativelanguage.googleapis.com/v1beta`），不包含具体操作路径。代理配置复用 AsaBot 的 `http` 服务。调用请求不会自动重试或跨渠道转发。测试会产生实际请求，可能消耗配额。

## 在业务插件中使用

类型导入只在开发时需要；运行时由已安装的 AI 插件注入服务。在以下例子中，机器人上的业务插件需要启用，AI 服务本身是全局资源。

```ts
import { definePlugin } from '@asabot/core'
import type { AiService } from '@asabot/plugin-ai'

export default definePlugin({
  name: 'ask-ai',
  inject: ['ai'],
  setup(ctx) {
    const ai: AiService = ctx.inject('ai')
    ctx.command('ask <question:text>').action(async ({ args, signal }) => {
      const reply = await ai.generate({
        messages: [{ role: 'user', content: args.question }],
        signal,
      })
      return reply.text
    })
  },
})
```

- `listModels({ capability? })` 读取经过白名单过滤的本地模型目录，返回 `id`、`name`、`capabilities`，不调用上游。可把其中的 `id` 作为任一调用的 `modelId`。
- `generate({ system?, messages, maxOutputTokens?, tools?, outputSchema?, modelId?, signal? })` 支持多轮对话。图片输入提供 `Uint8Array` 或 `Buffer` 及 MIME 类型；`outputSchema` 使用对象型 JSON Schema（Draft 7）。`toolCalls` 由业务插件执行，不会自动执行代码；后续把返回的 `toolCalls` 放入 `assistant` 消息，并为每个调用传入对应的 `tool` 消息。保留完整调用对象以便 Gemini 重放工具上下文。
- `stream(options)` 返回按需启动的异步可迭代对象，依次产生 `text-delta`、`tool-call` 或 `finish`；最终结果和用量在 `finish.result`。可用信号取消等待中的请求，提前退出迭代也会取消尚未完成的调用。
- `generateImage({ prompt, count?, size?, aspectRatio?, modelId?, signal? })` 返回 `images`；`synthesizeSpeech({ text, voice?, modelId?, signal? })` 返回 `audio`。媒体都是 `{ data: Buffer, mediaType }`，可传给 `seg.image()` / `seg.audio()`。尺寸、比例和音色受上游模型支持情况限制。
- `decide({ state, questions, modelId?, signal? })` 支持同一次混合 `noul`、`choice` 和 `score`。返回以问题 ID 为键的结构化 `answers`、实际 Jev 版本和已上报用量。
- 调用结果提供 `requestId`、`modelId`、`upstreamModel` 和 `usage`。`AiError` 提供稳定的 `code`，已有审计记录时附 `requestId`。来源由 AsaBot 绑定；业务插件无需传入自己的名称。

## 密钥与数据保留

面板输入的 API Key 加密存入 SQLite，主密钥位于 AsaBot 数据目录下的 `plugins/ai/credentials.key`。备份或迁移时应保留数据库和这个文件。也可以只保存环境变量名，实际密钥由运行 AsaBot 的进程读取。系统管理员和同进程运行的插件属于服务端信任范围；只安装信任的插件。

默认只保留 30 天的请求元数据，按日汇总长期保留。临时采集只针对一个来源，开启后自动在 30 分钟到期；已采集的内容在 24 小时后不可查看。不记录鉴权头、媒体原件和上游原始错误。开启采集前确认该来源的消息内容适合留存，采集结束后可提前关闭。

## 本地构建与安装

在 AsaBot 仓库根目录执行：

```sh
pnpm --filter @asabot/panel-ui build
pnpm --filter @asabot/plugin-ai build
pnpm --filter @asabot/plugin-ai pack
```

使用本仓库的 AsaBot 0.3.0 或匹配的构建。在已初始化的 `data/packages`（或 `packages.dir` 指定的目录）执行 `npm install --save --legacy-peer-deps --ignore-scripts <生成的 .tgz 绝对路径>`，然后重启 AsaBot。框架会校验版本并提供运行时，不需要在插件目录额外安装 `@asabot/core`。正式发布后可从插件市场安装 `@asabot/plugin-ai`。

面板资源随安装包分发。修改插件页面或共享组件后，需要用新生成的 `.tgz` 更新插件，单独刷新浏览器不会更新已安装的资源。
