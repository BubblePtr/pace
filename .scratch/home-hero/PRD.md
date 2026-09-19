# 首页视觉锚点（home-hero）

## 目标

新会话空屏要能作为 README 截图、社区宣传和视频的视觉锚点。当前空屏只有一行灰色标题、一个输入框，整屏无色。

## 决策

- 颜色只在"Pi 在场"的位置出现，其余界面保持黑白。三色取自 Pi 图标：珊瑚 `#F09082`、蓝 `#4D9ABF`、黄 `#F1BE58`。
- `docs/design/brand.md` 原来的"不加渐变"规则已删除，改为"logo 与主体保持极简"。

## 范围

### A. 彩色 shimmer（`TextShimmer` 新增 `tone="brand"`）
- 文件：`apps/desktop/src/shared/ui/chat/text-shimmer.tsx`、`chat.css`、`apps/desktop/src/app/styles.css`（注册 `--pi-coral/--pi-blue/--pi-yellow` 及浅色主题压暗版本）。
- 默认变体保持灰色扫光不变（被 Thinking… / Loading history… 复用）。
- brand 变体：珊瑚→黄→蓝 的三色扫光；`prefers-reduced-motion` 下退化为静态三色渐变而不是灰色。
- 浅色主题下黄色对比度不足，三色各压暗一档（用 oklch 降 L，保持 hue）。
- 使用处：`apps/desktop/src/pages/agent-workspace.tsx` 空屏标题的 `<TextShimmer>Pace</TextShimmer>`，去掉外层 `text-muted` span。
- Design 页 `TextShimmerGallery` 同 PR 增加 brand 变体展示。

### B. Composer 三色描边
- 文件：`apps/desktop/src/shared/ui/chat/chat-prompt-input.tsx` 及其样式。
- 聚焦时 1px 三色渐变边框（用 `border-image` 或伪元素 + mask 实现，不改布局尺寸）；发送中（`Sending message…` 状态）渐变缓慢流动；空闲回到普通边框。
- 只作用于空屏 draft composer，不影响会话内的 composer。通过 prop（如 `accent="brand"`）显式开启。
- reduced-motion：描边静态、不流动。

### C. 示例 prompt 芯片
- 空屏输入框下方 3 个芯片，点击把文案填入 draft（走 `onDraftChange`）。
- 文案示例（英文，和现有 "Do anything with Pi" 同语气）：`Explain this repo's architecture`、`Fix the failing test`、`Add a CLI flag with docs`。
- 复用 Astryx 的 Chip/Tag 组件，若无等价物再自建并注册到 Design 页。

### D. 模型选择器图标
- `apps/desktop/src/shared/ui/model-selector/model-selector-control.tsx` 触发按钮里模型名前加 `ProviderIcon`（`apps/desktop/src/entities/provider/provider-icon.tsx`）Mono 版本，尺寸与现有 Flash 图标一致（`size-3.5`）。
- 列表行同样加图标。
- 未知 provider 时不渲染图标，不占位。

## 验收

- `bun run typecheck`、`bun run test`、`bun run build` 绿。
- 明暗两套主题各截一张空屏图，放在 `.scratch/home-hero/` 供 review。
- 现有 shimmer 使用处视觉不变。
