# 内置运行时发布验证

本文记录 [ADR-0031](adr/0031-bundled-pi-runtime-and-extension-compatibility.md) 已有实现的验证入口。GUI 扩展交互、专属面板与 CLI 会话交接仍按各自功能范围推进。

## 构建约束

- `packages/backend/package.json` 精确声明 Pi 引擎依赖，`bun.lock` 固定依赖树。
- 所有 `package:*`、`dist:*` 发布入口先执行 `build:release`：冻结安装、类型检查与构建、独立产物冒烟。
- 构建读取实际安装的 Pi 包版本和 App 包版本，预检显示这两个版本及 `SDK` 模式。
- Pi 扩展使用引擎自带的虚拟 peer 模块；新增构建外部依赖时需要再次检查独立产物。
- 独立 Node runner 使用同一 bundle 的真实 SDK/peer 导出；安装包中的入口和共享 chunks 必须位于 asar 外。系统 Node 是扩展后台能力的可选前提，发现与配置见 [系统 Node 扩展运行](system-node-extensions.md)。

## 自动化入口

```sh
bun run test
bun run typecheck
bun run build:release
bun run package:mac:unsigned
bun run test:e2e:packaged:mac e2e/smoke/m5-2-preflight.spec.ts
```

`build:release` 的 `scripts/test-bundled-runtime.mjs` 将后端构建产物复制到临时目录，隔离仓库依赖、全局 Pi 目录和 `PATH`，通过实际后端消息入口验证：

- 内置引擎可通过预检，诊断版本与安装依赖一致。
- 原生 TypeScript 扩展可导入 `typebox` 并注册工具、命令。
- `session_start` 和原生命令处理器实际执行。
- 故意损坏的扩展产生加载诊断，首次创建响应及后续历史读取都能看到错误。
- 仓库外的独立 Node 能通过公开 SDK/peer 入口创建真实 Pi 会话，并保持 SDK 与 peer 类型身份一致。
- 独立 SDK 从隔离的 `auth.json` 读取 Codex OAuth 假凭据并派生请求认证；只加载公开 provider 入口时，所有内置 OAuth 流程也能执行认证派生。禁止网络访问，避免用 import 成功代替实际认证行为。
- 缺少扩展 Node 时有明确的可选诊断，内置 Pi 的必需检查仍通过。

最终安装包中的运行时也可执行同一组 OAuth 检查：

```sh
PACE_TEST_RUNTIME_DIR=dist/mac-arm64/Pace.app/Contents/Resources/app.asar.unpacked/out/main/runtime \
  node --test --test-name-pattern='subscription auth|OAuth flow' scripts/test-bundled-runtime.mjs
```

设置 `PACE_TEST_SUBAGENTS_DIR` 后，`e2e/smoke/extension-runner.spec.ts` 用原版插件分别验证 API Key 和 Codex OAuth 后台执行。OAuth 场景使用假凭据与本地 Responses SSE 服务，覆盖主会话、独立 Node 子会话的实际认证请求与完成回传；可以结合 `PACE_E2E_EXECUTABLE` 在最终安装包运行。

单元与集成测试另外覆盖创建／恢复／分叉的扩展绑定、初始化失败清理、分叉历史与启动事件的顺序、非致命错误在后端投影和前端状态中的处理，以及原生包清单、禁用规则、包内技能和只读查询。

安装包预检 E2E 在 `PATH` 为空时打开真实 Electron App，检查内置版本展示、继续进入主界面，以及缺少认证时阻断、缺少可选 Git 时放行。

## 验收边界

测试使用临时认证占位，不登录真实账号、不调用付费模型。真实 OAuth 登录、模型工具执行、运行中停止与跨版本旧会话恢复／分叉，需要在引擎升级时使用对应账号和历史数据进一步验收。上述自动化验证不代表任意第三方扩展均已兼容。
