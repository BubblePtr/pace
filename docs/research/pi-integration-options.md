# Pi 集成路线调研

Created: 2026-06-25
Status: research, partially superseded

> 更新（2026-06-29）：本文写于 Tauri 时期。外壳此后迁至 Electron（见 ADR-0013），宿主进程已是 Node，因此正文中"Tauri 进程""Tauri/Rust 与 Node runtime 边界"等措辞按"PiGUI 主进程 / Node 运行时"理解；进程隔离的结论不变。下方已就地修正主要措辞。
>
> 更新（2026-06-29，2026-09-18 修订）：接入策略已由 [ADR-0018](../adr/0018-runtime-gateway-api-and-pi-drivers.md) 取代，固定 PiGUI Runtime Gateway API。本文第 6 节“Pi Runtime Bridge 首先用 RPC 子进程实现，SDK 作为第二阶段”的建议已被反转：Pi SDK driver 是唯一生产路径，RPC 子进程 driver 自 [ADR-0021](../adr/0021-session-fork-resume-persistence-layering.md) 起冻结，进程隔离由 [ADR-0040](../adr/0040-root-session-process-isolation.md) 的根 Session 独立进程承担。本文关于 ACP 取舍、并发 worktree、monorepo cwd 与 Execution Checkout 的调研仍可作为背景参考。

PiGUI 已决定从只读 Session Trace 工具转向 Agent Workspace Control Plane。这个转向要求 PiGUI 能创建、启动、停止、切换和观察 Pi agent 运行。当前有三条候选集成路线：封装 Pi CLI、通过 ACP、直接使用 Pi SDK。

## 事实层

- 本机 `pi` 版本为 `0.80.2`，npm 上 `@earendil-works/pi-coding-agent` latest 也是 `0.80.2`。
- Pi 官方包结构包含 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`。
- Pi 官方 SDK 文档明确把 SDK 用于 “build a custom UI (web, desktop, mobile)” 和 “embed pi in other applications”。
- Pi RPC mode 明确用于 “embedding the agent in other applications, IDEs, or custom UIs”，通过 stdin/stdout JSONL 提供 prompt、steer、follow_up、abort、new_session、switch_session、fork、clone、get_state、get_messages、get_commands、model/thinking/queue/compaction 控制。
- `pi-acp` 是社区 ACP adapter，latest 为 `0.0.31`。它通过 ACP JSON-RPC stdio 暴露给 ACP client，并在内部启动 `pi --mode rpc`。
- ACP 官方模型是 Client 与 Agent 之间的 JSON-RPC 协议，覆盖 session/new、session/load、session/resume、session/close、session/prompt、session/cancel、tool_call、usage_update、slash commands、session config options、client filesystem/terminal capability 等。

## 方案 A：封装 Pi CLI

这里的 CLI 封装有两种层级：

1. 终端封装：PiGUI 启动 `pi` 交互式 TUI，把它嵌在终端 pane 里。
2. 结构化 CLI 封装：PiGUI 启动 `pi --mode rpc` 或使用 Pi 自带 `RpcClient`，把 Pi 当子进程协议服务。

终端封装最像 “GUI 里的 terminal launcher”。它能最快保留 Pi 原生行为，但 PiGUI 很难可靠拿到结构化状态、工具调用、队列、模型、session replacement 和错误语义。它适合做第一天的 “Open in terminal / Attach terminal”，不适合作为 Control Plane 主接口。

结构化 CLI 封装实际已经接近 “RPC route”。它保留进程隔离，减少把 Pi runtime 拉进 PiGUI 主进程的风险，同时能拿到足够多的控制面命令。缺点是 PiGUI 要处理子进程生命周期、JSONL framing、stdout/stderr、版本漂移、崩溃恢复和多 workspace 并发。

## 方案 B：ACP

ACP 的强项是标准化 agent-client 边界。它天然描述 “client owns UI, agent owns runtime” 的关系，并且有 session、prompt、cancel、tool_call、usage_update、config options、slash commands、filesystem、terminal 等 UI 需要的概念。如果 PiGUI 未来要变成通用 agent runtime host，ACP 是最有战略价值的统一抽象。

但对 Pi 来说，当前 `pi-acp` 不是 Pi 的官方内核接口，而是社区 adapter；其 README 说明它内部仍然启动 `pi --mode rpc`。它也声明了限制：没有 ACP filesystem delegation，没有 ACP terminal delegation，MCP servers 只接受并存到 session state、未接入 Pi；assistant streaming 目前走 `agent_message_chunk`，没有单独 thought stream。

所以 ACP 更适合作为 PiGUI 的 “未来多 agent client protocol”，不适合作为第一版 Pi workspace control 的唯一底座。否则 PiGUI 会先受制于 adapter 覆盖度，而不是直接拿 Pi 的完整语义。

## 方案 C：直接集成 Pi SDK

SDK 是能力最完整的路线。`AgentSession` 暴露 prompt、steer、followUp、abort、sendUserMessage、sendCustomMessage、model/thinking/queue/compaction、bash、session stats、export、session name、context usage、active tools、extension binding 等；`AgentSessionRuntime` 暴露 newSession、switchSession、fork、importFromJsonl 和 dispose。它和 Pi CLI 使用同一 runtime 层，适合 PiGUI 做深度 GUI。

代价是 PiGUI 会直接承担 runtime ownership：Node 依赖、Pi 版本锁定、把 Pi 嵌进 PiGUI 自己的 Node 进程（在 Electron 下意味着进 main 或 utilityProcess，而非保持独立子进程）、extension UI request 映射、project trust、安全边界、sandbox/permissions、崩溃恢复都要设计清楚。SDK 路线不是 “包装 Pi”，而是 “PiGUI 成为 Pi runtime host”。

## 对比

| 维度 | CLI 终端封装 | Pi RPC 子进程 | ACP | Pi SDK |
| --- | --- | --- | --- | --- |
| 上手速度 | 最高 | 高 | 中 | 中 |
| 结构化状态 | 低 | 高 | 高 | 最高 |
| 控制能力 | 低 | 高 | 取决于 adapter | 最高 |
| 进程隔离 | 高 | 高 | 高 | 低到中 |
| Pi 语义完整度 | 高但不可结构化 | 高 | 中，受 adapter 限制 | 最高 |
| 多 agent 潜力 | 低 | 低 | 最高 | 低 |
| PiGUI 实现复杂度 | 低 | 中 | 中到高 | 高 |
| 主要风险 | GUI 只是 terminal 外壳 | 协议/进程管理 | adapter 覆盖不足 | PiGUI 变 runtime host |

## 建议

> 本节推荐已由 [ADR-0018](../adr/0018-runtime-gateway-api-and-pi-drivers.md) 取代；以下内容按 2026-06-25 的历史判断阅读。

首版 Agent Workspace Control Plane 不建议走纯终端封装，也不建议把 ACP 作为 Pi 的唯一底座。

推荐路线是两层架构：

1. **Pi Runtime Bridge 首先用 RPC 子进程实现**：PiGUI 通过 `pi --mode rpc` 或 Pi 自带 `RpcClient` 管理 Pi 进程，获得启动、停止、状态、prompt、steer、follow_up、abort、model、thinking、session switch/fork/clone 等控制能力，同时保持 Pi 与 PiGUI 的进程隔离。
2. **PiGUI 内部抽象区分 Runtime 与 Model**：首版 Runtime 只有 Pi；Model/provider 是 Pi session 内的可选配置维度。workspace、session、prompt turn、tool call、usage update、config option、slash command、cancel 等命名可以参考 ACP，但不承诺接入其他 agent runtime。

SDK 应作为第二阶段验证：当 PiGUI 需要更深的 extension UI、tool registry、custom tool rendering、agent state mutation 或更细粒度 runtime hooks 时，再把 Pi Runtime Bridge 从 RPC 替换为 SDK。这个替换值得单独 ADR，因为它会改变 PiGUI 的安全和崩溃边界。

## Codex 并发模型参考

Codex app 的并发不是把多个 agent 都放进同一个可写目录里，而是把任务建模为并行 thread，并让每个 thread 运行在明确的执行环境中：

- Codex app 支持在一个窗口里跨项目运行多个 thread。
- 新 thread 可以选择 Local、Worktree 或 Cloud；Local 和 Worktree 都运行在用户电脑上。
- Worktree 模式用 Git worktree 隔离同一项目里的并行任务，让不同 thread 可以 side by side 工作而不干扰前台 checkout。
- Codex-managed worktree 通常 dedicated to one thread；默认创建在 `$CODEX_HOME/worktrees`，并通过保留数量和归档清理控制磁盘占用。
- 每个 thread 有 scoped terminal，作用域是当前 project 或 worktree。
- Codex subagents 是另一层并发：一个主 thread 可以显式 spawn 多个 subagent，Codex 负责等待、汇总和关闭子线程；默认有 concurrent thread cap。

对 PiGUI 的启发：

- `Agent Workspace` 应该允许多个并发 `Agent Run`。
- 每个 `Agent Run` 应拥有一个 Pi RPC 子进程和一个明确的 `Execution Checkout`。
- 在 Git repo 中，后台/并行 run 默认应使用 PiGUI-managed Git worktree；Local checkout 应保留给前台 run 或用户明确选择的 run。
- 不应把“多进程”实现成多个 Pi 进程同时写同一个 checkout，这会把冲突处理提前炸开。
- UI 不应在每次创建 run 时暴露大量生命周期选项；默认创建 managed disposable worktree，完成后通过少量出口动作处理：继续、handoff、create branch、PR、archive、promote to permanent。

## Monorepo Project 与 worktree cwd 调研

问题：如果 PiGUI Project 是 monorepo 子目录，比如 `/repo/apps/web`，后台 Session 创建 worktree 后，Pi Runtime 的 `cwd` 应该是 worktree 根，还是 worktree 内的对应子目录？

调研结论：

- **Git worktree 本身以 repository 为单位**。`git worktree add` 创建的是附属于同一个 Git repository 的另一个 working tree，不是某个子目录的 partial checkout。要减少大仓库体积，需要额外使用 sparse checkout 或工具自带配置。
- **Codex app 建议 monorepo 拆 Project**。Codex app 文档建议单个 repo 里有多个 app/package 时，把不同 project 分开打开，让 sandbox 只包含该 project 的文件。它的 worktree 文档强调 Local/Worktree 是线程执行环境，Worktree 隔离同一 project 的并行任务，但公开文档没有明确说明 monorepo 子目录 Project 在 managed worktree 中的 cwd 是否保持为对应子目录。
- **Zed 把 Project/worktree root 作为 opened root**。Zed 的 “worktree” 概念比 Git worktree 更宽，等同打开的文件或目录 root；Parallel Agents 文档支持一个 project 多个 root，也支持 linked Git worktree 隔离。Zed 新 worktree 的 task hook 会收到 `ZED_WORKTREE_ROOT` 和 `ZED_MAIN_GIT_WORKTREE`，说明它区分“当前执行根”和“主 Git worktree”。
- **Claude Code 明确支持从 monorepo 子目录启动**。从 `packages/api/` 启动时，Claude 的文件访问默认限制到该子树，并加载该目录及祖先的 `CLAUDE.md`；这能减少无关上下文。Claude worktree 文档也说明 worktree 默认按 repository 创建；大型仓库可用 `worktree.sparsePaths` 只 checkout 相关目录。但 Claude 还明确指出其 worktree 创建后 session working directory 是 worktree root，而不是启动子目录，因此它需要 root-level settings 来补偿 worktree 内的权限/deny 规则。

对 PiGUI 的建议：

PiGUI 不应该把这个暴露成用户每次创建 Session 时的选择。默认规则应该是：

1. Project 仍然等于用户选择的工作根目录，可以是 repo 子目录。
2. 如果 Project 在 Git repo 内，PiGUI-managed worktree 从 Git repo 根创建。
3. PiGUI 在 worktree 内计算 `projectRelativePath`，并把 Pi Runtime 的 `cwd` 设置为 `<worktreeRoot>/<projectRelativePath>`。
4. Git 操作、branch、diff、snapshot、cleanup 以 worktree 根为准；Pi 的 context/resource loading、prompt templates、project-local skills 和 session naming 以 Project 子目录 cwd 为准。
5. 如果一次 Session 需要跨 package 修改，用户不需要理解 cwd 细节；PiGUI 后续可以提供 “add related directory” 或把 Project 直接设为 repo root 的更高级入口。

这个选择比 “Pi cwd = worktree root” 更贴近 PiGUI 的 Project 概念，也更能保留 Pi 自身的 cwd-based resource loading。代价是 PiGUI 的 backend 需要同时保存 `repoRoot`、`projectRoot`、`projectRelativePath` 和 `executionCheckoutRoot`，并且 diff/terminal/Git UI 要清楚区分两套路径。

## 待验证问题

- PiGUI 是否需要在同一个 app 里同时运行多个 Pi session？如果需要，RPC 子进程 per workspace/per session 的资源模型要先压测。
- PiGUI 的 workspace 是否要提供自己的 terminal/filesystem capability，还是继续让 Pi 本地工具直接读写执行？
- PiGUI 是否要支持非 Pi agent？当前答案是否定的：PiGUI 只支持 Pi Runtime；需要避免的是把 Pi 的多模型能力误建模成多 agent runtime。
- PiGUI 是否需要展示 thinking stream？ACP 当前通用模型不保证单独 thought stream，而 Pi RPC/SDK 能保留更丰富的 Pi 原生事件。

## 参考

- Pi repo: https://github.com/earendil-works/pi
- Pi SDK docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Pi RPC docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- Pi usage / trust docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
- pi-acp: https://github.com/svkozak/pi-acp
- Agent Client Protocol: https://agentclientprotocol.com/get-started/introduction
- ACP session setup: https://agentclientprotocol.com/protocol/v1/session-setup
- ACP prompt turn: https://agentclientprotocol.com/protocol/v1/prompt-turn
- Codex app worktrees: https://developers.openai.com/codex/app/worktrees
- Zed parallel agents: https://zed.dev/docs/ai/parallel-agents
- Claude Code worktrees: https://code.claude.com/docs/en/worktrees
- Claude Code monorepo / large codebases: https://code.claude.com/docs/en/large-codebases
- Git worktree: https://git-scm.com/docs/git-worktree
