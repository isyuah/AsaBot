# @asabot/create

创建 [AsaBot](https://www.npmjs.com/package/@asabot/core) 机器人项目或插件包。

```sh
npm create @asabot@latest
```

不带参数时会依次询问模板和目录。也可以直接传参数，跳过询问：

```sh
# 机器人项目
npm create @asabot@latest my-bot -- --template bot --yes

# 插件包（生成 asabot-plugin-<name>）
npm create @asabot@latest -- --template plugin --name weather --yes

# 生成后立即安装依赖
npm create @asabot@latest my-bot -- --yes --install
```

| 参数 | 说明 |
| --- | --- |
| `[dir]` | 目标目录，必须不存在或为空 |
| `--template bot\|plugin` | 机器人项目，或可发布到 npm 的插件包 |
| `--name <name>` | 插件名（plugin 模板） |
| `--yes` | 全部使用默认值 |
| `--install` | 生成后执行安装（自动识别 npm、pnpm、yarn、bun） |

机器人项目首次运行 `npm run dev` 时会在控制台打印设置码，按提示在浏览器中打开面板完成设置。
