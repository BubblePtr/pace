# 工作区、轨迹、数据与视觉原语

## Session Dock（会话页右栏）

`SessionDock` 是 surface 宿主：面板 + 贴右缘的 44px 图标 rail。`activeSurfaceId: "changes" | "files" | "terminal" | "browser"`，联合定义在 `session-dock/surface-registry.ts:12`，对应四种会话 surface。

新增一个 surface 的三步：`surface-registry.ts` 加元数据（id / title / icon / hint / `multiInstance` / `flushContent`）→ 页面注入内容 → 页面给 `badges` 供数（干净树、非 Git、加载中、读取失败都传 `undefined`，不传 `"0"`）。注册表只存元数据，不依赖 Session 状态。

- 开合用 `SessionDockTrigger`（`isOpen` / `onOpenChange`，工具栏里 `alignToRail`）。宽度交给 Astryx `useResizable`，边界用 `sessionDockResizableBounds(availableWidth)`：默认 560、最小 340、上限 = 可分配宽 − Chat 最小宽 400。
- 持有原生资源的 surface 用 `useSessionDockMotion()` 得知开合动画中，届时让位。
- **宿主不写表头。** 面板顶部 40px 带就是 surface 的第一行。

## Surface 第一行：SessionSurfaceBar / SessionSurfaceTabs

每个 surface 的第一行用 `SessionSurfaceBar`（`h-10`，左槽状态 `children`、右槽 `actions`；动作槽暂时为空也保留）。多实例 surface 的实例条用 `SessionSurfaceTabs`（每 tab 自带关闭、末尾新建、`isExited` 态）。**不用 Astryx `Toolbar` / `Tab`**：前者高度钉不到 40px 且 roving tabindex 与实例条的方向键打架，后者渲染为单个 `<button>` 装不下关闭按钮。

```tsx
// 正确 — session-terminal-panel.tsx:306
<SessionSurfaceBar>
  <SessionSurfaceTabs activeId={activeTerminalId} addLabel="New terminal" icon={Terminal}
    items={instances.map((i, n) => ({ id: i.terminalId, label: `Terminal ${n + 1}`, hint: i.cwd, isExited: i.status === "exited" }))}
    aria-label="Terminal instances" onActiveChange={setActiveTerminalId} onAdd={create} onClose={close} />
</SessionSurfaceBar>

// 错误 — 自己拼一条标题带，高度与基线对不上 Chat 标题
<div className="flex h-12 items-center border-b px-3"><h3>Terminal</h3></div>
```

## BrowserSurface

复合件：根只持 `state`，经 context 把状态交给子件。`state.kind` 为 `"narrow" | "unsupported" | "empty" | "live" | "error"`；`empty` 可用 `phase: "idle" | "initializing" | "opening" | "blank"`（无 phase 即 idle）。只有 `live` 渲染 viewport 占位（其 rect 驱动原生 `WebContentsView`）；`narrow` / `unsupported` 不画 chrome；零 tab 的 empty 显示 Astryx `EmptyState`。页面组合 `Tabs`（实例条）+ `Toolbar`（地址/导航/design mode）+ `Viewport`（占位、快照、notice、空态）。弹层出现时把 `snapshot` 传给 Viewport。

```tsx
<BrowserSurface state={state}>
  <BrowserSurface.Tabs tabs={tabs} activeTabId={id} annotationCount={n}
    onActiveTabChange={activate} onAddTab={add} onCloseTab={close} />
  <BrowserSurface.Toolbar address={address} canGoBack={canGoBack} canGoForward={canGoForward}
    isDesignMode={isDesignMode} annotationCount={n} onAddressChange={setAddress}
    onAddressSubmit={submit} onBack={back} onForward={forward} onReload={reload}
    onOpenExternal={open} onClearAnnotations={clear} onDesignModeChange={setDesign}
    onSendToComposer={send} />
  <BrowserSurface.Viewport viewportRef={viewportRef} snapshot={snapshot} notice={notice}
    onAddTab={add} onReload={reload} />
</BrowserSurface>
```

## TerminalView

xterm.js 宿主，对外只有 `ref.write()` / `ref.focus()` 和 `onData` / `onResize`，不含任何 RPC。零实例时页面层用 `EmptyState` + 「New terminal」按钮，不补建、不自建空态。ANSI 16 色是刻意保留的惯例终端色（diff 红、测试绿），不是 UI chrome，是仓库里少数合法 hex。

## Changes（SessionChangesPanel）

堆叠所有文件的 unified diff，文件大纲用于滚动定位与展开（ADR-0035）。所有宽度下均为左侧 Diff、右侧文件大纲；大纲占容器宽度的 40%，最大 13rem，其余留给 Diff。命名容器 `changes` 仅用于标题信息的响应式显隐。区块标题优先保留文件名与增删计数，状态标签在容器 `@sm` 起显示，完整状态始终可在大纲中查看（#243）。

内容网格紧贴工具条，Diff 与文件大纲之间不留额外 gap；两列从工具条下方延伸至可用区域底部，各自独立滚动，滚动条贴各列右侧；大纲不设固定最大高度。折叠组和 Diff Viewer 不加外围边框或圆角，代码区贴边，横向留白只放在文件标题上；文件之间沿用 Astryx `hasDividers`。文件标题行在 Diff 列内吸顶，保留路径、状态和增删数，下一文件到达时自然交接；标题使用不透明的 surface 背景，避免代码透出。文件大纲为直角导航列，仅留左侧语义 `separator` 分隔线；文件行不加圆角或分割线，以 hover / 选中背景区分。二进制与无文本补丁使用紧凑的 Astryx `EmptyState`（图标、标题、说明），在文件区块内居中，不撑满整列；冲突与截断提示保留语义色背景，不再包圆角边框。

Live Chat 中的本地文件链接由会话页面处理，流式与已完成回复共用同一入口，不把 Dock 状态放进共享 Markdown 组件：
- 点击后刷新当前 Session 的 Changes，等待首次加载或后台 refreshing 完成后再匹配文件；后台刷新保留旧快照，但不使用旧快照提前定位。只在文件确实出现在变更列表时展开 Dock、切到 Changes、展开目标文件并滚动定位，键盘焦点转到文件区块标题。重复点击仍重新定位。
- 相对路径以 Session 的 runtime cwd 为基准，也识别绝对路径、`file://` URL 和 URL 编码的路径。匹配使用 Session 的 diffRoot，不按文件 basename 猜测；重命名前的路径可指向当前文件。
- 支持 `#L12` / `#L12-L20` 与 `:12` / `:12:4`，定位起始行。默认定位修改后的一侧，整文件删除则定位删除前的一侧；对应行不在有界补丁中、二进制或无文本补丁时，只定位文件区块。
- 未匹配的本地文件链接不导航离开聊天；HTTP/HTTPS、邮件和页内锚点仍沿用原行为。读取期间切换 Session 或进入草稿会取消待定位请求。

空态直接复用 Astryx `EmptyState`，与 Terminal / Browser 同样使用居中图标、标题、说明和 `isCompact`，不加边框卡片，不新增自建组件：
- 干净树：`No changes yet`，说明 staged / unstaged / 新文件会随工作出现。
- 非 Git：`No Git repository`，解释工作目录不是 Git 仓库，不误报为读取失败。
- 无 Session：`No changes to review`，引导在项目中开始 Session，不显示刷新工具条。

有 Session 时保留顶部状态与刷新；工具条位于固定区域，不参与内容滚动。Changes 根占满 Dock 高度，下方内容区只裁剪、不滚动，滚动由 Diff 列和大纲列表各自负责；吸顶文件标题不能进入 header 的 40px 空间。截断提示位于双列下方的固定区域。容器查询只放在内容区，不能包住工具条，否则会隔离其与窗口拖拽层的 stacking context。空态在其余可用空间居中，不重复添加无意义的主按钮。加载、错误重试与 stale 提示保留原有行为。

## Files（SessionFilesPanel）

只读的 checkout 浏览器（ADR-0007 解冻，仅到「读」为止）：第一行 `SessionSurfaceBar` 左槽是选中文件路径（未选中时是 diff root 的目录名），右槽一个刷新 `IconButton`；下方与 Changes 一致，所有宽度下均为左预览右目录；目录占容器宽度的 40%，最大 13rem。两列从工具条下方填满至面板底部，分别独立滚动，滚动条位于各列右缘，目录不设固定最大高度。内容网格紧贴工具条与 Dock 两侧，不加顶部 margin、栏间 gap 或外层横向 padding。目录容器使用直角，仅保留与预览之间的左侧分隔线，树行不加分割线，仅通过缩进和展开箭头表达层级；同级目录排在文件前，各组按名称排序，静态演示数据与正式后端一致。树用 Astryx `TreeList`（`density="compact"`、`variant="noGuides"`），目录懒加载：未加载的目录挂一个禁用的「Loading…」占位子行，占位行被渲染即触发列目录，失败显示带 `role="alert"` 的 danger 禁用行，折叠再展开会重试；空目录保留展开器并显示禁用的「Empty directory」子行；列表被截断时末尾追加禁用的「Listing truncated」行。首次加载根列表时显示带 `role="status"` 的骨架屏；刷新时保留树实例与展开状态，工具条图标旋转，已展开目录会重新列出内容。文件行 `FileIcon`、目录行 `FolderClosed`，symlink / 其他类型渲染但禁用。预览走 `SessionFileViewer`（`@pierre/diffs` 的 `File`，与 diff viewer 同一套 options），二进制 / 空文件 / 截断各有 notice，读取失败给 alert + Retry。未选中文件、空文件和二进制不可预览状态使用居中的 Astryx `EmptyState`（图标、标题、说明、`isCompact`），与 Terminal / Browser 一致，不加卡片或无意义按钮。根目录为空时空态占满工具条下方整个区域，不显示空双栏；子目录为空仍保留树内禁用提示行。不编辑、不外部打开、不新增 shared/ui 组件。

## 轨迹（Trajectory Cockpit）

窗口标题栏直接承载左右两栏等高的 Header，不另叠页面标题：左栏为 Trajectory 与 ghost 刷新按钮，右栏为所选会话标题与项目；未选中时仅显示弱化的 Session replay。Header 底线对齐，左栏右侧分隔线从标题栏贯穿到列表底部；收起应用侧栏时，左标题让出交通灯与侧栏开关的安全区，刷新仍可点击，标题栏空白仍可拖动窗口。

项目筛选独占下一行，第二行保留排序与 Presence 筛选。列表独立滚动，不加行间横线或上下渐隐遮罩，以留白、hover / 选中背景区分行；费用与 tokens 均用次要小字，优先突出会话标题。未选中会话时，右侧使用无边框的紧凑 Astryx EmptyState，不重复 Trajectory 标题、不显示零值统计或无意义操作。选中后，ID 与用量留在概览带上方，不重复项目标题。

三件套读同一个模型 `entities/session/trajectory-model.ts`（Run > Turn > Step）：

- `PiTrajectoryLedger` + `.Run`：台账，行永不内联展开；徽章四色（USER / ASSISTANT / TOOL / CONTEXT）全部来自 `trajectoryStepType()` 与 `--pigui-data-*`。选中态、过滤、step/turn ref 放在根上经 context 下发；`.Run` 只传 `run`（外加可选 `isDimmed`）。`runs` 快捷路径行为不变。
- 页面按 Run 虚拟化时，外层虚拟项用布局偏移 `top` 定位，不用 `translateY`：后者会使内部 sticky 横栏在滚动时错位、覆盖步骤。横栏在进入视口时仍位于本组步骤之前，到达滚动区顶部才吸顶，并在下一组进入时交接。
- `PiTrajectoryStrip`：概览带。完整轨迹始终适配可用宽度；密集时按段数压缩最小列宽与间距，不裁掉尾部、不覆盖模式切换按钮。`widthMode: "steps" | "duration"` 必填且由页面持有；`lane` 只有 `"input" | "model" | "tools"`。推不出真实区间的段用斜纹 + 弱化标出，估算不伪装成实测。
- `PiTrajectoryInspector`：`tab` 取自 `trajectoryInspectorTabs = ["Summary","Payload","Result","Schema","Timing"]`，由页面持有；Schema 拿不到时显示 unavailable 诚实态。

```
要展示一个 step？
 ├── 在列表里一行 → PiTrajectoryLedger.Run（勿自造行）
 ├── 在时间轴上一段 → PiTrajectoryStrip
 └── 大 payload / 结果 / 计时 → PiTrajectoryInspector（大 payload 只在这里挂载）
```

## 数据与指标

- `PiKpi`：`layout: "stacked" | "inline"`，默认 `stacked`；仪表盘卡片用 stacked，紧凑行 / 侧栏用 inline。值传数字走 `formatOptions`（内部 `Intl.NumberFormat`）；自定义展示才传 `children`，它会整个替换格式化结果。
- `PiBarChart`：`aria-label` 必填；`series` 的 `color` 只取 `--pigui-data-*`，页面里的顺序表见 `usage.tsx:48`。刻意不是图表库；折线 / 面积 / 热力等 #87 等需求驱动，不要临时引入 recharts。
- `ContextUsageMeter`：`usage` 为 null 只画空轨道；阈值 70% / 90% 在组件内，页面不算颜色。footer 行右侧一枚 14px 圆环，是它唯一的家。

## 视觉原语

- **图标**：只从 `shared/ui/icons.tsx` 导入（Hugeicons 通过工厂钉 `strokeWidth 1.5`、`currentColor`，导出名按 Lucide 习惯起）。缺图标就在 `icons.tsx` 加一行，`File` 这个名字被故意避开（HMR 会绑到宿主 `File` 构造器）。
  Sidebar / Header 使用独立的 `AnimatedHistory`、`AnimatedChartPie`、`AnimatedPuzzle`、`AnimatedNewChat`、`AnimatedSettings`、`AnimatedSidebar`、`AnimatedSidebarRight`；新增按钮与三点菜单统一使用原有静态 `Plus`、`MoreHorizontal`，不使用动画；Usage 的饼图来自 Lucide，其余来自 Hugeicons。Settings 分类导航使用 `AnimatedKey`、`AnimatedRobot`、`AnimatedMessage`、`AnimatedFile`、`AnimatedInformationCircle`。静态导出与 Dock 内部栏位的图标保持不变，Header 右上角的 Dock 开关使用右侧镜像版本，具体范围及触发规则见 [animated-icons.md](animated-icons.md)。
  静态导出：`Activity Archive ArrowLeft ArrowRight ArrowUp BarChart3 Bot BotMessage Box Cancel ChatAdd Check ChevronDown ChevronRight Circle Command Computer Copy Crosshair FileDiff FileIcon Flash FolderClosed FolderOpen FolderOpenState GitBranch Globe ImageIcon LayoutAlignLeft LinkExternal ListTree LoaderCircle MoreHorizontal Palette Pencil Plus Puzzle RefreshCw Search Settings Settings2 SidebarLeft Sparkles SquareTerminal Stop Terminal ThumbsDown ThumbsUp Trash2 User Wrench`。名单之外的图标不存在，先加进 `icons.tsx` 再用。
- `ChatToolKindIcon kind`：`"shell" | "search" | "web" | "file" | "edit" | "tool"`，由 `toolKindFromName()` 归类；未知工具退回 `tool`（扳手）。
- `DotMatrix`：侧栏"正在运行"指示，`role="status"`，`label` 默认 "loading"，调用点应传更具体的 `aria-label`（`app-shell.tsx:341` 传 "Active run"）；颜色跟 `className="text-primary"`。
- `ChatPixelLoader`：九格像素心跳，只在 `ChatStatusLine` 内。`periodMs` 默认 860ms，经内联 `--chat-pixel-period` 下发，样式表里只读不声明。
- `ChatInlinePager`：一行视口翻页，`pageKey` 变化触发，`dwellMs` 默认 700ms、下限 300ms；全 `span` / `inline-flex`，塞进按钮不会让文字比箭头低。
- `TextShimmer`：流式文字的扫光占位，包任意行内文字。

```tsx
// 正确
import { Terminal, Search } from "@/shared/ui/icons";

// 错误 — 绕过工厂，粗细与颜色不再统一（design-system.test.ts 只守 icons.tsx 内部的 strokeWidth，这类漏网靠 review）
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
```


## 子代理的展示范围

主 Agent 的工具调用、插件回传的结果沿用 Live Chat 和 Trajectory。Dock 不再提供专用 Subagents 面板、活动计数或逐子代理控制；子代理生命周期由创建它的插件管理。已保存到 Pi 会话扫描目录的子会话可在独立 Trajectory 页回放，内存会话不承诺有历史。见 [ADR-0040](../adr/0040-root-session-process-isolation.md)。
