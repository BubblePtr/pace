# Astryx 组件的选定变体

Astryx 的 props 以 `bunx astryx component <Name>` 输出为准，本文只记录**我们在哪些选项里做了取舍**。Astryx 自己的原则（组件优先于 div、frame first、密集数据用行不用 Card、`:hover` 加 `@media (hover: hover)` 守卫、不手写 box-shadow）见 `bunx astryx docs principles`，不在此重复。

## 样式方式

用 `className`（Tailwind v4 + token 桥）和带 `var(--…)` 的 `style`；仓库 **不用 `xstyle`**（0 处），不装 StyleX 编译器。覆盖 Astryx 内部样式时以稳定类名 + 反射的 data 属性为选择器（`.astryx-button[data-variant="primary"]`），必要时用 `:not(#\#)` 抬特异度，不用 `!important`（`chat.css:54-62` 的三处是历史例外）。

## Button

联合类型：`variant: 'primary' | 'secondary' | 'ghost' | 'destructive'`，`size: 'sm' | 'md' | 'lg'`。`label` 必填，即使传了 children（它是可访问名）。

```
这是屏幕上唯一最重要的动作吗？
 ├── 是 → variant="primary"（一屏一个；两个 primary 等于没有层级）
 └── 否
      ├── 删除、撤销代价高 → variant="destructive"（调用前 window.confirm，settings.tsx:139）
      ├── 行内、工具栏里的低权重动作 → variant="ghost"
      └── 其余 → variant="secondary"（默认，可省略）
```

`size`：Composer、Surface 第一行、失败横幅这类**紧凑行**用 `sm`；页面级动作用默认 `md`。仓库 30 处里 16 处是 `sm`，全在紧凑行。

```tsx
// 正确 — no-providers-empty-state.tsx:32
<Button label="Open Provider Settings →" variant="primary" onClick={openSettings} />

// 错误 — 空态里唯一的动作却降级成 ghost，用户找不到入口
<Button label="Open Provider Settings →" variant="ghost" onClick={openSettings} />
```

## IconButton

同样的 `variant` / `size` 联合。默认组合是 **`variant="ghost" size="sm"`**（22 处里 15 处 ghost、18 处 sm）：图标按钮几乎都住在工具栏、标题带、消息动作行里，需要退到内容后面。只有**悬浮在内容之上**的图标按钮（对话流的滚到底按钮 `chat-conversation.tsx:69`、setup 页）用 `secondary`，因为 ghost 在内容上方没有可辨的边界。`aria-label` 必填。

侧栏会话行、项目行及分组标题中的操作按钮统一使用颜色反馈：按钮背景透明，不叠加独立 hover / pressed 底色或阴影，不缩放；图标从 `--muted` 过渡到 `--foreground`。按钮 hover 时仍共享整行背景，选中行保持选中底色；菜单打开及键盘聚焦时保持图标强调，保留 Astryx 的 focus ring 与减动效处理。此规则仅限侧栏操作区，不改变全局 ghost 按钮。

## Token · Badge · StatusDot

三选一时：**永远 Token**。`Badge`（14 色变体）和 `StatusDot` 在仓库里 0 调用，不要成为第一个。

- 计数、枚举状态、"Latest"标记、附件文本 → `<Token size="sm" />`；仓库 6 处全是 `sm`。带色时通过 `color` 传 Token 自己的色名，不传 `--pigui-data-*`。
- 运行 / 完成 / 失败这类**行级状态**不画点，用 `trajectoryStepStatus()` 返回的 glyph（`pi-trajectory-ledger.tsx:36`）或 Astryx `ChatToolCallStatus`。

## Text / Heading

见 typography-motion.md。要点：`Text` 的类型 prop 是 `type` 不是 `variant`；辅助文字 `type="supporting"`。

## Card

只传 `padding`（`0` 或 `4`），**不传 `variant`、不传 `elevation`**（15 处都没传）。Card 是 dashboard 小件、设置分组、KPI 容器；列表行和页面分节不用 Card 包，用 `List` / `Divider`。

## Stack

`HStack` / `VStack` 的 `gap` 传数字：紧凑行 `0.5` 或 `1`，表单与分组 `2` 或 `3`，页面分节 `6`。`HStack` 默认 `vAlign="stretch"`，文字与图标同行时要显式 `vAlign="center"`（17 处里 6 处）。泛型 `Stack` 只在需要 `direction` 动态切换时用（1 处）。

## List / ListItem

选择器、下拉列表、模型列表用 `density="compact"`（6 处里 3 处）；设置页可读列表用默认 `balanced`。`Table` 在仓库里 0 调用，密集只读数据先考虑 `List`。

## EmptyState

**所有零态都用它**（15 处），不手写"暂无数据"的 div。侧栏、面板等窄处加 `isCompact`。`setup.tsx:128` 有同名本地包装，是特例不是范本。

## Dialog / Popover / DropdownMenu / Tooltip / Collapsible

- `Dialog`：表单类 `purpose="form"`（点背景不关、Esc 关、恢复焦点）；窄屏 `variant="fullscreen"`，由 `useMediaQuery` 决定。
- `Tooltip`：一律默认 `placement`（4 处都默认）；`content` 是唯一文案来源，同一串文本作 `aria-label` / `role="img"` 可访问名。
- 弹层用 Astryx `Popover` / `DropdownMenu` / `MoreMenu`；Browser surface 靠 `useOverlayPresence` 检测 `[popover]` 与 `dialog[open]`，自建弹层会绕过这个检测让原生视图盖住弹层。
- 折叠：用户可见的展开/收起用 Astryx `Collapsible`（`chat-run-failure.tsx:75`）；只有思维链 step 行用 Base UI `Collapsible`，因为它要完全自定义触发器外观。别处不引入 Base UI。

## 表单控件

```
设置项是什么形状？
 ├── 一个开关、改动立即生效 → Switch（不配 Save 按钮；model-selector-control.tsx 的 Fast Mode 就是它）
 ├── 一组可多选的项 → CheckboxList（settings.tsx:369 的可见模型）
 ├── 2–4 个互斥选项且全部可见 → SegmentedControl（4 处，用量最大）
 ├── 更长的互斥列表 → Selector
 └── 自由文本 / 密钥 → TextInput（受控，`value` + `onChange`）
```

### 文本输入框的层级

普通 TextInput 是嵌入页面的表单控件，沿用 Astryx 默认边框、悬停 / 聚焦内描边及校验 / 禁用样式，不套用 Composer 的外阴影。官方 `TextInputSearch` 与 `FormLayoutHorizontalLabels` 示例均直接使用 TextInput；Field 仅为自定义控件补标签与状态，不要再包住 TextInput。

只有 Live Chat 的 Composer 需要与对话内容区分，保留局部、恒定的轻量外阴影（见 [chat.md](chat.md)）。不要以“都是输入”为由统一两者的视觉层级。Trajectory 的原生过滤框也保持原有边框样式。

## 加载、错误、零态

只有这几种形态，别引入 `Skeleton` / `Spinner` / `ProgressBar`（仓库 0 调用）：

- **内容区还没数据**：`<EmptyState title="Loading sessions..." />`，窄处加 `isCompact`（`session-list.tsx:398`、`usage.tsx:677`）。
- **一个区块内部在加载**：一行 `<Text as="p" type="supporting">Loading…</Text>`（`settings.tsx:335`）。按钮触发的异步用按钮自己的 `isDisabled={mutation.isPending}`。
- **区块内错误**：`<Text as="p" type="supporting" role="alert" style={{ color: "var(--danger)" }}>`（`settings.tsx:340`）。
- **一次 run 失败**：`ChatRunFailure`（见 chat.md），它是仓库里唯一的 `Banner status="error"`。
- **零态**：`EmptyState` + 一个 `primary` 动作（`no-providers-empty-state.tsx`）。

## 设置项放哪

Settings 是一个 `Dialog purpose="form"` + 左侧 `SideNav` 分类，不是页面。新增一类设置 = 在 `pages/settings.tsx` 的 `SettingsSection` 联合里加一个值 + 写一个 `*Section` 函数：区块标题 `Heading level={2}` 带 `id`，每个分组一张 `Card` 内 `Heading level={3}`。不要为设置新建路由或 `shared/ui/` 组件。

About & Updates 导航复用 `Token size="sm"`：发现更新及下载中显示蓝色 `Update`，下载完成显示绿色 `Ready`；其他状态不显示。标记直接订阅共享 updater 状态，不因打开分类而清除。桌面侧栏宽度为 `calc(var(--spacing-10) * 7)`，为完整分类名和标记留出空间；窄屏 About 标签将标记放在文字下方，有标记时统一增加标签高度，避免挤压其他分类。

## 导航与壳

`AppShell variant="elevated"`，侧栏 `SideNav` + `SideNavSection`，宽度 `resizable={{ defaultWidth: 260, minWidth: 240, maxWidth: 320 }}`。页面内跳转走 Astryx `Link` / `useLinkComponent()`，不写裸 `<a>`。分栏面板用 `Layout` + `LayoutPanel`；Session 页右栏不是 `LayoutPanel`，是 `SessionDock`（见 workspace.md）。

## Resource Management（Setup）

安装表单复用 `Dialog purpose="form"`、`TextInput` 和 `Button`，留在 `pages/packages/resources.tsx` 做页面组合。安装期间显示“安装中…”并禁用重复提交，返回后用 `List` 展示后端累计的 progress；错误留在对话框内。包行用 Update / Remove，资源行用 `Switch`；Theme、无 Package Filter 的 top-level 和 CLI 单文件／裸目录包用 `isDisabled` + `disabledMessage` 说明限制，drop-in 不显示开关。

Add local resource 使用系统文件选择器，同名替换、包移除和 drop-in 删除沿用 `window.confirm`。所有写动作完成后提示“将在下一个新 Session 生效，运行中的 Session 不受影响”，并失效共享 `config-inventory` query，composer 插入菜单同步读取启用状态。没有新增组件原语或控件变体，Astryx 组件直接复用。

Package 行的更新状态使用 `Token size="sm" label="Update available"`，按 Source / Scope 匹配；查询失败用区块内错误文案。Resource 的最近扩展错误留在该行 description 内，以 `VStack`、`Text` 和语义 `time` 展示时间与消息，消息使用 danger token，无错误不留占位。Package 详情与 drop-in 视图共用这一行组合，不新增控件变体。


### Packages Marketplace

`pages/setup.tsx` 只连接路由壳与库存查询，`pages/packages/marketplace.tsx` 负责 Discover / Installed / Updates、卡片目录和详情组合。窗口栏保留 Packages，内容区不重复同名大标题。主题卡用既有数据色与 surface 混合，包卡用 `Card padding={4}` 和响应式 `Grid`；没有新增 token 或共享原语。

目录搜索使用 `TextInput`（300 ms 防抖）和分页；类型用 ghost / secondary Button，选中态带 `aria-pressed`，排序用 Selector。详情用命名的 `Dialog purpose="form"`，资源清单复用管理面真实 ResourceList；未知类型、目录故障和更新检查故障分别呈现，检查失败不能显示“全部已是最新”。Add local resource 与 Resources & configuration 保留独立入口，配置检查弹窗提供默认值和环境检查。
