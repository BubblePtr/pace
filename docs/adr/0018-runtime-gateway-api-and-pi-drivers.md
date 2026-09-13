# 固定 Runtime Gateway API，Pi SDK 与 RPC 作为后端 Driver

PiGUI 的前端、未来 Web/mobile 客户端以及后端之间，固定的是 **PiGUI Runtime Gateway API**，不是 Pi SDK API，也不是 Pi RPC 原始协议。Renderer 只表达 PiGUI 的产品语义：创建 Session、attach/reconnect、发送 prompt、Queue、Steer、Stop、读取 runtime snapshot、订阅 runtime events、查看审计与产物。Pi 的具体接入方式收敛在后端 driver 内部。

## Decision

后端引入明确的 runtime orchestration 边界：

```text
renderer / web / mobile
  -> PiGUI Runtime Gateway API
    -> Backend Runtime Orchestrator
      -> PiRuntimeDriver
        -> PiSdkDriver
        -> PiRpcProcessDriver
```

`PiSdkDriver` 是下一阶段优先验证和实现的主路径。当前桌面外壳已经迁移到 Electron，后端运行在 Node `utilityProcess` 和 `packages/backend` 中，旧调研里“SDK 会把 Pi 嵌进不合适的 Tauri/Rust 主进程”的反对理由已经不成立。SDK 能更直接地暴露 Pi session、event stream、model/thinking、queue/compaction、extension UI request、resource loading、session manager 和 auth/model registry 等 GUI 需要的细节。

`PiRpcProcessDriver` 继续保留为隔离型和兼容型实现：当需要更强进程隔离、跟随用户本机 `pi` CLI 版本、多语言后端、远程执行代理、或 SDK 发生版本/行为回归时，后端可以切换到 RPC 子进程 driver。RPC driver 不是前端协议，也不应泄漏到 renderer。

## Gateway Protocol

Runtime Gateway 的事件必须是 PiGUI 产品层 envelope，而不是裸透 Pi raw event：

```json
{
  "id": "evt_01",
  "seq": 128,
  "sessionId": "app-session-123",
  "piSessionId": "pi-session-abc",
  "turnId": "turn-9",
  "type": "message_update",
  "ts": "2026-06-29T12:00:00.000Z",
  "payload": {}
}
```

`payload` 可以承载从 Pi SDK/RPC 映射来的细节，但 `seq`、PiGUI Session id、Pi session id、turn id、timestamp 和事件类型由 Gateway 负责稳定化。这样 renderer、WebSocket transport、MessagePort transport、断线重放、审计回放和多端同步都依赖同一套产品协议。

请求面同样用 PiGUI 语义命名，例如：

- `create_session`
- `attach_session`
- `send_prompt`
- `queue_follow_up`
- `withdraw_queued_message`
- `steer_run`
- `stop_run`
- `get_runtime_snapshot`
- `subscribe_runtime_events`

后端内部可以把这些请求映射到 SDK 方法、RPC command、或后续 sandbox/workflow adapter。

## Recovery Model

Runtime connection 使用两阶段恢复：

1. **轻断线**：客户端重连时携带最后收到的 `seq`，Gateway 从短期 event buffer 回放缺失事件。
2. **重断线或 Gateway 重启**：Gateway 先通过 Pi session state/messages 重建 runtime snapshot，再用 PiGUI 自己的 projection、审计事件和 checkout lifecycle 记录补齐产品层状态；如果 runtime state 与 projection 冲突，Pi Runtime 仍然优先，projection 标记 stale 并重新同步。

这个恢复模型要求 Runtime Gateway 持久化足够的 Session Projection 和审计 metadata，但不把 PiGUI 变成另一个 Pi session store。Pi Session State 仍是运行真相，PiGUI 保存 query model、lifecycle metadata 和产品审计事件。

## Security Boundary

Pi 默认运行在启动它的用户权限边界里，不是沙箱，也没有完整内建权限系统。因此 SDK 优先不等于把 Pi 直接裸跑进不受控产品环境。

PiGUI 的安全边界分层处理：

- 本地桌面个人使用：后端可在本机 `utilityProcess` 中使用 SDK driver，但高风险工具、写文件和命令执行仍要进入产品侧 permission/profile 设计。
- 本地增强隔离：可把工具执行或整个 runtime 放入容器、micro-VM、policy sandbox，driver 仍通过 Gateway API 对前端保持不变。
- 云端或团队部署：不能在多租户宿主机裸跑 Pi Runtime；需要每 workspace 独立 runtime/sandbox、产品用户认证、provider 凭据分离存储、审计事件、secret redaction、限流和清理策略。

## Consequences

- `packages/core` 应逐步承载 PiGUI Runtime Gateway 的稳定契约，而不是继续把 `PiRpcCommand` / `PiRpcRawEvent` 当长期公共 seam。
- `packages/backend` 拥有 `PiRuntimeDriver` 和 runtime orchestrator；driver 负责 SDK/RPC 细节，orchestrator 负责 Session Projection 同步、event envelope、sequence、恢复、错误归因和审计。
- `apps/desktop` 当前 MessagePort transport 保持可用；未来 `apps/server` 可以实现 WebSocket transport，但业务协议不变。
- 现有 RPC bridge 是可保留的实现资产，但它需要被下沉为 `PiRpcProcessDriver`，而不是继续定义前端-facing API。
- SDK driver 已完成 backend-only spike，并进入 Electron backend 的默认 Runtime Gateway driver。`createBackendService()` 默认组装 `PiSdkDriver` + public Pi SDK `AgentSession` adapter；renderer、Electron IPC 和 Runtime Gateway API 不变。真实 Pi SDK / 模型调用仍不进入常规测试默认路径，测试通过 SDK 边界 mock 或 opt-in spike harness 验证；RPC transport 继续保留给 `start_pi_rpc_runtime` / `send_pi_rpc_command` / `stop_pi_rpc_runtime` 以及显式注入的 fallback driver。SDK 原始 state/event 只作为证据来源；如果 SDK 能力存在但不能稳定映射到 Gateway envelope、event order、message identity、session identity 或 snapshot 字段，应记录为 capability 缺口，而不是临时污染 Gateway contract。
- SDK spike 不修复 Live Chat 重复消息问题，不修改 Projection 去重策略，也不修改 `PiRpcProcessDriver`。spike 只记录 SDK 是否提供稳定 message id、turn id、event phase、final/delta 信号和可映射的 event identity；这些证据用于后续单独设计 Gateway/Projection 的 message identity 与去重规则。
- 第二轮 SDK capability spike 已补齐 backend Gateway 映射检查：Queue/Steer/Stop、model/thinking、resource/auth 注入、retry/compaction/error 事件都先落在 SDK adapter 和 driver contract tests；真实 opt-in run 已确认 `usage/cost` 可进入 Runtime Gateway snapshot summary。仍不能把 SDK public API 直接等同于产品能力：Queue withdraw 没有稳定 SDK queued id，Steer/Stop 的长流语义尚未 opt-in 验证，Extension UI request 还缺 Runtime Gateway 协议，SDK crash/restart 也不是 RPC subprocess recovery 的同一问题。
- 测试体系要分层：Gateway protocol 契约测试、FakePiRuntime 状态机测试、SDK/RPC driver 兼容测试、以及固定 Pi 版本线的集成冒烟。

## Supersedes

本文取代 `docs/research/pi-integration-options.md` 里“Pi Runtime Bridge 首先用 RPC 子进程实现，SDK 第二阶段验证”的推荐结论。该调研仍保留为历史背景，尤其是 ACP 取舍、并发 worktree、monorepo cwd 和 Execution Checkout 规则仍然有效。

## 2026-09-13：进程内子会话观测

桌面以 SDK driver 为主路径。Tintinweb 插件通过版本化的 `subagents:host:ready` 接口向后端注册所属根会话的 provider；Pace 订阅插件已经创建的子会话，使用同一套 Normalizer、Gateway sequencer 与 Journal 记录轨迹，不重复创建或绑定子会话。

`get_subagents` / `get_subagent_snapshot` 提供状态和回放，`stop_subagent` / `steer_subagent` 按根会话限定控制范围。子会话有独立事件身份，不写入根会话消息模型或新增侧栏投影；根流中的 `subagent_record` 仅携带所属关系和状态。正常退出发出一次 SDK `session_shutdown` 并等待清理；异常重启把未完成观测记录标为 interrupted。详细契约见 [子代理观测](../subagent-observation.md)。
