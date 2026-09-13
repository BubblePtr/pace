# 内置运行时发布验证

本文记录 [ADR-0031](adr/0031-bundled-pi-runtime-and-extension-compatibility.md) 已有实现的验证入口。GUI 扩展交互、专属面板与 CLI 会话交接仍按各自功能范围推进。

## 构建约束

- `packages/backend/package.json` 精确声明 Pi 引擎依赖，`bun.lock` 固定依赖树。
- 所有 `package:*`、`dist:*` 发布入口先执行 `build:release`：冻结安装、类型检查与构建、独立产物冒烟。
- 构建读取实际安装的 Pi 包版本和 App 包版本，预检显示这两个版本及 `SDK` 模式。
- Pi 扩展使用引擎自带的虚拟 peer 模块；新增构建外部依赖时需要再次检查独立产物。
- 后端保持普通入口，SDK/peer 以内联虚拟模块供进程内扩展使用。主题、Photon WASM 与 node-pty 资源随安装包分发；不要求系统 Node。兼容范围调整见[扩展运行与打包边界](extension-runtime.md)。

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
- 原生命令可加载内置深浅主题，并通过 Photon WASM 缩小图片。

`e2e/smoke/extension-runner.spec.ts` 在真实打包版中以原版 Tintinweb 验证前台和后台 SDK 子会话、本地 API Key／Codex OAuth、父会话继续、子代理 read／完成通知和插件取消；通过 `PACE_TEST_TINTIN_SUBAGENTS_DIR` 指向源码与依赖。

单元与集成测试另外覆盖创建／恢复／分叉的扩展绑定、初始化失败清理、分叉历史与启动事件的顺序、非致命错误在后端投影和前端状态中的处理，以及原生包清单、禁用规则、包内技能和只读查询。

安装包预检 E2E 在 `PATH` 为空时打开真实 Electron App，检查内置版本展示、继续进入主界面，以及缺少认证时阻断、缺少可选 Git 时放行。

## 验收边界

测试使用临时认证占位，不登录真实账号、不调用付费模型。真实 OAuth 登录、模型工具执行、运行中停止与跨版本旧会话恢复／分叉，需要在引擎升级时使用对应账号和历史数据进一步验收。上述自动化验证不代表任意第三方扩展均已兼容。
