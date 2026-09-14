# #304：历史读取与首次执行验证

2026-09-14，macOS ARM64，Bun 1.3.12。变更对应 [ADR-0021](../adr/0021-session-fork-resume-persistence-layering.md)。

## 行为与测试边界

- Gateway 冷读直接使用 Projection / Journal；Pi 文件、执行目录不可用、扩展初始化会抛错时仍返回已保存的消息。测试检查 `createAgentSession` / `bindExtensions` 未调用、缺失目录没有被创建。
- 初始化并发使用可控闸门：两条不同命令共享一次准备，等待期间历史仍可读；扩展失败共享同一错误并清理实例，重试只提交重试消息。历史最大 seq 为 42 时，新事件续接 43、44，Pi user-message identity 延续已有计数。
- Renderer 合并快照读取期间的增量，保护较新的运行事件。真正的冷快照清除退出进程遗留的流式状态；旧失败和中断不决定新 run 的状态。提交等待锁定输入，切换会话后再次点击不重发，失败保留草稿。
- Electron 使用真实后端、根会话进程与打包的 Pi SDK；模型端点是本机可控 SSE 服务，扩展记录加载、`session_start`、`input` 及 PID。连续浏览三个冷会话、重启后读取消息和工具记录，扩展日志和模型请求均为空。首次发送读取 Pi JSONL 中的历史上下文，只产生一次请求和一次扩展初始化；流式响应暂停期间切换会话，再返回继续接收，原进程保持不变。窗口重载也不重复初始化。
- 既有 M1–M4 Electron 回归覆盖归档、后端重启、Changes / Dock 和模型切换恢复。插件任意后台任务的兼容性仍遵循 ADR-0040，本测试不替代每个插件的专项验证。

关键行为先观察失败再实现；不为文案或字段映射另写镜像测试。并发测试不使用固定 sleep。

## 耗时记录

一次本机 Vite 开发 renderer + Electron 验证的输出：

| 阶段 | 耗时 | 测量范围 |
| --- | ---: | --- |
| 后端已就绪的冷历史读取 | 2.9 ms | `get_runtime_snapshot` 往返，含 IPC / Playwright 调用 |
| 重启附近的两次冷读取 | 90.3 / 145.7 ms | 同一调用方式，包含后端恢复可用的等待 |
| 首次执行准备 | 323 ms | 点击 Send 前至 Pi 扩展 input hook，包含 UI、IPC、Pi 恢复及扩展初始化 |
| 已存活实例快照 | 6.3 ms | 快照与 Journal 读取往返 |

这些是小型本地夹具的单次分段观测，不是性能目标，也不能推导出真实项目插件或模型端点的耗时。首次执行计时截止于模型请求之前；受控流式等待不计入该阶段。

## 复现

```sh
bun run test
bun run build
bun run test:e2e e2e/smoke/m1-fixture-free.spec.ts --workers=1
bun run test:e2e e2e/smoke/lazy-session-history.spec.ts
```

实际开发页面验证使用两个终端：

```sh
bunx vite apps/desktop --config vite.config.ts --host 127.0.0.1 --port 1420
```

```sh
PACE_HISTORY_RENDERER_URL=http://127.0.0.1:1420 bun run test:e2e e2e/smoke/lazy-session-history.spec.ts
```

测试输出 `history_read` / `first_execution_prepare`，并生成 `cold-history.png`、`first-execution.png` 和 `session-timing` 附件。截图位于 `test-results/` 对应测试目录，不提交临时图片。

本次结果：单元测试 134 个文件、1,444 项通过；构建退出码 0；上述两个 Electron 测试文件共 8 项通过。开发页面截图检查了历史消息、工具摘要、可用的模型选择器，以及首次执行后衔接的新消息。
