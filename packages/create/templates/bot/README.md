# {{name}}

需要 Node.js 24 或更高版本。安装依赖后运行：

```sh
npm install
npm run dev
```

打开 <http://127.0.0.1:5140>，输入终端显示的设置码，按向导完成首次设置。正式运行使用 `npm start`。

将插件放在 `plugins/` 中；`plugins/hello.ts` 是一个带配置和命令的示例。开发时可运行 `npm run typecheck` 检查类型。

插件开发及配置说明见 [@asabot/core npm 页面](https://www.npmjs.com/package/@asabot/core)。
