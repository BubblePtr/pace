# 删除 Pi RPC driver 及其传输层

Pace 接入 Pi 的方式已收敛为进程内 Pi SDK：`PiSdkDriver` 运行在每个根 Session 的独立进程中（[ADR-0040](0040-root-session-process-isolation.md)）。[ADR-0018](0018-runtime-gateway-api-and-pi-drivers.md) 引入的第二条路径 `PiRpcProcessDriver`（子进程 `pi --mode rpc`，stdio JSONL）自 [ADR-0021](0021-session-fork-resume-persistence-layering.md) 起冻结，此后没有任何非测试代码构造它。本 ADR 履行 ADR-0021 中“正式删除需单独 ADR”的约定，删除该 driver 及只为它存在的代码。

## Decision

删除以下内容，不保留兼容层：

- 后端 `drivers/pi-rpc-driver.ts` 与 `drivers/pi-rpc.ts`，以及 `packages/backend` 根入口对它们的导出。
- 组合根中的 `piRpc` 传输实例与 `start_pi_rpc_runtime` / `send_pi_rpc_command` / `stop_pi_rpc_runtime` 三条不经 Gateway 的调试直连；渲染层没有调用者。
- 渲染层 `shared/pi-rpc-transport.ts` 与 `entities/runtime/pi-rpc-runtime-bridge.ts`；`pi-runtime-factory.ts` 只保留两条分支：非 Electron 环境返回 in-memory bridge，Electron 环境返回 Runtime Gateway client。
- `packages/core` 的 `PiRpc*` 类型与 `createFakePiRpcTransport` 测试替身；仍需要的测试改用 SDK 路径的测试替身。

`PiRuntimeDriver` 接口与 Runtime Gateway API 不变：ADR-0018 关于“Gateway API 固定、Pi 接入细节收敛在 driver 内部”的分层继续有效，被推翻的只是“RPC driver 作为可切换后备”这一部分。

## 放弃的期权

ADR-0021 为 RPC driver 保留了两项期权价值：跟随用户本机 `pi` CLI 版本，以及 SDK 版本回归时的逃生通道。[ADR-0031](0031-bundled-pi-runtime-and-extension-compatibility.md) 已决定 Pi 引擎由应用内置、升级由维护者验证后发布，前一项期权不再有产品前提；后一项在 ADR-0031 的固定版本策略下由回退发布承担。两项期权都已失效，冻结代码只剩维护成本和误导读者的风险。

## 与 Pi 上游演进的关系

Pi 上游正在把 coding agent 拆成 server / session worker / presentation 三种 host（`@earendil-works/chord` facet 架构，`pi-protocol` / `pi-client` / `pi-server`，截至 2026-09 均标 experimental）。GUI 在该架构中是一种 presentation host。这与被删除的 stdio JSONL RPC 模式没有继承关系：若 Pace 日后接入上游服务协议，那是一个新的 `PiRuntimeDriver` 实现，需单独 ADR，本次删除不预设也不阻碍它。
