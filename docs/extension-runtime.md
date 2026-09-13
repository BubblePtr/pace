# 扩展运行与打包边界

Pace 在 Electron 的 Node 后端进程中内联固定版本的 Pi SDK。普通主会话和 Tintinweb 的进程内子代理共用这套 SDK，不需要全局 Pi CLI 或额外安装 Node。

## 构建布局

- `out/main/backend.js` 是普通 Pace 后端入口。
- Pi 扩展通过 SDK 的 `PI_BUNDLED_NODE` 虚拟模块导入公开 peer，Pace 不另行分发供独立 Node 消费的 SDK/peer 包或 manifest。
- `out/main/pi-assets` 仅保存 Pi 内置主题资源；`PI_PACKAGE_DIR` 指向此资源目录，不把 Pace 入口放入 Pi 包目录。
- Photon WASM 随其构建 chunk 放置。node-pty 的原生库与 spawn helper 保持在 asar 外，由 Electron 后端加载。
- 后端使用应用自身的运行时，不探测系统 Node、不注入 Node PATH，也不显示 Extension Node.js 预检。

## 兼容范围调整

2026-09-13 起撤销 #294 为旧 nicobailon `pi-subagents` 独立后台 runner 提供的包根与系统 Node 自动兼容。旧插件自行启动外部 Node 的路径不再属于 Pace 验证的运行范围。

此调整不会自动卸载用户插件、改写全局设置或删除已有会话历史。迁移到 Tintinweb 以新会话的扩展配置为准；完整生命周期和观测要求插件宿主协议 v1，见[子代理观测与安装说明](subagent-observation.md)。上游原版 0.19.0 能运行任务，但尚不包含该协议。

## 运行回归

```sh
bun run build
bun run test:bundled-runtime
PACE_TEST_TINTIN_SUBAGENTS_DIR=/absolute/path/to/pi-subagents bun run test:e2e:packaged:mac e2e/smoke/extension-runner.spec.ts
bun run test:e2e:packaged:mac e2e/smoke/m5-2-preflight.spec.ts e2e/smoke/terminal-surface.spec.ts
```

Tintinweb 测试目录需包含固定版本原始源码及依赖；测试前后校验源码未变。测试隔离用户配置并清空 PATH，用本地可控模型分别覆盖 API Key 和 Codex OAuth 请求、前台等待、后台父会话继续、子代理 read 与完成通知，以及插件停止接口。它不替代真实账号登录或令牌刷新验证。
