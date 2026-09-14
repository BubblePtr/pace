# ADR-0031：内置 Pi 引擎与原生扩展兼容

- 状态：已接受（已有实现的对齐状态与后续验收见文末）
- 日期：2026-09-05
- 来源：用户关于 Pi 运行时分发、版本升级与扩展可视化目标的讨论及确认

## 背景

PiGUI 的核心定位是 Pi 运行时与扩展生态的可视化宿主。独立发布 App 需要控制 Pi 版本，以避免用户升级全局 CLI 后改变 App 行为；但这不能演变成要求用户维护另一套扩展，或让扩展作者重新实现业务逻辑。

决策记录时，后端已默认使用 Pi SDK，构建配置已将其打包进 App。`pi-coding-agent` 与 `pi-ai` 的直接依赖声明为 `^0.84.3`，lockfile 解析为 `0.84.3`。当时的环境预检仍将 PATH 中的 `pi` CLI 作为必需条件，与默认 SDK 路径不一致。因此，决策重点是明确发布与兼容承诺，而非重新选择是否嵌入 Pi。

引擎分发、扩展复用、会话交接是三个不同的边界。独立发布引擎不意味着独立的插件生态，也不要求 GUI 与终端同时连接同一个运行实例。

## 决策

> PiGUI 管理自己验证过的 Pi 引擎，但兼容原来的 Pi 扩展；图形界面作为扩展的增强能力。

### 1. 默认内置经过验证的 Pi 引擎

- 每个 PiGUI 发布版本对应明确、经过验证的 Pi 依赖组合，默认随 App 一起发布和升级。用户全局安装的 `pi` 版本不决定 PiGUI 默认会话的执行版本。
- 沿用 ADR-0018 的 SDK 主路径和 Runtime Gateway 边界：Pi 负责执行与上下文真相，Driver 负责适配，前端消费 PiGUI 的产品协议。
- Pi 升级由 PiGUI 维护者验证兼容性后发布。运行时独立自动更新、多版本管理器和跟随系统 Pi 的模式不作为当前实现前提；本 ADR 也不解冻 RPC driver。
- 依赖应精确声明并通过 lockfile 固定完整依赖树；发布构建禁止隐式更新依赖。诊断信息应能辨认 App 版本、实际 Pi 版本及运行模式。

### 2. 原生扩展兼容是核心产品承诺

- 沿用 Pi 的扩展包格式、来源、发现规则和配置语义，在明确支持的兼容范围内复用用户已有扩展。不得要求扩展作者为 PiGUI 复制工具、命令、工作流或状态管理逻辑。
- 同一个 Pi 扩展包可以在不同宿主提供不同呈现。GUI 面板是可选增强；没有专属面板时，兼容的基础能力仍应可用。
- 扩展的安装与启用配置、实际加载版本和兼容性需要可理解、可诊断。内置 Pi 版本不等于自动兼容任意新版本扩展，共用目录也不能替代兼容性验证。

| 扩展能力 | PiGUI 的责任 |
|---|---|
| 工具、命令、事件处理与业务状态 | 交给 Pi 执行，复用原扩展逻辑 |
| `confirm`、`select`、`input`、通知等标准交互 | 将请求和用户响应接入 Runtime Gateway，映射为 GUI 控件 |
| 自定义 TUI 组件与终端渲染 | 明确宿主能力边界；提供适用的通用展示，或允许同一扩展增加可选 GUI 面板 |

Pi 的终端组件不会仅因版本一致就自动成为 GUI 面板。可视化协议的具体形式、能力声明和版本协商由真实扩展验证后另行设计；本 ADR 不冻结 API，也不承诺任意 TUI 扩展零修改即可完整图形化。

### 3. 会话交接与同时控制分开规划

| 能力 | 范围 |
|---|---|
| 复用 Pi 扩展、配置与业务逻辑 | 核心产品承诺 |
| 扩展交互、状态与可选面板的图形化表达 | 核心差异化能力 |
| 将 CLI 会话交给 PiGUI 继续 | 可后续单独设计和实现，当前不承诺支持 |
| GUI 与终端同时操作同一个运行实例 | 当前不作为架构前提 |

ADR-0021 中“不导入 CLI/TUI 会话”保留为当前实现范围，不作为永久产品原则。未来若实现会话交接，需单独处理 Session identity、Execution Checkout、Pi 上下文恢复及缺失的 Session Event Journal；不能把共用会话文件当作共享运行实例，也不能伪造缺失的历史运行事件。

## 与已有决策的关系

- 延续 [ADR-0002](0002-pi-only-runtime.md) 的 Pi-only 方向和 [ADR-0018](0018-runtime-gateway-api-and-pi-drivers.md) 的 Gateway / Driver 分层，补充引擎发布与扩展兼容原则。
- 澄清 [ADR-0021](0021-session-fork-resume-persistence-layering.md) 及 `CONTEXT.md` 的 Session Creation Boundary 为当前阶段边界；不改变现有列表、恢复、分叉与双轨持久化行为。
- [ADR-0025](0025-first-run-environment-preflight.md) 的 Pi runtime 必需检查现已验证实际使用的内置引擎，并显示 App / Pi 版本与 SDK 模式；默认路径不再要求另装全局 CLI。

## 已有实现的对齐状态（2026-09-05）

本次修复只覆盖已有实现：

1. 环境预检检查内置 SDK，构建时记录实际安装的引擎版本，避免将 App 包版本误报为 Pi 版本。
2. 独立构建启用 Pi 自带的 `PI_BUNDLED_NODE` 虚拟模块解析，使原生扩展不依赖仓库中的 Pi peer 模块文件。
3. 创建、恢复和分叉均绑定扩展并执行启动生命周期；加载和事件处理错误进入首次响应与持久化事件历史，可恢复的扩展错误不将整个会话标记为失败。
4. Setup 的全局配置清单复用 Pi 的包发现、过滤与技能解析规则，支持包对象和禁用配置。查询不安装包、不执行扩展、不写回配置；清单中的启用状态表示配置结果，实际加载失败由会话诊断报告。
5. 两个 Pi 直接依赖精确固定为 `0.84.3`，发布构建先执行冻结 lockfile 安装，再构建并运行独立产物冒烟测试。

验证入口与覆盖范围见 [内置运行时发布验证](../runtime-release-validation.md)。

## 后续实现与验收方向

2026-09-13 调整：撤销 #294 的独立 Node runner 打包兼容安排。Pace 恢复普通后端入口与进程内 SDK 虚拟 peer；不分发真实 SDK/peer 包，不探测系统 Node。Tintinweb 的普通子代理通过进程内 SDK 运行，生命周期与观测按正式宿主接口接入。此调整不自动修改用户插件配置或已有会话历史；旧 nicobailon 独立后台 runner 不再由 Pace 自动兼容。具体边界与验证入口见[扩展运行与打包边界](../extension-runtime.md)。

1. 未来实现标准扩展交互与可选面板时，选择一个真实 Pi 扩展验证完整路径：原包加载、工具与事件运行、标准交互在 GUI 中完成、同一扩展增加可选面板；以此推进 ADR-0018 的 Extension UI 协议。
2. 引擎升级时继续在最终安装包验证无全局 `pi` 的默认路径，并覆盖 OAuth、真实模型工具调用、停止及旧会话恢复/分叉等升级敏感路径。自动化冒烟不替代涉及真实账号与模型的完整升级验收。

会话交接与共享运行实例均不因本 ADR 自动进入实施范围。

## 参考

- [Pi SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi 扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- 当前实现依据：[后端依赖](../../packages/backend/package.json)、[组合根](../../packages/backend/src/service.ts)、[构建配置](../../apps/desktop/electron.vite.config.ts)、[打包配置](../../electron-builder.yml)、[环境预检](../../packages/backend/src/workspace/environment-preflight.ts)。版本与实现现状为 2026-09-05 核查结果，后续以代码和 lockfile 为准。


2026-09-14：根会话承载改为独立进程，原版插件自行管理子代理，撤销专用宿主观测协议；此处后续以 [ADR-0040](0040-root-session-process-isolation.md) 为准。SDK 仍随应用打包，不恢复系统 Node 探测或独立 SDK 包分发。
