# 兼容性：在 dsh 0.2.1-rc.5 上运行

本仓库的 `blueprint/` 是一个标准 dsh bundle。上游 `app/package.json` 目前把 dsh 运行时精确钉在
`0.2.1-alpha.2`；在 `0.2.1-rc.5`（npm 上的 `latest`）上需要下面几处调整，本分支已包含第 1、2、3 条，
第 4 条为安装步骤要求。

## 1. 版本范围

`blueprint/package.json` 与 `packages/{context,node,studio}/package.json` 里的
`@deepseek-ai/dsh-*` 由精确 `0.2.1-alpha.2` 改为 `>=0.2.1-alpha.2 <0.3.0`。

## 2. 解析锚点可覆盖

`cordis.patch.yml` 与 `agent.cordis.yml` 用 `profileContext.installAnchor` 调
`createRequire(...).resolve('@deepseek-ai/...')`。当 bundle 以 `file:` 目录安装时，锚点不是安装它的
profile，解析会失败并报 `Cannot find module '@deepseek-ai/dsh-browser-use'`。

现在支持环境变量覆盖：

```powershell
$env:BLUEPRINT_INSTALL_ANCHOR = 'C:/Users/<user>/.dsh/profiles/<profile>/package.json'
```

未设置时仍使用 `profileContext.installAnchor`，桌面版行为不变。

## 3. 新增的运行时依赖

以下包不在 dsh base 里，需要在 profile 中显式安装（本分支已加入 peerDependencies）：

- `@deepseek-ai/dsh-browser-use`
- `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`
- `@deepseek-ai/dsh-skill-office`
- `@deepseek-ai/dsh-tool-workspace-dependencies`
- `@deepseek-ai/dsh-tool-workflow`
- `@deepseek-ai/dsh-agent-tool-presentation`

## 4. 安装时还需两步（本分支未改代码）

1. **`viewer/` 必须位于 profile 根**：`@blueprint/studio/src/界面语言.js` 通过
   `../../../../viewer/…` 相对导入，从 profile 的 `node_modules` 出发会落到 profile 根。

   ```powershell
   robocopy <repo>\viewer C:\Users\<user>\.dsh\profiles\<profile>\viewer /E
   ```

2. **koffi**：pnpm 默认忽略其安装脚本（`ERR_PNPM_IGNORED_BUILDS`），按需 `pnpm approve-builds`。

## 已知限制（Windows / web profile）

- 上游 `app/` 只发布 macOS arm64 的 Electron 壳；Web 模式（`dsh web`）可以启动，画布 UI 正常挂载。
- Codex / Claude Code 外部 provider 需要本机装有对应 CLI 并完成授权。
