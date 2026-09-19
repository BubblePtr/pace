# Draft → Live 交接：一个 composer，只换状态

## 问题

提交 draft 后视觉很生硬：composer 像是换了一个组件，底部的 branch 选择器和模型选择器先消失再弹出。宣传视频里这是最关键的镜头。

根因（`apps/desktop/src/pages/agent-workspace.tsx`）：
1. `SessionDraftComposer` 和 `FullChatComposer` 是两个 `PromptInput` 实例，提交后前者卸载、后者挂载。现有 handoff 动画（`draftHandoff` state + `styles.css` 的 `[data-draft-handoff]` 块）只平移容器，内容硬切。宽度也不同：draft 容器 46rem，live 44rem。
2. live composer 的 footer（`composerFooter`：`GitBranchPicker` + `ContextUsageMeter`）挂在 `projection.piSessionId` 上，session 建好前不渲染，建好后整行弹出，composer 高度跳变。
3. live 的 `ModelSelectorControl` 依赖 `composerModelControls`，新 session 要等 `list_available_model_controls` 异步返回，选择器先消失再出现。
4. draft 的 `ProjectPicker` / `CheckoutStrategyPicker` 在 composer 外面下方；live 的 branch picker 在 composer 内部 footer。同类控件位置不一致。

## 目标状态

从提交到第一轮回复结束，用户看到的是同一个框在原地变状态：
- 宽度始终 44rem。
- footer 行始终存在，高度不变。draft 时装 Project + Checkout 选择器；live 时同一位置变成 Branch 选择器，右侧 context 环淡入。切换用 crossfade，不做布局位移。
- 模型选择器始终在。创建期间 live composer 沿用 draft 的 selection 作为初始 controls，projection 自己的 controls 到达后原地替换（选中项相同就不应该有任何视觉变化）。
- 交接编排：提交瞬间标题 "Build something useful with Pace" 和建议网格淡出并轻微上移；composer 滑到底部（沿用现有 translateY 动画）；同时三色描边亮起并流动。
- 描边规则（live composer 开 `accent="brand"`）：`status` 为 submitted / streaming 时流动；创建期（`isCreating`）也算流动；run 结束后描边淡出；聚焦静态描边只保留在 draft 空屏，live 中聚焦不显示描边（避免会话里常驻颜色）。
- reduced-motion：全部退化为无过渡的直接切换，描边静态。

## 实现建议

- 优先把 footer 抽成 `PromptInput` 的一个稳定 slot，支持 `footer` 内容变化时的 crossfade（旧内容 opacity→0，新内容 opacity→1，绝对定位叠放，容器高度固定为一行）。放在 `apps/desktop/src/shared/ui/chat/chat-prompt-input.tsx` 并在 Design 页展示 draft→live 两种 footer 状态。
- 若能把 draft 和 live 合并成同一个 `PromptInput` 实例（保持 mounted，只换 props）是最理想的；如果 `LiveSessionColumn` 的结构让这条路成本过高，退一步用两实例 + 严格一致的尺寸 + crossfade，也必须做到肉眼看不出换了组件。先评估再选，在报告里说明选了哪条以及原因。
- 标题/建议网格的淡出用现有 `[data-draft-handoff]` 机制加两个选择器，不引入 JS 动画库。
- 时长与缓动只用 `--duration-*` / `--ease-*` token，描边节奏沿用 `--chat-brand-sweep-duration`。
- 注意 memory 里记录过的 Draft→Live 竞态（PR #268）：`useSessionChanges` 在 worktree 建好前不能查询；不要改动那部分时序。

## 测试

- 现有 handoff 测试（`agent-workspace.test.tsx` 里搜 `draft-handoff`）必须继续通过。
- 新增：提交后 live composer 立即渲染 footer 行（不等 piSessionId）；创建期间模型选择器显示 draft 的选择；run 结束后 `data-accent` 流动状态关闭。不为动画时长或 CSS 类名写测试。

## 验收

- `bun run typecheck` / `bun run test` / `bun run build` 绿。
- 用 `bun run dev:mock` + Playwright 录一段提交过程的连续截图（每 100ms 一张，共 1.5s）放到 `.scratch/draft-live-handoff/frames/`，用于人工检查是否有任何一帧出现宽度、高度或控件位置跳变。
