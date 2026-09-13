# 扩展后台进程与系统 Node.js

Pace 内置固定版本的 Pi SDK，普通会话不需要全局安装 Pi 或 Node.js。需要自行启动 Node 进程的扩展，例如 pi-subagents 的后台任务，则使用机器已有的 Node.js。

Pace 不下载、安装或额外分发 Node，也不修改扩展源码。当前最低版本为 Node.js 22.19.0，并检查扩展 runner 所需的模块加载能力。该版本下限与固定的 Pi 0.84.3 对齐。

## 如何找到 Node

后端启动时按以下顺序发现并校验 Node；只有候选程序真实执行并通过版本与能力检查，才把它的实际目录放到后端 PATH 最前面：

1. 显式设置的 `PACE_NODE_PATH`。必须为绝对路径；无效时直接显示诊断，不悄悄选择另一个安装。
2. 启动环境的 PATH。
3. 登录交互 shell 的 PATH，兼容从 Dock/Finder 启动时未继承终端配置的情况。只取 PATH，不导入 shell 中的凭据或其他环境变量。
4. 常见系统和工具管理器目录，包括 Homebrew、Volta、asdf 和 mise。nvm 等由登录 shell 选择当前版本。

候选程序和 shell 执行均有超时，shell 配置失败不会阻止内置 Pi 会话。发现过程不假定每台机器一定安装了 Node。

## 配置与诊断

环境预检中的 **Extension Node.js** 会展示实际路径和版本。缺失、版本过旧、不可执行或显式路径错误都会显示修复说明。这是可选检查，不阻止普通会话继续使用。

正常情况下，在终端安装并配置好 Node 后重启 Pace 即可。也可退出 Pace，从终端显式指定已有 Node：

```sh
PACE_NODE_PATH=/absolute/path/to/node /Applications/Pace.app/Contents/MacOS/Pace
```

这是启动环境设置，不会写入 Pi 配置。修改该环境变量后需要重新启动 App。若只是补装了缺失的 Node，可使用预检的 Recheck 重新发现；之后启动的扩展子进程使用新的 PATH。已经运行的子进程不受影响。

Node 的作用是执行扩展的独立 runner；SDK 仍来自 Pace 固定的 Pi 版本，不跟随全局 `pi` 升级。

## SDK 分发方式

构建产物为 SDK 及需要的 peers 提供真实 package.json 和 ESM 入口，入口之间共享 bundle chunks。它不是完整 npm 依赖树，也不为某个插件替换启动函数。

构建选择公开导出，通过原包的 `package.json` 解析实际入口，再由打包器追踪静态依赖；没有逐个选择 OAuth 的内部实现文件。Pi 为隔离 Node 专用代码而使用的变量动态导入不能被打包器追踪，因此入口还需要调用 Pi 公开的 `@earendil-works/pi-ai/bun-oauth` 注册函数。构建为后端、SDK 和 pi-ai 的公开入口接入同一个初始化模块，每个独立进程都会执行，不依赖父进程先创建 Pace 服务。

OAuth 实现的路径和完整列表由 Pi 的公开打包入口维护。SDK 内部移动文件而保持公开导出不变时，Pace 无需跟随内部路径；公开接口发生变化时，仍需按固定版本升级并重新验收。主题和 WASM 等非模块资源继续由构建单独复制。这种分发提供已声明入口的兼容性，不等同于完整 npm 包目录或任意动态子路径均可读取。

后端入口位于 `@earendil-works/pi-coding-agent` 包目录内，因此现有扩展能从进程入口找到真实 Pi 包根。Electron 安装包把这些入口和共享 chunks 放在 `app.asar.unpacked/out/main/runtime`，使普通 Node 也能读取它们；通过 `PI_PACKAGE_DIR` 定位 Pi 必需的运行资源。

electron-builder 会忽略普通 files 中嵌套的 node_modules，所以打包配置显式复制构建生成的公开入口包。仅复制这些入口，不遍历或分发原 npm 生产依赖树。

终端原生库仍从 Electron 的 asar 路径解析，因为 node-pty 会自行将辅助程序路径转换为 asar.unpacked；直接从已解包的路径加载会造成重复转换。安装包验收同时覆盖真实终端与后端重启。

当前公开入口覆盖 Pi 0.84.3 的 SDK 根、pi-agent-core 根和 node、pi-ai 根/compat/oauth/providers/all、pi-tui 根，以及 typebox 根/compile/value。没有声明支持全部 SDK 子路径或任意未来版本的扩展。

## 验证

```sh
bun run test
bun run typecheck
bun run build
bun run test:bundled-runtime
bun run package:mac:unsigned
PACE_E2E_EXECUTABLE=dist/mac-arm64/Pace.app/Contents/MacOS/Pace \
  bun run test:e2e e2e/smoke/m5-2-preflight.spec.ts
```

使用已经安装好依赖的原版 pi-subagents，运行可选的完整后台验证：

```sh
PACE_TEST_SUBAGENTS_DIR=/absolute/path/to/pi-subagents \
PACE_E2E_EXECUTABLE=dist/mac-arm64/Pace.app/Contents/MacOS/Pace \
  bun run test:e2e e2e/smoke/extension-runner.spec.ts
```

测试隔离 HOME、TMPDIR、Pi 配置、工作目录及 App 数据。通过生产会话入口调用原版 `subagent({ async: true })`，检查后台状态、真实进程退出、子会话用量和父会话完成通知，并校验插件源码未修改。模型使用本地固定 SSE 响应，不消耗真实模型额度。

后台测试分别使用 API Key 与 OpenAI Codex OAuth 假凭据；后者经过真实的订阅认证派生和 Responses 请求路径，验证父、子请求都携带预期认证。独立产物测试另外覆盖 SDK 从 `auth.json` 派生认证，以及仅加载公开 provider 入口时所有内置 OAuth 流程的认证派生。这些测试不执行真实登录或令牌刷新。

当前验收为 macOS arm64 的本地未签名 App。系统 Node 路径本机验证为 Homebrew Node 25.9.0；Pi SDK 0.84.3、pi-subagents 0.67.0。这不等于完成所有 Node 版本或平台的矩阵验证。签名、公证、真实账号，以及 steer/stop/resume 和多步骤工作流仍有各自的验收范围。

子会话自身记录用量，但本改动不将其并入 Pace 的子会话成本归属或回放模型；宿主观测管道的扩展另行处理。
