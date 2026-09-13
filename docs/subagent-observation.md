# 子代理运行与观测

Pace 承载根 Pi 会话；Tintinweb 插件创建、调度和恢复进程内子会话。Pace 订阅已有子会话的公开 SDK 事件，不再次创建或绑定它们，不另起子代理 runner。

实施任务：[GitHub #302](https://github.com/BubblePtr/pace/issues/302)。设计和生命周期表见[集成规划](plans/tintin-subagents-and-observability.md)。

## 版本与启用

基线为 Pi SDK 0.84.3、Tintinweb 0.19.0（上游 commit `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`）。原版可执行进程内前台/后台任务；完整观测和根会话收束要求适配版的宿主协议 v1。

适配源码本次在独立的 `pi-subagents` 工作目录交付，尚未提交、推送或发布到 npm。不能将 npm 上的 0.19.0 当成支持本协议的版本。已构建的本地归档名为 `pi-subagents-0.19.0-pace-host-v1.tgz`，SHA-256 为 `6ef23e3ce7ccd9ddf3bd921ba4a1c55746334a47c1a6d9d9504f1f0c0e7cadfe`；这是交付文件的标识，包内仍保留上游版本号，并非新的上游发布。

本次不改写用户的全局扩展设置。试用时在独立 agent 目录或项目配置启用适配版，为新会话加载；同一会话避免同时加载两个注册同名 Agent 工具的子代理插件。卸载旧插件不会自动删除其历史。

## 宿主协议 v1

插件通过进程内 Pi event bus 发布 `subagents:host:ready`，载荷为 `{ version: 1, rootSessionId, provider }`。`rootSessionId` 是根 Pi 会话 ID；Pace 内联的宿主扩展只接受自己根会话的 provider。

- `snapshot()`：根下全部代理的序列化元数据，包括嵌套、Workflow 所属和已结束记录。
- `subscribe(listener)`：订阅 record 变化和 session 事件，返回取消订阅函数。session 事件同步发生在首次或恢复 prompt 之前，提供现有 `AgentSession`，不跨 IPC 传递对象。`released` 在插件淘汰并关闭子会话后通知宿主释放订阅；一次 run 结束不等于会话销毁。
- `stop(agentId?)`：取消单棵代理树；无 ID 时取消根下全部工作，停止入队并等待初始化和执行完成。
- `close()`：永久关闭所属根，取消任务并释放保留的子会话，可重复调用。
- `steer(agentId, message)`：可选定向消息能力。

记录带有根会话、代理 ID、父代理和触发工具调用关联；Pi 子会话 ID 与代理 ID 分开保存。记录使用插件给出的 cwd、model、thinking、当前工具和自身用量。临时子会话输出文件不作为展示历史的持久化依赖。

默认 `@agent` 模式创建的临时规划会话也纳入协议，以 `mention-planner` 记录展示。它在 prompt 前发布 SDK 事件源，支持初始化期取消、定向消息和真实用量；取消后不再执行迟到的 Agent 调用或 fallback。规划完成后，已经委派的正式代理继续归属于根会话；规划会话的结束与释放不会抹去其 ID 和 Trace。

## IPC 与历史

| 请求 | 参数 | 结果 |
| --- | --- | --- |
| `get_subagents` | `piSessionId`（根） | `available` 与 records |
| `get_subagent_snapshot` | 根 `piSessionId`、`agentId` | record、events、toolSchemas |
| `stop_subagent` | 根 `piSessionId`、`agentId` | 等待取消收束 |
| `steer_subagent` | 根 `piSessionId`、`agentId`、message | 定向消息 |

根流的隐藏 `subagent_record` 只更新观测树，不写入父对话消息。子事件使用独立 Pi ID 和派生的 Pace ID，复用 Normalizer、全局 Gateway sequence 与 Journal；不创建侧栏 Session Projection。客户端先订阅再取快照，按事件 ID/序号合并。

Journal 保存边界与最终内容，快照补充当前流式事件；真实 SDK 用户任务消息也进入子对话；每个工具开始事件保存公开工具 schema，运行中的输出标为 partial，直到真实结束事件才完成。再次打开面板或重启后可回放已记录内容，未完成历史转为 interrupted，缺失内容明确显示不可用。父会话统计只计算该会话的模型调用与压缩费用，插件通过 toolResult 上报的子费用不重复累加；子树各节点单独显示自己的用量。

## 生命周期与界面

父轮次结束和关闭 Dock 不影响后台子代理。父空闲但有活动子任务时，页面保留活动数量及 Stop all work；单个代理可停止其后代、向运行中的代理发送消息。取消与观测请求可在异步输入处理期间到达，避免等待首条用户消息而阻塞停止。归档拒绝仍有活动子代理的根会话；删除先释放运行态再移除投影。再次 attach 活跃根复用现有 SDK 实例，避免丢失管理器。

正常退出等待父子运行收束、发出一次 `session_shutdown`，然后刷写 Journal 和投影。子取消超过 15 秒报告未完成；整个应用退出最多等待 30 秒，随后记录强制中断。异常杀死后端无法保证执行 shutdown，重启后根据历史标为 interrupted，不自动重启子任务。

Dock 中的 Subagents 显示执行树，详情提供 Conversation 与 Trace。Trace 复用 Trajectory Ledger/Inspector 查看模型内容、工具参数、结果、错误和时间。父工具关联入口与 Parent agent/session 导航保持显式 ID 关系。未加载协议 v1 的插件会显示观测不可用。

## 验证

```sh
bun run typecheck
bun run test
bun run build
bun run test:bundled-runtime
PACE_TEST_TINTIN_DIR=/absolute/path/to/adapted/pi-subagents bun run test:e2e:packaged:mac e2e/smoke/subagent-observation.spec.ts
PACE_TEST_TINTIN_DIR=/absolute/path/to/adapted/pi-subagents bun run test:e2e:packaged:mac e2e/smoke/subagent-panel.spec.ts
```

模型回归使用隔离配置和本地 SSE 服务，闸门控制并发、read 与取消时点。认证回归见[扩展运行边界](extension-runtime.md)；模拟凭据不会验证真实账号登录、刷新令牌或发布签名。

2026-09-14 的实施验证：Pace 类型检查、137 个测试文件 / 1447 项测试、构建与两项打包产物测试通过；插件 lint、类型检查、109 个测试文件 / 2149 项测试通过（7 项跳过），构建通过。macOS arm64 未签名安装包的 12 项子代理运行回归和实际观测面板检查通过，覆盖 `@agent` 规划、项目隔离、嵌套、父子并发与取消、删除、正常退出、崩溃历史、两种 `reportUsage` 配置及刷新回放。

最终安装包的原版插件 API Key / Codex OAuth 两条路径、四项启动预检、真实终端和后端重启也通过。首次组合运行出现一次终端未显示键入字符的失败，后续未复现；仅加强 E2E 的明确输入目标、焦点与完整命令回显检查，并以非连续 marker 验证实际 shell 输出。没有修改终端产品逻辑，也不将该偶发失败宣称为已确认的打包故障。
