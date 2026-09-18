# apps/desktop 内部采用 FSD 分层

`apps/desktop/src` 从扁平结构改为 Feature-Sliced Design 的粗粒度分层。这是 [ADR-0015](0015-multi-app-monorepo.md) 里"每个 app 内部用 FSD"的具体落地。

## 层集（粗粒度，不切 segment）

```
apps/desktop/src/
├── app/                 # 入口 + 外壳 + 全站样式：main, app-shell, styles.css
├── pages/               # 路由级页面：agent-workspace, usage, trace, setup,
│                        #   session-detail, session-list
├── entities/            # 渲染层领域逻辑（视图侧），按领域粗切片
│   ├── session/         #   sessions, session-projection, session-creation,
│   │                    #     session-drafts, usage-aggregation, session-detail.fixtures
│   ├── runtime/         #   pi-runtime-bridge, runtime-gateway-client,
│   │                    #     in-memory-pi-runtime-bridge, pi-runtime-factory
│   └── checkout/        #   execution-checkout, execution-checkout-client
├── shared/              # 平台 adapter + 跨切面：runtime, refresh
├── test/                # vitest setup（基础设施，不属层）
└── fixtures/            # 浏览器/测试 fixture（基础设施，不属层）
```

**刻意不引入** `widgets` 和 `features` 层：它们要等 mega-module（如 1341 行的 `agent-workspace`）被切片时（仍推后）才自然产生，现在引入是空层。`entities` 用**粗切片**（session/runtime/checkout）而非把十几个文件平铺，也不再往下分 `ui/model/api/lib` segment——"既分层又不拆太细"的甜点。

## import 方向：只向下，经 `@/` alias

- 依赖方向：`app → pages → entities → shared → @pigui/core`，只向下，不反向。
- intra-app import 一律用 `@/<layer>/<slice>/<module>` alias（配在 tsconfig / vite / electron-vite），位置无关——文件在层间移动不破 import，测试可自由 co-locate。
- 跨包仍用 `@pigui/core` / `@pigui/backend` / `@pigui/core/testing`。

## Consequences

- co-located 测试随模块入层（`*.test.ts(x)` 紧贴被测模块）。
- 元测试中按路径读源码的字面量改为分层后路径。
- import 方向规则目前靠**约定**维持；如需强制可后续引入 `eslint-plugin-boundaries` / `steiger`，但未纳入本次。
- `entities/session` 的第二消费者（web）真开工时，可把渲染层领域逻辑抽成共享包（见 ADR-0015 的 mobile/RN 共享边界讨论）。
