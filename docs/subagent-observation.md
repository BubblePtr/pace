# 子代理运行与生命周期

Pace 管理根 Session 及其独立进程；子代理插件管理内部子会话。主 Agent 通过插件工具派发、继续或取消任务，用户在主会话里读取调用和结果。当前不提供专用 Subagents Dock、逐节点费用或全树实时 Trace。设计依据见 [ADR-0040](adr/0040-root-session-process-isolation.md)。

## 原版插件

验证基线为 Pi SDK 0.84.3 与 Tintinweb 0.19.0，上游 commit `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`。在 Packages 中使用上游来源即可，不再要求 BubblePtr fork 或 `subagents:host:ready` 协议：

```text
git:github.com/tintinweb/pi-subagents@e955e29c51b7a6cce37e1108cd2d6c57a77e151c
```

已有 fork 的安装来源不会被自动改写。更换来源后在新启动的会话生效；不要同时加载两个注册同名 Agent 工具的版本。

## 生命周期

- 每个启动的根 Session 有独立进程，加载扩展前确定自己的 cwd。项目 `.pi/agents` 与插件全局变量不在多个根会话之间混用。
- 插件决定子会话何时创建、是否在任务完成后保留、何时释放。父轮次结束和切换页面不会停止后台任务。
- 主会话 Stop 沿用 Pi 的 abort。取消后台子代理通过主 Agent 使用插件自身的工具完成，不承诺 Stop 能停止所有插件任务。
- 删除根 Session 或退出应用时，Pace 触发 Pi 的 `session_shutdown`，让插件正常清理，再结束根进程。超时强制终止会记录为中断。
- 主会话总用量采用 Pi 统计，包含插件主动上报的工具用量；插件没有上报的费用不会被猜测补入。

## 历史

独立 Trajectory 页扫描 Pi 会话目录中的 JSONL，不要求拿到插件的 Session 对象。只要子会话保存到扫描范围内，就能作为普通 Pi 会话回放。Tintinweb 默认保存一级子代理会话，嵌套默认使用内存；配置可以覆盖。内存会话、扫描目录之外的文件和临时 `.output` 文件不会自动成为 Trajectory 历史。

选中父会话里的 `Agent` 步骤时，Inspector 可提供「Open child session」：Pace 用 tintinweb 映射把插件 `id` / `sessionFile` 和父 `toolCallId` 收成隐藏的 `SubagentRecord`（`AgentRuntimeEvent` `type: "subagent"`，`surface: "hidden"`），不进 Live Chat、也不多出 Trajectory 行。子 JSONL 不在 `list_sessions` 中时按钮禁用，不是错误。CLI 录制的父 JSONL 在 `get_session_detail`（`workspace/sessions.ts`）里走同一映射的冷扫描，记录挂在 `SessionDetail.subagents` 上返回。仍不提供 Subagents Dock、逐节点费用或子会话实时 Trace。

## Control

`send` 和 `stop` 是记录上的可选能力。Runtime Gateway 提供 `send_subagent` / `stop_subagent`（参数为根 `sessionId`/`piSessionId` 加 `childSessionId` 或 `sourceAgentId`），错误形状与 `steer_run` / `stop_run` 相同。未广告该能力时拒绝，不调用 shim。父会话 Stop 仍只 abort 当前 Active Run（ADR-0040），不会级联停止子代理。

Stop 走文档化的 `subagents:rpc:stop`，因此活记录仅在 `pi.events.emit` 可用时广告 `stop: true`。

Send **只**走 tintinweb 的 in-process 注册表 `globalThis[Symbol.for("pi-subagents:manager")]` 上的公开函数，不读 `record.session`，不改 `pendingSteers`，也不向不存在的 `subagents:rpc:steer` 发事件。当前上游注册表只导出 `waitForAll` / `hasRunning` / `spawn` / `getRecord`，所以 tintinweb 记录今天只广告 `stop`。一旦上游挂上下列签名，Pace 零改动即可广告并路由 `send`：

```ts
steer(id: string, message: string): boolean
resume(
  id: string,
  prompt: string,
  signal?: AbortSignal,
  options?: { isBackground?: boolean },
): Promise<unknown>
```

- 未结束的子会话：`send: true` 当且仅当 `typeof manager.steer === "function"`；调用 `manager.steer(agentId, text)`。
- 已结束的子会话：`send: true` 当且仅当 `typeof manager.resume === "function"`；调用 `manager.resume(agentId, text, undefined, { isBackground: true })`。
- 注册表缺少对应函数时，shim 抛出 `tintinweb does not expose steer/resume on its registry`。

不复活 `subagents:host:ready`，也不由 Pace 生成子代理。已结束的子会话若 tintinweb 再次 `subagents:started`，shim 发 `phase: "update"`，UI 不伪造该跃迁。冷 JSONL `fromSession` 不广告控制。

Trajectory Inspector 在记录广告对应能力、且状态说得通时显示 “Send to child” / “Stop child”。该页接入 runtime model 的 `subagentsByOwnerToolCallId`（slice 1 的 live follow-up），与冷扫描合并，live 覆盖 cold。

## 验证

```sh
bun run typecheck
bun run test
bun run build
bun run test:bundled-runtime
PACE_TEST_TINTIN_SUBAGENTS_DIR=/absolute/path/to/original/pi-subagents bun run test:e2e e2e/smoke/extension-runner.spec.ts
```

原版目录需要安装自身依赖。测试使用隔离配置和本地可控模型，前后校验插件文件未变，覆盖 API Key / Codex OAuth、项目级代理定义、后台父子并发、插件取消、根会话隔离、删除和正常退出。安装包回归使用同一测试并设置 `PACE_E2E_EXECUTABLE`，详见[扩展运行与打包边界](extension-runtime.md)。
