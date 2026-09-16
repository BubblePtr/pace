# Token

## 允许哪一层

三层，从下往上：Astryx 一级 token（`--color-*`、`--spacing-*`、`--radius-*`、`--font-size-*`、`--duration-*`，全部 `light-dark()`，随系统明暗自动切换）→ Pace 语义桥（`styles.css:59-76`，15 个）→ Tailwind 别名（`styles.css:81-97` 的 `@theme inline`，让 `text-foreground` / `bg-surface` / `border-separator` 这类类名可用）。

组件代码只能引用**上两层**：语义桥（`var(--foreground)` 或类名 `text-foreground`）和 Astryx 一级 token（`var(--color-text-secondary)`）。原因：桥和一级 token 都会随主题解析，字面量不会；Tailwind 自带调色板（`text-gray-500`、`bg-zinc-900`）不经过 Astryx，明暗模式下必错。

```tsx
// 正确 — pages/usage.tsx 顶部的序列色表
const seriesColors = ["var(--pigui-data-blue)", "var(--pigui-data-orange)", /* … */];

// 错误 — 字面量与调色板类都不随主题走
const seriesColors = ["#1677e8", "text-blue-600"];
```

## 语义桥（`styles.css:59-76`，就这 15 个）

| 桥 token | 背后的 Astryx token | 用途 |
| --- | --- | --- |
| `--foreground` | `--color-text-primary` | 正文 |
| `--muted` | `--color-text-secondary` | 次要文字、元信息 |
| `--background` | `--color-background-body` | 页面底 |
| `--surface` | `--color-background-surface` | 面板、卡片、Dock、终端背景 |
| `--surface-muted` / `--surface-secondary` | `--color-background-muted` | 同一值的两个名字；新代码用 `--surface-muted` |
| `--surface-hover` | `--color-overlay-hover` | 悬停叠色 |
| `--separator` / `--border` | `--color-border` | 同一值；新代码用 `--separator` |
| `--default` | `--color-neutral` | 中性强调 |
| `--primary` | `--color-accent` | 强调色、选中态 |
| `--danger` / `--success` / `--warning` | `--color-error` / `--color-success` / `--color-warning` | 文字与图标的状态色 |
| `--radius` | `--radius-element`（8px） | 默认圆角 |

没有 `--info`、没有 `--accent-foreground`、没有 `--card`。要的语义不在表里，就直接用 Astryx 一级 token，不要往桥里加（桥里每加一个名字，`design-system.test.ts:86-103` 都要跟着改）。

## 选颜色

```
我要给什么上色？
 ├── 文字 / 图标
 │    ├── 正文 → --foreground
 │    ├── 元信息、时间戳、提示 → --muted（不是 --color-text-disabled：12px 灰字在白底上 ~2.6:1，过不了 AA，chat.css:481-484 记过这一笔）
 │    ├── 真正不可用 → --color-text-disabled
 │    └── 成功 / 警告 / 失败 → --success / --warning / --danger
 ├── 面 / 背景
 │    ├── 页面底 → --background；面板、卡片、Dock → --surface；输入区、次级面 → --surface-muted
 │    └── 弹层 → --color-background-popover（Astryx 一级，桥里没有）
 ├── 分隔线 / 边框 → --separator；1px 用 --border-width
 └── 图形（图表段、徽章底、圆环弧）→ --pigui-data-*（见下）
```

## 数据调色板 `--pigui-data-*`（`styles.css:99-110`）

八个固定 hex，**没有明暗变体**（刻意：分类色在两种主题下读起来要一样）：`blue` `orange` `orange-strong` `amber` `green` `peach` `coral` `slate`。

规则：图形分类色只从这八个里取；文字状态色只从 `--success/--warning/--danger` 取；两族不互借。理由写在 `pi-trajectory-ledger.test.tsx:190-212`：CONTEXT 徽章曾借 `--success`，结果"成功"这个语义被"上下文"污染。反过来也一样，`context-usage-meter` 的 2px 圆环用 `--pigui-data-green/amber/orange-strong` 而不是 `--success/--warning/--danger`，因为后者为文字对比度刻意压暗，画在细弧上发闷。

```tsx
// 正确 — pi-trajectory-ledger.tsx:24-33
context: { label: "CONTEXT", color: "var(--pigui-data-green)" }

// 错误 — 借语义色给图形，测试会红
context: { label: "CONTEXT", color: "var(--success)" }
```

## 间距、圆角、尺寸

- 间距只用 Astryx 刻度：`--spacing-0 … --spacing-12`（4px 基数，另有 `0-5`=2px、`1-5`=6px）。Tailwind 的 `p-4` / `gap-2` 与之同基数，可用；`p-[13px]` 不可用。Stack 的 `gap` 传数字：`gap={2}`，不是 `gap="2"`。
- 圆角只有 `--radius-inner`(4) `--radius-element`(8，即 `--radius`) `--radius-container`(12) `--radius-page`/`--radius-chat`(28) `--radius-full`。`rounded-[3px]` 不存在于系统里。
- 控件高度只有 `--size-element-sm/md/lg` = 28/32/36px。Surface 第一行的 40px（`h-10`）是唯一例外，理由见 `surface-bar.tsx`。
- `--pigui-sidebar-*`（`styles.css:111-130`，20 个）只在 `app-shell.tsx` 与 `styles.css` 的侧栏规则里用，值被 `app-shell.test.tsx` 按字面冻结；别处不引用，也不新增 `--pigui-color-*`（同一测试禁止）。
- 运行时注入的布局 token（`--pigui-header-height` `--pigui-main-left` `--pigui-chrome-safe-left` `--pigui-session-dock-width`）由 `app-shell.tsx` / `agent-workspace.tsx` 写在 style 上，CSS 只读不声明。

## 已知债务，不许再添

| 债务 | 位置 | 新代码的做法 |
| --- | --- | --- |
| `text-[11px]` / `text-[10px]` / `text-[9px]` 共 18 处 | trajectory strip / ledger / inspector、session-list、session-dock | 微标签用 `--font-size-sm`（12px）+ `--muted` + `uppercase tracking-wider`，见 typography-motion.md |
| `13px` 作 `--chat-icon-size` 的回退写了 7 遍 | `chat.css:499-573` | 直接 `var(--chat-icon-size)`，不带回退 |
| `rounded-[1px]` / `rounded-[3px]` | `pi-trajectory-strip.tsx` | 用 `--radius-inner` |
| `cubic-bezier(0.32, 0.72, 0, 1)` 与 `120ms` 各 8 处 | `styles.css` 弹层/tab | 见 typography-motion.md 的白名单 |

## 谁在守

没有 ESLint / stylelint。守门的是源码字符串断言，命令 `bun run test`：`design-system.test.ts`（桥、层顺序、字体、图标粗细）、`pi-trajectory-ledger.test.tsx`（数据色不借语义色）、`app-shell.test.tsx`（侧栏 token 冻结、禁 `--pigui-color-*`）、`pages/design.test.tsx`（/design 页展示全部桥与数据色）。
