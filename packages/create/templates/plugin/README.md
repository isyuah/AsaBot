# asabot-plugin-{{name}}

AsaBot 插件示例。需要 Node.js 24 或更高版本。

## 安装

在 AsaBot 面板的插件市场搜索 `asabot-plugin-{{name}}`，或由超管发送 `/plugin install asabot-plugin-{{name}}`。

## 开发和发布

```sh
npm install
npm test
npm run build
npm publish
```

修改 `src/index.ts` 中的插件定义和命令；`src/index.test.ts` 使用虚拟适配器测试。发布前确认包名可用并更新版本号，`prepublishOnly` 会自动构建 JS 和类型声明。

插件开发文档见 [@asabot/core npm 页面](https://www.npmjs.com/package/@asabot/core)。
