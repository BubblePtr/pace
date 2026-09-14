# 扩展运行与打包边界

Pace 为每个启动的根 Session 创建独立的 Node 进程，进程内运行固定版本的 Pi SDK 和用户插件。Tintinweb 原版在所属根进程内管理子会话。所有进程使用应用自带的 Electron/Node，不需要全局 Pi CLI 或额外安装 Node。

## 构建布局

- `out/main/backend.js` 管理公共 Gateway、Journal、查询和会话进程；`out/main/session-worker.js` 是每个根 Session 的运行入口。工作目录在进程启动时设置，恢复/分支以 Pi 保存的 cwd 为准，在加载插件前确定。
- Pi 扩展通过 SDK 的 `PI_BUNDLED_NODE` 虚拟模块导入公开 peer，Pace 不另行分发供独立 Node 消费的 SDK/peer 包或 manifest。
- `out/main/pi-assets` 仅保存 Pi 内置主题资源；`PI_PACKAGE_DIR` 指向此资源目录，不把 Pace 入口放入 Pi 包目录。
- Photon WASM 随其构建 chunk 放置。node-pty 的原生库与 spawn helper 保持在 asar 外，由 Electron 后端加载。
- 后端使用应用自身的运行时，不探测系统 Node、不注入 Node PATH，也不显示 Extension Node.js 预检。

## 兼容范围调整

2026-09-13 起撤销 #294 为旧 nicobailon `pi-subagents` 独立后台 runner 提供的包根与系统 Node 自动兼容。旧插件自行启动外部 Node 的路径不再属于 Pace 验证的运行范围。

2026-09-14 按 [ADR-0040](adr/0040-root-session-process-isolation.md) 改为根 Session 进程隔离，撤销 fork 的宿主观测/控制协议。原版插件自行管理子会话；Pace 在根关闭时发出 Pi 的 `session_shutdown`，并等待会话进程退出。项目 cwd 和插件全局变量的隔离由宿主提供，不要求插件逐个实现根作用域适配。正常 Stop 沿用 Pi 当前运行的 abort 语义，不承诺取消插件全部后台任务；删除根 Session 和应用退出才关闭整个运行环境。

不自动改写用户的插件设置或删除会话文件。原来安装的 fork 可由用户在 Packages 中换为上游原版；当前应用不再依赖其专用接口。详见[子代理运行说明](subagent-observation.md)。

## 运行回归

```sh
bun run build
bun run test:bundled-runtime
PACE_TEST_TINTIN_SUBAGENTS_DIR=/absolute/path/to/pi-subagents bun run test:e2e:packaged:mac e2e/smoke/extension-runner.spec.ts
bun run test:e2e:packaged:mac e2e/smoke/m5-2-preflight.spec.ts e2e/smoke/terminal-surface.spec.ts
```

Tintinweb 测试目录需包含固定版本原始源码及依赖；测试前后校验源码未变。测试隔离用户配置并清空 PATH，用本地可控模型分别覆盖 API Key 和 Codex OAuth 请求、前台等待、后台父会话继续、子代理 read 与完成通知，插件停止接口、两个项目的 `.pi/agents` 独立加载、删除单个根时其他根后台任务继续，以及正常退出触发插件清理。它不替代真实账号登录或令牌刷新验证。
