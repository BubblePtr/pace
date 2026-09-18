# Session Fork/Resume 与双轨持久化分层

冷恢复（Resume）与对话分叉（Fork）进入产品边界后，必须先定死两份已经存在的落盘数据的分工：SDK driver 创建 session 时未传 `sessionManager`，Pi 默认已把每个 PiGUI session 持久化为 `~/.pi` 下的树形 jsonl（上下文真相）；切片 6 又建立了 PiGUI 自己的 Session Event Journal（`~/.pigui`，呈现真相）。不定死分工，fork/resume/analyze 每个后续能力都会把"该读哪份"重新争论一遍。

## Decision

**双轨真相，不可互换**：

- **Pi jsonl = 上下文真相**。冷恢复时 LLM 上下文永远由 Pi 自己重建（`SessionManager.open` + `buildSessionContext`，compaction/branch summary 都在其中）；PiGUI 永不自行拼装 LLM 上下文。
- **Session Event Journal = 呈现真相**。UI 时间线、run/turn identity、surface 路由、控制事件（steer/queue/retry/abort）只来自 journal 回放。**不做 Pi jsonl → AgentRuntimeEvent 合成器**：run/turn 边界在 jsonl 中根本不存在，Steer 在 jsonl 里与普通 user message 不可区分——合成即猜测，违背 ADR-0020 的确定性 identity 原则。

**打开历史与 Resume 分离**（[#304](https://github.com/BubblePtr/pace/issues/304)）。`get_runtime_snapshot` 对冷会话只读 Pace 的 Session Projection / Journal，不创建 AgentSession、不绑定扩展、不创建根会话进程，也不修复或创建执行目录；Pi 文件丢失不妨碍查看已保存的历史。对存活会话读取原实例并订阅实时事件，切换视图不改变运行生命周期。

**Resume 是首次执行前的 Gateway 能力**。冷会话的 `send_prompt`、`queue_follow_up`、`configure_model` 先从持久化 Projection 找到原 identity 和 Pi 文件，准备运行环境后再执行命令。同一 Session 并发操作共享一次初始化及其失败结果，命令仍按会话串行；失败可重试，已接受的消息不因随后元数据读取失败而重发。Stop / Steer / 撤回只作用于已有运行环境；历史、工具 schema 和模型目录查询不触发初始化。UI 在提交期间锁定当前输入，准备失败保留草稿和历史。

**实际启动的 runtime 保持存活**。按 [ADR-0040](0040-root-session-process-isolation.md)，每个已启动根 Session 有独立进程；插件可能保有定时器、子进程或长连接，因此不能把 idle 视为纯内存成本。后台任务由插件管理；切换视图、根 Agent 停止输出不会销毁实例。空闲驱逐不在本决策范围内。

**Fork = 从 user message 边界产生新 PiGUI Session**（新 piSessionId、新 journal、新 Execution Checkout、列表新行、谱系指回源），Pi 侧走 `createBranchedSession` 路径提取 + `parentSession` header，与 Pi TUI 自己的 fork 实现严格同构；被选中 user message 原文预填新 composer。树内 `navigateTree`（非线性历史）排除出产品边界。

**Fork 只 fork 对话，不 fork 磁盘**。Pi 上游 fork 同样无任何磁盘语义；"按工具调用记录 undo diff"不可行（bash 不可逆、write 不记录被覆盖的旧内容）。Git Project 下 fork **强制**新建 managed worktree（防止落进源 Session 的残骸目录，顺带天然还原 pre-fork 磁盘）；非 Git 复用前台目录并警告。消息边界磁盘快照（checkpoint 式时间旅行）显式归 v2。

**Journal 复制截断**。fork 时把源 journal 从头到 fork 点复制进新 journal：重写 piSessionId、按事件顺序重放计数确定性重铸 runId/turnId/messageId；时间线在 fork 点插入分隔标记（视觉锚点 + 跳回源 Session 的导航）。否决"读时回溯 parent 链"：它把复杂度长在冷恢复这条必须傻瓜可靠的读路径上，且 fork 语义已确认新 Session 是独立个体，历史就该是自己的副本。

**Identity 桥（SDK-only）**。Pi 事件流（SDK 与 RPC 同构）不携带 jsonl entry id，fork 需要 PiGUI messageId → Pi entry id 的桥：user message 边界事件产生时 adapter 进程内读 `sessionManager.getLeafId()` 盖进 journal payload——识别在事实发生的那一刻落盘；老 journal 缺字段时降级为 `getUserMessagesForForking()` 序号+文本匹配，含糊必须响亮报错。`piSessionId → session 文件路径` 在创建/恢复时采集并持久化进 Session Projection，`SessionManager.listAll()` 兜底修复。

**`resume_session` / `fork_session` 为 SDK-only Gateway 命令；RPC driver 冻结**。RPC 与 SDK 事件面同构，但命令面隔进程摸不到 SessionManager（无法注入、无法读 leaf、无法提取分支），新能力只补 unsupported stub + 记 capability 缺口，不追赶。保留 RPC driver 的期权价值：跟随用户本机 pi CLI 版本、SDK 版本回归的逃生通道。正式删除需单独 ADR（推翻 ADR-0018 一部分）。

> 后续（2026-09-18）：[ADR-0041](0041-remove-pi-rpc-driver.md) 已删除 RPC driver；上述期权价值随 ADR-0031 的内置引擎策略失效。

**Sidebar 历史列表只来自持久化的 Session Projection，且 Projection 只由 PiGUI 内创建的 Session 产生**。不扫 `~/.pi` 自动混入：外部 session 没有 journal/checkout/status，是幽灵行；与 Project Registry"手动添加、不自动发现"纪律一致；`listAll` 需全文解析所有 jsonl，启动性能不可接受。PiGUI 不提供 Pi CLI/TUI session import；需要在 PiGUI 继续外部工作时，用户在目标 Project 内新建 PiGUI Session，这与 Codex 的本地 thread 边界一致。

> 范围澄清（2026-09-05，[ADR-0031](0031-bundled-pi-runtime-and-extension-compatibility.md)）：不导入 CLI/TUI 会话是当前实现范围，不是永久产品原则。会话交接可后续单独设计；GUI 与终端同时操作同一个运行实例不作为当前架构前提。本次澄清不改变现有列表和持久化行为。

**Projection 随运行边界事件持续落盘**。Gateway 按 Session 串行写入状态、usage summary 与 `updatedAt`：prompt/steer/run-start 进入 running，run-end 进入 completed/failed，usage 合并累计摘要。Snapshot 查询不回写 Projection，避免查看改变列表时间或迟到读取复活已删除记录。Archive 也是 Gateway 持久化命令，active Session 必须拒绝归档；已归档状态不能被迟到事件覆盖。

**Journal replay 后的新事件序号必须续接历史最大 seq**。Gateway 在 resume/get snapshot 前先读取 journal 并推进 sequencer，再连接 driver；否则 backend 重启后的新事件会从 1 重新开始，被 renderer 的 replay 去重水位当成旧事件丢弃。

**订阅先于快照读取**。Renderer 合并读取期间收到的事件与 Journal，按 Gateway seq 去重排序；迟到历史不能覆盖更晚的 live run。冷快照将上次中断的 running 状态呈现为 failed，新运行的状态只由最新根 run 决定，不被历史失败或中断持续污染。历史读取不排队等待执行初始化或插件 input hook。

## Consequences

- `CONTEXT.md` 新增 Resume、Fork、Session Creation Boundary 词条。
- 普通 Session 创建的 checkout 策略改为用户显式选择（LOCAL/WORKTREE dropdown），废除"Project 已有 active session 即自动 worktree"的隐式决定；fork 是唯一强制 worktree 的入口。
- 批量打开冷历史不增加根会话进程；已启动实例仍需独立评估内存成本。历史读取和首次执行准备分别计时，验证见 [#304 验证记录](../verification/304-lazy-session-history.md)。
- 待办与切片见 `.scratch/session-fork-resume/issues.md`。
