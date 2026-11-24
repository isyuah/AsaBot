# 贡献 AsaBot

## 报告问题

到 [Issues](https://github.com/isyuah/AsaBot/issues/new/choose) 选择 **Bug report** 或 **Feature request**。Bug 表单会收集版本、运行方式和复现步骤，并添加 `bug`；功能建议会添加 `enhancement`。需要查待处理的问题时，在 Issues 搜索 `is:issue is:open label:bug`。

## 提交改动

有需要讨论的设计或暂时做不了的问题，可以先开 Issue。能直接完成的修复可以直接提 PR。不要在 `main` 上直接提交：维护者从最新的 `main` 切分支，外部贡献者先 fork，再从自己的分支向本仓库的 `main` 提 PR。

本地开发见 [README](README.md#仓库开发)，仓库开发规则见 [AGENTS.md](AGENTS.md)。提交前运行与改动相关的检查，PR 里的 `Verify` 会在 Linux 上安装锁定的依赖并运行 `pnpm lint`、`pnpm typecheck`、`pnpm --filter @asabot/plugin-ai typecheck`、`pnpm test`、`pnpm build` 和 `pnpm --filter @asabot/plugin-ai build`。PR 描述里写清变更和验证方式；想让 GitHub 在合并后关掉对应 Issue 时，写 `Closes #编号`（用实际编号替换）。

PR 标题用 `type(scope): description`，范围可以省略。例如 `fix(panel): show installed plugin READMEs`。分支里可以有临时提交，合并时用 Squash merge，并让最终提交标题沿用 PR 标题。

| PR 标题类型 | 自动标签 | 发布说明栏目 |
| --- | --- | --- |
| `feat` | `enhancement` | New features |
| `fix` | `bug` | Bug fixes |
| `docs` | `documentation` | Documentation |
| `refactor`、`perf`、`test`、`build`、`ci`、`chore`、`style`、`revert` | 无 | Other changes |

标题检查报错时，可以直接改 PR 标题触发重新检查。分类以 PR 标题为准；这三个分类标签由工作流同步，其他手工标签会保留。涉及不兼容改动时可以写 `feat(adapter)!: ...`，并在 PR 中说明怎么升级。

## 维护者仓库设置

1. 在 [Settings → General](https://github.com/isyuah/AsaBot/settings) 的 **Pull Requests** 区域只启用 **Allow squash merging**，默认提交信息选 **Pull request title**。
2. 等 `CI` 在 GitHub 上跑成功一次后，到 [Settings → Rules → Rulesets](https://github.com/isyuah/AsaBot/settings/rules) 新建分支规则，目标选默认分支 `main`，将规则状态设为 **Active**。启用 **Require a pull request before merging** 和 **Require status checks to pass**，添加 `Verify`。单人维护时把 **Required approvals** 设为 `0`，自己开的 PR 也能在检查通过后合并。

## 维护者发版

新版本的更新说明统一写在 [GitHub Releases](https://github.com/isyuah/AsaBot/releases)。仓库内的 [CHANGELOG.md](CHANGELOG.md) 保留历史记录和旧版升级指南，以后不用同步更新。

1. 准备发版 PR，更新核心包和本次要发布的其他包的版本。确认要发布的提交已进入 `main`，并且 CI 通过。
2. 给该提交打正式 Tag 并推送。以下以 `v0.3.0` 为例；如果 `origin/main` 又合了其他改动，打 Tag 时填写已经验收的提交 SHA。

   ```powershell
   git fetch origin
   git tag -a v0.3.0 origin/main -m "Release v0.3.0"
   git push origin v0.3.0
   ```

3. 在 [Actions](https://github.com/isyuah/AsaBot/actions/workflows/container.yml) 确认 `Publish container image` 成功。正式 Tag 会发布版本镜像和 `latest`。需要同时发布 npm 包时，按本次准备好的版本单独发布并确认可安装。
4. 到 [Releases](https://github.com/isyuah/AsaBot/releases) 点 **Draft a new release**。选择刚推送的 Tag，在 **Previous tag** 选上一个正式 Tag，点 **Generate release notes**。GitHub 会根据 `.github/release.yml` 和这段范围内合并的 PR 生成清单，保留 PR 标题原文。正文开头可以分别加 `## 简体中文` 和 `## English`，各写一份亮点和升级说明，两段共用后面的 PR 清单。直接推到 `main` 的用户可见改动需要手动补进摘要。预览后点 **Publish release**。

也可以用 GitHub CLI 生成草稿，仍以 `v0.3.0` 和上一个 Tag `v0.2.1` 为例：

```powershell
gh release create v0.3.0 --verify-tag --draft --generate-notes --notes-start-tag v0.2.1
```

发布草稿、更新 GHCR 镜像和升级已运行的服务是各自独立的动作。部署新版按[部署文档](docs/DEPLOY.md#使用-ghcr-镜像)操作；已发布版本有问题时，修复后发一个新版本，保留原 Tag。
