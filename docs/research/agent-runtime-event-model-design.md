# Agent Runtime Event Model 架构设计

> 现状（2026-09-18）：六个切片均已落地。第 9 节切片 5 提到的 `PiRpcProcessDriver` 已随 [ADR-0021](../adr/0021-session-fork-resume-persistence-layering.md) 冻结，不再是生产路径；“renderer 侧 `pi-rpc-runtime-bridge` 是浏览器 fallback”的描述也已过时：`pi-runtime-factory.ts` 在非 Electron 环境返回 in-memory bridge，Electron 下走 Runtime Gateway client，`pi-rpc-runtime-bridge` 只在测试显式注入 transport 时使用。

> 基于 `agent-runtime-event-model-handoff.md` 的 grilling 结论。每个决策点标注了 **[已定]**（代码证据可直接定案，或 2026-07-02 用户已确认）或 **[待确认]**（推荐方案已给出，等用户拍板）。

## 1. 从代码确认的事实（不再是开放问题）

勘探对象：`@earendil-works/pi-agent-core@0.80.2`、`@earendil-works/pi-ai@0.80.2` 的类型定义，以及当前 `pi-sdk-runtime-adapter.ts`、`session-projection.ts`、`runtime-gateway.ts`。

1. **agent-core 没有原生 message id。** `UserMessage` 只有 `role/content/timestamp`；`AssistantMessage` 只有可选 `responseId`（provider 响应 id，retry 后会变）。messageId 必须由 normalizer 生成，生成规则必须是契约。
2. **唯一原生稳定 identity 是 `ToolCall.id` / `ToolResultMessage.toolCallId`。** tool 匹配键直接用原生 id。
3. **run/turn 没有 id，但有结构化边界事件。** `AgentEvent` 提供 `agent_start/agent_end`（一次 active run）、`turn_start/turn_end`（一次 turn）、`message_start/update/end`（一条 message）。runId/turnId 可以由 normalizer 确定性推导。
4. **partId 有天然来源。** `AssistantMessageEvent` 每个流式事件都带 `contentIndex`（part 在 message content 数组中的下标）。
5. **tool args 有两条路径。** message 流内的 `toolcall_end`（含 `toolCall.arguments`，先到）和 `tool_execution_start`（含验证后的 `args`，message_end 之后到）。

### 顺带发现的三个现存缺陷（本设计要顺手消灭）

- **O(n²) wire 流量**：`pi-sdk-runtime-adapter.ts` 对每个 `text_delta` 都以 `bodyFormat:"full"` 重发累积全文。长回答的传输量和序列化开销随长度平方增长。
- **任意 status 事件把 Session 判成 completed**：`session-projection.ts` 的 `runtime-event-received` 分支把 `kind==="status"` 一律映射为 `status:"completed"`——一个 "Retrying"/"Compacting" status 会把正在跑的 Session 标记为完成。根因是 status 事件缺 `code`，projection 只能按 kind 猜。
- **O(n) upsert 扫描**：`upsertRuntimeEvent` 每个事件线性扫描 `runtimeEvents` 数组找 identity，事件多时整段回放是 O(n²)。

## 2. 术语决定

### Active Run（协议 `runId` 的所指）**[已定，2026-07-02 确认]**

CONTEXT.md 现有 **Agent Run** = "一次可运行、可停止、可观察的 Pi Runtime 实例"（进程/Session 级）；而 Steer/Queue/Session Status 词条里已经在用 "active run" 指一次 prompt 触发的 agent loop 执行。两个 "run" 不是一个东西。

**决议**：新增术语 **Active Run** = 一次 prompt/steer 恢复/queued follow-up 触发的 agent loop 执行，边界来自 agent-core `agent_start`→`agent_end`。协议字段 `runId` 指 Active Run；协议中不使用 "Agent Run"（保留其 runtime 实例语义）。已写入 CONTEXT.md（Active Run、Turn 两条，并在 Agent Run 的 Avoid 中加入 active run 防混淆）。

### Turn

一次 model response + tool execution 循环，边界来自 `turn_start`/`turn_end`。一个 Active Run 包含 ≥1 个 Turn。

### Surface

协议告诉 UI 事件归属的渲染面：`chat | trace | status | composer | hidden`。路由规则属于协议（packages/core），不属于 page component。

## 3. 架构总览

**决策：AgentRuntimeEvent 是定义在 `packages/core` 的单一契约，作为 Gateway envelope 的 payload 类型；backend normalizer 是唯一的语义归一点。**[已定，2026-07-02 确认]

```
Pi SDK AgentSessionEvent ─┐
Pi RPC raw event ─────────┤（能力缺口显式标注 origin:"rpc"）
                          ▼
   agent-runtime-event-normalizer（packages/backend，纯函数状态机）
                          ▼
        AgentRuntimeEvent（packages/core，唯一契约）
                          ▼
   Runtime Gateway sequencer：envelope{ id, seq, sessionId, piSessionId, ts,
                                        payload: AgentRuntimeEvent }
                          ▼
        MessagePort（今）/ WebSocket（未来 apps/server）
                          ▼
   gateway-client（apps/desktop）：只做 envelope 解包 + seq 缺口检测，不再二次映射
                          ▼
   session-projection：按协议 identity upsert 出结构化 query model
                          ▼
   agent-workspace：chat/trace/status 各自渲染对应 surface，零边界推断
```

理由：ADR-0018 已明确 "packages/core 应逐步承载 Gateway 稳定契约"；语义归一只发生一次，未来 Web/mobile 客户端、断线重放、审计、持久化吃同一套协议。`PiRuntimeEvent` 只在迁移期作为兼容映射存在，迁移完成后删除。

driver/gateway 保持薄：session 生命周期、命令转发、seq、snapshot、恢复。normalizer 承担全部 UI 语义映射，且是**纯同步状态机**（输入 raw event，输出 0..n 个 AgentRuntimeEvent），便于 fixture 驱动的契约测试。

## 4. 协议设计

```ts
// packages/core/src/agent-runtime-event.ts

export type AgentRunPhase = "start" | "update" | "end";
export type AgentBodyMode = "delta" | "snapshot";
export type AgentSurface = "chat" | "trace" | "status" | "composer" | "hidden";
export type AgentEventOrigin = "sdk" | "rpc";

export type AgentMessagePartType = "text" | "thinking" | "tool_call";

export type AgentRuntimeEvent =
  // —— message 生命周期（不携带正文，正文走 message_part）——
  | {
      type: "message";
      runId: string;
      turnId: string;
      messageId: string;
      role: "user" | "assistant";
      phase: "start" | "end";
      // phase:"end" 携带最终 parts 快照，作为该 message 的权威内容
      parts?: AgentMessagePartSnapshot[];
      // retry 中断的 partial message 以 abandoned:true 显式闭合：
      // 消费端永远不会残留 dangling streaming state，但该内容不是最终回答
      abandoned?: boolean;
      surface: "chat";
      origin: AgentEventOrigin;
    }
  // —— part 级流式更新（高频路径，delta 优先）——
  | {
      type: "message_part";
      runId: string;
      turnId: string;
      messageId: string;
      partId: string;          // `${messageId}:part-${contentIndex}`
      partType: AgentMessagePartType;
      phase: AgentRunPhase;
      bodyMode: AgentBodyMode; // update 用 delta；start/end 用 snapshot
      body: string;            // delta 片段或完整快照
      toolCallId?: string;     // partType === "tool_call" 时必填
      surface: "chat" | "trace"; // text → chat；thinking/tool_call → trace
      origin: AgentEventOrigin;
    }
  // —— tool 执行生命周期（与 message 内 tool_call part 用 toolCallId 关联）——
  | {
      type: "tool";
      runId: string;
      turnId: string;
      toolCallId: string;
      phase: AgentRunPhase;
      name: string;
      args?: unknown;
      result?: unknown;        // phase:"update" 为 partialResult，"end" 为终值
      isError?: boolean;
      surface: "trace";
      origin: AgentEventOrigin;
    }
  // —— run/turn 边界（projection 状态机的输入，不渲染成气泡）——
  | {
      type: "run";
      runId: string;
      phase: "start" | "end";
      trigger: "prompt" | "steer" | "follow_up" | "unknown";
      outcome?: "completed" | "aborted" | "failed";
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "turn";
      runId: string;
      turnId: string;
      phase: "start" | "end";
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  // —— 带语义 code 的状态事件 ——
  | {
      type: "status";
      runId?: string;
      code:
        | "retrying" | "retry_succeeded" | "retry_failed"
        | "compacting" | "compaction_done"
        | "runtime_unavailable" | "first_token_timeout"
        | "model_changed" | "thinking_level_changed";
      body?: string;
      surface: "status" | "composer" | "trace" | "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "error";
      runId?: string;
      turnId?: string;
      code: string;
      body: string;
      surface: "chat";
      origin: AgentEventOrigin;
    }
  | {
      type: "usage";
      runId: string;
      summary: Partial<RuntimeGatewaySummary>;
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "queue";
      steering: string[];
      followUp: string[];
      surface: "hidden";
      origin: AgentEventOrigin;
    };
```

设计要点：

- **phase 与 bodyMode 分离**（brief 建议，采纳）：`phase` 只表达生命周期 `start|update|end`；`bodyMode` 只表达内容编码 `delta|snapshot`。旧 `partial|delta|final` 三态废弃。
- **message 事件不携带流式正文**。正文全部走 `message_part`，`message(end)` 携带最终 parts 快照作为权威内容。这样高频路径（delta）和边界路径（lifecycle）互不污染。
- **thinking 是 assistant message 的 part**（partType:"thinking"，同一 messageId/turnId），surface 路由到 trace。协议表达"同属一个 message"，UI 自由分面渲染——brief 开放问题按此定案。
- **`run`/`turn`/`usage`/`queue` 是 hidden 事件**：它们驱动 projection 状态机（Session Status、成本聚合、queue 面板），永远不渲染成 chat bubble。Session 完成与否由 `run(end).outcome` 决定，消灭"任意 status → completed"缺陷。
- **surface 由 normalizer 盖章**，但盖章规则实现为 core 里的一个纯函数路由表（`surfaceFor(event)`），单一事实来源；将来 UI 路由策略变化时，projection 可以用新版函数对历史事件重新推导。
- **边界永远显式闭合**（切片 1 TDD 中确立的契约）：retry 中断的 partial message 以 `message(end, abandoned:true)` 闭合（内容不是最终回答）；abort 时 open message 以普通 `message(end)` 闭合（内容保留可见，abort 不是 retry）；失败的 run 在 `run(end, outcome:"failed")` 前发 `error(code:"run_error")` 进 chat。toolResult transcript message 永远不产生 chat message 事件，只用于更新对应 tool 条目。

## 5. Identity 契约

| 字段 | 生成规则 | 来源 |
|---|---|---|
| `runId` | `{piSessionId}:run-{n}`，n = 该 session 已见 `agent_start` 计数 | normalizer 推导 |
| `turnId` | `{runId}:turn-{m}`，m = 该 run 内 `turn_start` 计数 | normalizer 推导 |
| `messageId` | assistant：`{turnId}:msg-{k}`，k = 该 turn 内 `message_start` 计数；user：Gateway 在命令接受时铸造 `{piSessionId}:user-{seq}` | normalizer / Gateway |
| `partId` | `{messageId}:part-{contentIndex}` | 原生 `contentIndex` |
| `toolCallId` | 原生 `ToolCall.id` | agent-core 原生 |

规则说明：

- **确定性**：所有推导 id 只依赖生命周期事件计数，不依赖时间戳或进程内随机数。同一 fixture 回放永远产出同一批 id——这是契约测试的断言基础。
- **重启恢复**：normalizer 的计数器状态（runSeq/turnSeq/msgSeq 高水位）随 projection 持久化；reattach 时从高水位续起，或从 Pi session messages 重放推导。**禁止**只靠进程内 index（这是现状 `assistant.index` 的缺陷）。
- **retry 语义**：`auto_retry_start/end` 发生在当前 run 内部，不产生新 runId；重试产生的新 assistant message 是同一 turn 内的新 messageId。
- **steer 语义**：steer 不结束当前 run；steer 的 user message 归属当前 runId。
- **queued follow-up 语义**：run 结束后 queue 弹出触发新 `agent_start` → 新 runId，`trigger:"follow_up"`。
- 若未来 agent-core 提供原生 message id，事件加 `idSource: "native" | "derived"` 平滑切换，不破坏消费端。

## 6. 性能设计

高频路径是 `message_part` delta。三层各管一段：

1. **Wire：delta 编码**。`text_delta`/`thinking_delta` 只传增量片段（`bodyMode:"delta"`），`part(end)`/`message(end)` 传快照兜底。消灭 O(n²) 传输。断线轻恢复走 seq 回放（delta 序列完整则累积无损）；重恢复走 snapshot 路径，不重放 delta。
2. **Projection：keyed upsert + 追加序**。查询模型用 `Map<messageId, …>` / `Map<toolCallId, …>` 存实体，另存一个按 seq 的 order 数组。delta 到达时对 part body 做字符串追加，O(1) 定位；替换现有 `upsertRuntimeEvent` 的线性扫描。
3. **渲染：只有 streaming 消息高频重渲**。历史 message 在 `message(end)` 后进入不可变快照，React 侧 memo 化静态 Markdown（PR #33 已有此分界，保留）；仅当前 streaming part 订阅高频更新，用 rAF 节流 flush（合帧属于 renderer 关切，不进协议）。

## 7. Projection 重构

Projection 不再存扁平 `PiRuntimeEvent[]`，改存结构化 query model：

```ts
type SessionRuntimeModel = {
  runs: Map<runId, { trigger; outcome?; startedAt; endedAt? }>;
  messages: Map<messageId, {
    role; runId; turnId; phase;
    parts: Map<partId, { partType; body; done: boolean; toolCallId? }>;
  }>;
  tools: Map<toolCallId, {
    name; runId; turnId; phase;
    args?: unknown;      // 合并规则见下
    result?: unknown; isError?: boolean;
  }>;
  statuses: Array<{ code; body?; runId?; at }>;
  order: Array<{ kind: "message" | "tool" | "status"; id: string; seq: number }>;
};
```

- **Upsert key 全部来自协议 identity**，projection 不再发明边界；`collapseAssistantRunMessages()` 删除（迁移期降级为旧事件 fallback，见 §9）。
- **tool args 合并优先级**（brief 开放问题定案）：tool 条目由 message 流内 `tool_call` part 创建（args 先到，可提前展示）；`tool(start)` 到达时用验证后的 args **覆盖**；result 只来自 `tool(update/end)`。即"后到的生命周期赢 args，result 只认执行事件"。
- Session Status 状态机只消费 `run`/`error` 事件：`run(start)`→running，`run(end, outcome:"completed"|"aborted")`→completed/waiting，`run(end, outcome:"failed")` 或 `error`→failed。status 事件不再影响 Session Status。

## 8. Surface 路由表（core 单一事实来源）

| 事件 | surface | UI 呈现 |
|---|---|---|
| message / message_part(text) | chat | Live Chat bubble（streaming 或 static） |
| message_part(thinking) | trace | Agent Trace timeline，挂在所属 message/turn |
| message_part(tool_call)、tool | trace | Tool item，按 toolCallId 合并 |
| status: retrying / compacting | trace + 瞬态 status chip | 不进 chat，不改 Session Status |
| status: runtime_unavailable / first_token_timeout | composer | composer banner，阻断输入侧预期 |
| status: model_changed / thinking_level_changed | status | 右侧摘要面板刷新 |
| error | chat | run 失败作为结果消息呈现（对齐"失败作为 Live Chat 新结果"的既有产品语义） |
| run / turn / usage / queue | hidden | 只驱动 projection |

**[已定，2026-07-02 确认]**：`retrying/compacting` 进 trace+chip、`runtime_unavailable` 进 composer banner。后续调整只改 core 路由表一处。

## 9. 迁移切片（每片独立可合、可回退）

1. **契约 + normalizer（不碰 UI）**：新增 `packages/core/agent-runtime-event.ts` 与 `packages/backend/agent-runtime-event-normalizer.ts`；用 agent-core 风格 fixture 覆盖六条流：纯文本、thinking+text、text→toolCall→toolResult→text、多 turn、retry、abort。断言完整 id/phase/surface 序列。
2. **SDK adapter 接入 normalizer**：`pi-sdk-runtime-adapter` 退化为"SDK subscription → normalizer"接线；在 gateway-client 加旧 `PiRuntimeEvent` 兼容映射，现有 UI 行为零回退（以现有 agent-workspace 测试为准）。
3. **projection 换输入**：`session-projection` 直接消费 AgentRuntimeEvent，重构为 §7 的结构化模型；`collapseAssistantRunMessages` 降级为兼容 fallback。
   - 实际落地形态（过渡期）：projection 同时持有 `runtimeEvents`（legacy，继续驱动现有 UI）和 `runtimeModel`（新结构化模型，`agent-event-received` 喂入，按 seq 去重）；bridge 契约新增可选 `subscribeToAgentEvents`，`session-creation` 双订阅。**模型见到 run 事件后即拥有 Session Status**，legacy status kind 不再翻转 status（"任意 status → completed" 缺陷对新模型会话已消灭）；旧 bridge（in-memory/RPC）没有新流时维持旧推导。切片 4 把 UI 切到 `runtimeModel` 后删除 legacy 流与扁平数组。
4. **page 简化**：agent-workspace 按 surface 渲染；删除兼容映射与 collapse。
   - 实际落地形态（过渡期）：`runtimeModel.runs` 非空即进入模型模式——chat/trace 完全从结构化模型渲染（text part → chat，thinking/tool → trace，abandoned 消息不进 chat）；旧 bridge 无 run 事件时走原 legacy 渲染路径。Gateway 铸造的 chat 事件（user echo、steer control、driver/renderer error）由 projection 镜像进模型（fractional seq 排序、不推进 agent seq 水位线）；compat 产物带 `derivedFromAgentEvent` 标记防止二次镜像。`collapseAssistantRunMessages` 已降级为 legacy fallback 专用；compat 映射与 legacy 流的物理删除推迟到切片 5（RPC driver 对齐）完成后统一清理。
5. **RPC driver 对齐**：`PiRpcProcessDriver` 映射到同一模型，能力不足显式标 `origin:"rpc"` + capability 缺口记录（沿用 ADR-0018 的缺口纪律）。
   - 实际落地形态：Pi RPC 模式把完整 `AgentSessionEvent` 流原样以 JSON lines 转发（证据：`rpc-mode.js` 中 `session.subscribe` 直通），与 SDK 是同一套事件——**两个 driver 共享同一个 normalizer**，仅 `origin` 不同；旧 RPC 专属映射删除。缺失生命周期的碎片事件（裸 `message_end`/`tool_execution_start`）被显式丢弃而非猜测边界。顺带补齐 `usage` 事件：normalizer 从 assistant `message_end` 的 usage 块发 hidden usage 事件，projection 合并进 summary（SDK/RPC 双路径的 token/cost 真相恢复）。
   - 仍存缺口（记录，不污染契约）：renderer 侧 `pi-rpc-runtime-bridge`（浏览器 fallback，不经 Gateway）仍是 legacy 流，走页面的 legacy 渲染路径；SDK 无原生 queued id 而 RPC 有 `withdraw_follow_up`，差异维持 ADR-0018 已记录状态。
6. **持久化与 replay**（后续独立设计）：projection 快照落盘；历史 session 直接加载 normalized projection，静态渲染，绝不重放 streaming。
   - 实际落地形态（2026-07-03 实现）：**Session Event Journal**——Gateway 在 emit 处把 normalized envelope 追加到 per-session 边界事件日志（内存缓冲 + `<dataDir>/sessions/<piSessionId>.jsonl` append-only 落盘）。过滤谓词 `shouldJournalRuntimeEvent`（core 单一事实来源）只排除 `message_part(update)` 流式 delta——其内容被 `part(end)`/`message(end)` 快照权威覆盖，这就是"绝不重放 streaming"的物理保证。`get_runtime_snapshot` 用 journal 填充协议中此前恒空的 `snapshot.events`（driver 只拥有 status/summary）。dataDir 解析沿用 agentDir 注入模式：`options.dataDir ?? env PIGUI_DATA_DIR ?? ~/.pigui`（不写 `~/.pi`，那是 Pi 的地盘）。
   - Renderer 侧：`stateFromSnapshot` 把 snapshot.events 按 Gateway seq 序构造混合 replay 序列（`PiSessionState.replay`：agent entry + Gateway 铸造的 chat 事件），projection 的 `runtime-state-resynced` 据此从零重建 `runtimeModel`（agent → `applyAgentRuntimeEvent`，chat → 既有 legacy 镜像；seq 去重天然幂等，user echo 借 fractional seq 保持在 Active Run 之前）。重建出的时间线全部 final，无 streaming 状态；无 replay 序列的旧 bridge 保持现有模型不动。
   - 范围界定（2026-07-03 确认）：本片交付 replay 通道本身；**重启后 sidebar 会话列表恢复（会话注册表持久化）另开切片**——renderer 侧目前没有 `getSessionState` 的调用方，reattach UI 接线属于注册表切片。
   - 记录的缺口：seq/normalizer 计数器水位的跨进程续起暂不需要——SDK 无 session resume，重启后旧 piSessionId 不会再有新事件（旧 journal 只读），新 session 是新文件；resume 落地时再从 journal 推导水位（数 run 事件即 runSeq），"禁止只靠进程内 index"的契约要求不变。journal 落盘失败不阻断 live 流（记录错误，内存缓冲不受影响）。

## 10. 决策记录

以下三项于 2026-07-02 经用户确认，全部按推荐方案定案：

1. **契约落点**：core 单一契约；`PiRuntimeEvent` 迁移期兼容、迁移完成后删除。
2. **术语**：新增 "Active Run"（协议 `runId` 所指），保留 "Agent Run" 的 runtime 实例语义；已更新 CONTEXT.md。
3. **status→surface 产品路由**：按 §8 表格执行。

遗留的低风险默认项（未单独拍板，按推荐执行）：`message(end)` 携带全量 parts 快照。首版桌面 MessagePort 场景保留全量快照，换取 replay/审计的简单性；未来低带宽 transport 可改为 hash/长度校验，属于可逆调整。

以下三项于 2026-07-03 经用户确认（切片 6 持久化与 replay）：

1. **持久化形态**：Gateway 侧 normalized 边界事件 JSONL（否决 materialized 模型快照——schema 演进即报废、丢事件级审计；否决 renderer localStorage——容量小且违背多客户端吃同一协议的方向）。事件日志 + 纯函数重放天然支持"用新版 core 路由函数对历史事件重新推导"。
2. **数据目录**：`~/.pigui` + `PIGUI_DATA_DIR` env 覆盖（沿用 `resolveAgentDir` 模式，Electron main 零改动）。
3. **切片范围**：不含重启后 sidebar 会话列表恢复；会话注册表持久化独立成片。

切片 2 发现的待决协议缺口（切片 3 处理）：**user message 与 runId 的时序矛盾**。协议中 `message` 事件的 `runId/turnId` 必填，但 Gateway 在命令接受时铸造 user message，此时 run 尚未开始。切片 2 的规避方式是 user echo 保留 legacy envelope 形状（不进新模型）；切片 3 让 projection 消费新模型时需要定案：放宽 user message 的 `runId/turnId` 为可选，或由 Gateway 在 `run(start)` 时回填归属。
