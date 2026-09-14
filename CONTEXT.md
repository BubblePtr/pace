# Pace

Pace 是面向 Pi Agent 的桌面工作台。它把 Pi 的运行记录、用量、配置和工作空间状态组织成可理解、可操作的 GUI。

## Language

**Agent Workspace**:
一组围绕同一目标、代码库或长期事务组织的 agent 工作环境，包含会话、任务、运行状态、配置与可操作控制。它不是单次会话，也不是单纯的项目目录。
_Avoid_: Session, project, dashboard

**Project**:
Pace UI 中围绕一个用户手动选择的本地工作目录建立的组织单元，不要求该目录是 Git repo。Project 拥有多个 Session，并提供 Analyze、配置、用量和 checkout 管理等视角。它不再是唯一的顶层归属：无代码库的对话走内置的 Chat Workspace，Chat 不是 Project。
_Avoid_: Workspace, single session, Git branch, Git-only project, chat-as-project

**Chat Workspace**:
Pace 数据目录下的内置隐藏工作空间根 `<dataDir>/chats/`，不是 Project，不写入 Project Registry，不可 Remove，不经过 `normalizeProjectPath`。identity 用哨兵 `projectId = "chat"`（Registry 的 Project id 都是以 `/` 开头的绝对路径，不会冲突）。每个 Chat Session 在其中拥有独立目录 `<dataDir>/chats/<sessionId>/`，作为 Pi 的 cwd；目录由后端 `prepare_chat_workspace` 创建，渲染层不知道 dataDir。Sidebar 顶部固定 Chats 分组直接列出这些 Session，标题旁提供 New Chat，没有中间的 Chat 父级。
_Avoid_: Project, registry project, auto-discovered folder, custom chat root, temporary project

**Project Selector**:
Pace 中选择 Session Draft 提交目标的入口。首项固定为 "No project"（Chat Workspace），其后是 Project Registry 里用户手动添加的 Project。空 Workspace 不必先 Add Project 也能选 Chat 并提交 prompt。用户可见文案对代码目录仍用 Project，对无项目对话用 Chat，而不是 Workspace。选择 Project 时是用户工作的根目录语义，不是临时覆盖某个 Session 的 cwd。首次添加 Project 后，该 Project 立即成为 Current Project。全局 New Chat 和没有历史草稿时的 landing 均默认 Chat，项目旁 New Chat 默认该 Project；允许随时切换，切换目标不清空 draft 文本。Project Selector 不承载 Project Removal。
_Avoid_: Workspace selector, cwd switcher, session picker, auto-discovered project, composer-only project list

**Project Sidebar**:
Pace 左侧导航面：顶部固定 Chats 分组（Chat Session，不属于任何 Project），其下按添加时间倒序展示 Project Registry 中所有 Project。Chats 下直接列出无项目对话。Chats 与 Projects 的标题文字本身就是折叠开关，整组折叠状态在本机保存；标题旁只有一个加号，且与 Project 行、Session 行上的操作按钮一样默认隐藏，鼠标悬停、键盘聚焦或菜单打开时才显示（触屏设备常驻）。Chats 的加号新建 Chat，Projects 的加号打开目录选择器添加 Project；不再显示独立的 Add Project 列表行。两组收起后仍保留加号入口，不改变当前会话。状态标记（运行中、未读结果、Follow-up Draft、时间）不属于操作按钮，始终可见。每个 Project 行还可以独立展开或收起自己的 Session 列表，行点击只切换展开状态，不切换主内容。新添加的 Project 默认展开，展开状态作为 Pace 本地 UI state 跨 app 重启保留，但不等同于 Current Project。从外部入口打开某个 Session 时，Sidebar 自动展开该 Session 所属的 Project（如有）。Project 行上的 New Chat 入口会把该 Project 设为 Current Project，并打开全局唯一的 Session Draft；Chats 标题旁的 New Chat 把当前目标设为 Chat，之后仍可通过 Project Selector 更改。Project Removal 只放在 Project 行的更多菜单里，Chats 分组没有 Remove。Sidebar 不为全局 Session Draft 显示 indicator；只有已有 Session 的 Follow-up Draft 需要在对应 Session 行显示轻量 indicator，并可在分组折叠时汇总到分组行。
_Avoid_: Single-current-project-only sidebar, global session list, project tree auto-discovery, current-project state, session ownership, project detail navigation, global draft indicator

**Project Registry**:
Pace 持久保存的用户手动添加 Project 列表，是 Project Selector 中 Project 选项的来源，不是 Chat Workspace 的来源。它属于 Pace 本地 app state，不属于项目 repo、Pi Runtime truth 或 Pi session logs；它跨 app 重启保留，并用规范化后的本地绝对路径作为首版 Project identity，按添加时间倒序呈现，默认显示名取目录 basename，但不从 session logs、历史 cwd 或文件系统扫描自动创建 Project。Chat Workspace 不是自动发现，也不写入 registry。用户添加已存在路径时，Pace 不创建重复 Project，而是选中已有 Project 并进入全局唯一的 Session Draft。用户可以从 registry/sidebar 移除 Project；该动作不删除本地目录，也不删除已有 Session Projection 或 Session Trajectory。
_Avoid_: Session-derived project list, recent cwd list, auto-discovery cache, display-name identity, project delete, repo config, Pi runtime config, Git-only registry, duplicate project, last-used sorting, project rename, chat-in-registry

**Project Removal**:
用户从 Project Registry 移除一个 Project 的危险动作，需要二次确认；确认内容应说明 Project 会从 Pace 中移除、本地文件和历史 Session 不会删除。如果该 Project 是全局 Session Draft 的提交目标，Pace 保留 draft 文本但清空目标，用户需要重新选择目标（Project 或 Chat）后才能提交，不会自动回落到 Chat。如果当前界面正在打开该 Project 下的 Session，Pace 跳到 new session 的空状态；如果当前界面不在该 Project 的 Session 中，移除动作不改变当前界面。
_Avoid_: Delete directory, delete sessions, global navigation reset, silent-fallback-to-chat

**Empty Workspace State**:
Pace 中 Project Registry 为空、没有 Current Project 的状态。此时 Sidebar 仍显示固定的 Chats 分组和 Add Project；全局 New Chat 可用，landing 进入 Chat draft，用户可以直接提交 prompt 而不必先添加 Project。
_Avoid_: Default project, prompt-blocked-until-project

**Current Project**:
Pace 当前正在操作的 Project，在 Project Registry 非空时决定新建 Session 的默认目标。Registry 为空时默认目标是 Chat，而不是发明一个 Current Project。用户从 composer 入口选择另一个 Project 时，该 Project 也成为 Current Project；选 Chat 则当前提交目标为 Chat Workspace。全局 Session Draft 的文本保留，Project Sidebar 中的展开状态不改变 Current Project。
_Avoid_: Composer-only project, selected session project, cwd override, expanded project

**Session Trajectory**:
一次 Pi 交互的事后运行记录，展示消息、thinking、工具调用、token 和成本。它属于 Analyze 视角的分析材料，不是 Project 下的交互入口本身。
_Avoid_: Session, workspace, chat

**Trajectory Cockpit**:
Session Trajectory 的仪表盘式呈现形态：Strip、Tally、Ledger、Inspector 四个面板加 Playhead 游标的组合，对标 DevTools Network 面板的"概览带 + 请求表 + 详情栏"解剖。它是 Analyze 视角下阅读单条 Session Trajectory 的界面结构，不是 Live Session View。
_Avoid_: Live chat, log viewer, dashboard

**Strip**:
Trajectory Cockpit 顶部的会话概览带，Input / Model / Tools 三条泳道：色块以"段"为粒度（user 输入、连续的模型输出、连续的工具执行各成一段），按角色点亮各自泳道，错误段变红。悬停显示游标竖线用于精确定位，单击选中该泳道块并跳到对应步骤，拖拽框选连续段作为聚焦选区（视频轨语义：选区外压暗，不过滤，不外扩成整段 Active Run），并投影 Playhead 的当前位置。支持等宽与按时长加权两种列宽；时长模式下工具段与模型段都取自 Pi 记录的真实起止（模型段 = 模型调用开始到消息结束），只有拿不到起止的模型调用才退回按轮次间隔估算，并以斜纹加弱化处理与实测段区分——估算不得伪装成实测。回答"这条 Session 整体长什么样、错误在哪、我在哪"。
_Avoid_: Timeline, minimap, progress bar, per-turn column

**Tally**:
Trajectory Cockpit 中的成本与规模汇总行（总成本、总 token、Turn 数）。它承载 cost and token truth 的汇总视图，是只读陈述，不是筛选器。
_Avoid_: KPI grid, summary card, filter bar

**Ledger**:
Trajectory Cockpit 左侧的单行步骤台账：每个事件（tool/think/text/image/config）一行，两级分组——顶层按 Active Run（一次 user 输入及其后续全部 Turn 为一组，编号 Run #N），组内按消息（user 输入 / assistant Turn / 注解）细分并带角色标识。行永不内联展开，展开语义由 Inspector 承担。密度恒定、失败醒目是它的核心承诺。
_Avoid_: Chat list, message stream, expandable rows, per-message numbering

**Inspector**:
Trajectory Cockpit 右侧的步骤详情栏（只指这一个；Live Session 页右侧的宿主是 Dock，见 ADR-0032），按 Summary / Payload / Result / Schema / Timing 分 tab 呈现 Playhead 所指步骤的完整材料。大体量 payload 只在这里展开，不进 Ledger。Schema 显示工具的声明式定义（描述 + 参数 JSON Schema），由 Runtime Gateway 按工具名向运行时解析，不来自 Session Trajectory 本身；工具未注册或定义已漂移时显示不可用状态。
_Avoid_: Inline detail, modal, sidebar, Dock, session panel

**Playhead**:
Trajectory Cockpit 中当前被检视的步骤位置：Ledger 中的选中行、键盘上下移动的游标，以及 Strip 上的位置投影是同一个概念。它暗示 Session Trajectory 是可回放的时间序列。
_Avoid_: Selection, cursor, focus row

**Session**:
一条已提交、可运行、可恢复、可归档的 Pi 交互工作单元，归属某个 Project 或 Chat Workspace。实现上，一个 Session 对应一个 Agent Run 及其 Execution Checkout，并持续沉淀 Session Trajectory。Session 的运行真相属于 Pi Runtime；Pace 保存的是用于 UI、索引和生命周期管理的 Session Projection。`projectId` 仍是必填字符串：Project Session 用规范化绝对路径，Chat Session 用哨兵 `"chat"`。
_Avoid_: Task, workspace, trace-only session, draft prompt, nullable-projectId

**Chat Session**:
目标为 Chat Workspace 的普通 Session。resume、fork、archive 语义与 Project Session 相同；Fork 产生新的 Chat 目录且不复制源目录文件。Trajectory / Usage 将其标签显示为 "Chat" 而不是 sessionId。Live Session 页头显示 "Chat"；Git-only 动作沿用非 Git Project 的禁用/隐藏态。Terminal surface 的 cwd 为该 Session 的聊天目录。
_Avoid_: untitled project, temporary project, projectless-null-session

**Session Draft**:
用户点击 New Chat 或加号后进入的全局唯一未提交输入状态。它跨 app 重启保留一份 initial prompt、可选的当前提交目标（Project 或 Chat）和少量高级覆盖项，但尚未创建 Pace Session、Pi Session State、Agent Run 或 Execution Checkout，也不显示在 Session 列表中。切换目标不清空 Session Draft 文本。如果目标 Project 被移除，draft 文本保留但目标清空，并由 composer 要求重新选择，不自动回落到 Chat；app 启动恢复 draft 时，已不在 Project Registry 中的 Project 目标同样被清空，Chat 目标保持有效。全局新 draft 默认目标为 Chat，与 Registry 是否为空无关。未确定目标时隐藏执行方式；选中 Project 后以 Project folder / Git worktree 说明对文件的影响。草稿不展示上一会话的 Session Dock。提交 draft 后才进入 Session 创建流程；`creating` 状态的 Session Projection 一出现，视图就交给 Live Session View（路由离开 draft、侧栏选中新 Session），不等待 Pi 的事件边界；只有 Pi Runtime 接受 initial prompt 或发出首个 runtime event 后，draft 才清空。创建失败时 Live Session View 展示失败阶段与错误，并提供回到 Session Draft 的入口，draft 文本保持完整。
_Avoid_: Per-project draft, Project-scoped draft, follow-up input, Session, Pi session, run, trace

**Follow-up Draft**:
用户在已有 Session 的 composer 中尚未提交的 follow-up 输入。它按 Session 归属并跨 app 重启保留，一条 Session 最多保留一份 Follow-up Draft；它用于继续该 Session，不允许切换 Project，也不是全局 Session Draft。提交、Queue 或 Steer 成功后，Pace 清空对应 Session 的 Follow-up Draft；失败时保留文本并显示错误。
_Avoid_: Session Draft, Project draft, new-session draft, queued message

**Unsent Follow-up Indicator**:
Project Sidebar 中提示已有 Session 存在 Follow-up Draft 的轻量标记。它不表示全局 Session Draft，也不表示 Session Status；Session 行显示自己的未发送 follow-up，Project 行只在折叠时汇总隐藏的 Follow-up Draft。它与 active run / unread result 分属不同状态位，不覆盖运行中或未读结果信号。
_Avoid_: Draft badge, Session Draft indicator, Project draft indicator, status badge

**Session Creation**:
Session Draft 提交后的创建状态机。Pace 先创建 `creating` 状态的 Session Projection，再选择或创建 Execution Checkout，然后启动或 attach Pi Runtime / 创建 Pi Session State，最后发送 initial prompt。每个阶段都要能记录错误和恢复点。Live Session View 从第一阶段起就承接该 Session：initial prompt 以待发送气泡显示，当前阶段以状态行显示，composer 锁定到 initial prompt 被接受为止；UI 的交接时机不依赖 Pi 的 user message 边界，因为扩展可以把该边界推迟任意久。
_Avoid_: Draft editing, single-step create, invisible side effect

**Resume**:
打开一个当前没有存活 runtime 的 Session 并让它重新可继续对话的能力。它是 Gateway 能力而不是用户动词：用户只有"打开 Session"一个动作，底层走热 attach（runtime 仍存活）还是冷恢复（进程重启后从 Pi 会话记录重新打开）对用户透明。冷恢复时对话上下文永远由 Pi Runtime 从 Pi Session State 的持久记录自行重建，Pace 不自行拼装 LLM 上下文；UI 时间线来自 Session Event Journal 的回放，两者分工不可互换。
_Avoid_: Resume button, reattach-only recovery, Pace-rebuilt LLM context, plain session switch

**Fork**:
从已有 Session 的某条 user message 边界分叉出新 Session 的动作。Fork 只复制对话上下文（root 到 fork 点的线性路径），永远产生一个带独立 identity、独立 Execution Checkout、出现在 Session 列表中的新 Session，并保留指回源 Session 的谱系；被选中的 user message 原文预填进新 Session 的 composer 供改写。Fork 不承诺磁盘状态回到 fork 点：Git Project 下新 Session 强制使用新的 managed worktree，非 Git Project 复用前台目录并提示可能存在源 Session 的文件改动。树内分支（同一 Session 内移动 leaf 形成非线性历史）不在产品边界内。
_Avoid_: In-session branch, tree navigation, disk snapshot, filesystem time travel, checkout copy

**Session Creation Boundary**:
Pace 当前的 Session 列表只包含从 Pace 中创建的 Session。当前不自动扫描 Pi 的 session 目录，也不支持把 Pace 之外产生的 Pi CLI/TUI session 手动导入或补建 Session Projection。需要在 Pace 继续外部工作时，用户在目标 Project 内新建 Pace Session，避免把缺少 journal/checkout/status 的外部记录伪装成 Pace 原生 Session。这是当前实现范围，不是永久产品原则：会话交接可后续单独设计，GUI 与终端同时操作同一个运行实例不作为当前架构前提，见 [ADR-0031](docs/adr/0031-bundled-pi-runtime-and-extension-compatibility.md)。
_Avoid_: Session Import, auto-discovery, session directory scan, background sync, projection backfill for external sessions

**Session Status**:
Session Projection 使用的内部收敛状态集合：`creating`、`running`、`waiting`、`failed`、`completed`、`archived`。Draft 不属于 Session Status。UI 不直接暴露完整内部集合；Session 列表首版只用 spinner/shimmer 这类动态图标表达 active run。失败和完成都作为 Live Chat 中的新结果/消息呈现，不在列表里做状态区分。
_Avoid_: Draft, full UI status taxonomy, arbitrary runtime string

**Archived Session**:
用户从默认工作视图中隐藏的 Session。Archived Session 默认不显示在左侧 Session 列表中，但仍可通过 Analyze 或历史入口找回。归档是 visibility 变化，不删除 Session Projection、Session Trajectory、checkout snapshot 或审计材料。正在运行的 Session 不能直接归档；必须先 stop/abort 到没有 active run。
_Avoid_: Delete, completed, cleanup

**Unread Result Indicator**:
Session 列表中的轻量消息提示，表示该 Session 有用户尚未看过的新消息、run 结果或失败说明。它不是 Session Status，也不区分失败和完成。只有用户打开该 Session，且 Live Chat 渲染到最新消息位置后才清除；hover 列表项或切换 Project 不清除。
_Avoid_: Error badge, completed badge, runtime status

**Session List Ordering**:
Project 与 Chats 下 Session 列表按用户最后一次成功发送消息的时间倒序，包括普通发送、Queue 和 Steer；尚无发送记录的新 Session 按创建时间排序。运行状态、助手输出、未读结果、打开会话和草稿编辑不改变顺序，提醒与导航顺序分离。
_Avoid_: Runtime activity ordering, unread-first ordering, last-opened ordering, draft ordering

**Live Session View**:
Pace 中正在运行或可继续交互的 Session 界面。它以 Pi RPC/event stream 和当前 Pi Session State 为主数据源；Session Trajectory 只用于 backfill、恢复、审计和 Analyze。首版采用左侧 Project/Session 列表、中间 Live Chat + run timeline、右侧 Dock 的三栏结构（首版称 Structured Action Surface）；Dock 里的 Terminal / Browser Surface 已由 ADR-0028 / 0029 解冻，只读的 Files Surface 由 ADR-0035 解冻；编辑仍不包含。
_Avoid_: Trace replay, analyze page, log viewer, IDE

**Steer**:
active run 期间用户给当前 Pi 运行追加的方向修正。Pi 会在当前工具调用结束后、下一次模型调用前处理它。它只在输入会进入 Queue 的 active run 场景中作为显式替代动作出现，让用户选择排队下一步还是插入方向修正。Steer 提交后应立即出现在 Live Chat 屏里，作为当前 active run 下的 steer 消息/控制事件展示；它不是 Queued Message。UI 入口文案直接使用 `Steer`。
_Avoid_: Stop, abort, follow-up

**Queue**:
active run 期间用户排队的下一条 follow-up prompt。它不改变当前正在执行的 turn，而是在当前 run 停下来后继续处理。有 active run 时，Live Session 输入区默认提交行为和 Enter 键提交都走 Queue；主提交按钮仍使用发送图标，但 tooltip/状态说明为 `Queue`。没有 active run 时不显示 Queue。
_Avoid_: Immediate steer, task queue, scheduler

**Queued Message**:
用户在 active run 期间通过 Queue 提交、但 Pi 尚未开始处理的 pending follow-up。它应立即在 Live Session View 中以独立 pending 区域或样式显示，不直接混入正式 Live Chat 消息流；Pi 开始处理后才转为正式消息。处理开始前支持撤回；处理开始后不可撤回，只能用 Queue/Steer 修正。首版不支持重排，多个 Queued Message 按提交顺序执行。
_Avoid_: Sent message, Live Chat final message, task

**Analyze**:
Project 中用于复盘和比较历史 Session Trajectory、用量、成本、工具调用和模型行为的分析视角。它回答“过去发生了什么、贵在哪里、模式是什么”，不负责发起新的 Pi Chat。
_Avoid_: Session list, chat, control plane

**Control Plane**:
Pace 中负责创建、启动、切换、管理和观察 Agent Workspace 的产品层。它可以触发 agent 行为，因此不同于只读的飞行记录仪。它管的是 Agent Workspace，不是 Pi 的扩展体系；后者的管理面叫 Resource Management。
_Avoid_: Flight recorder, passive observer, extension control plane

**Pi Runtime**:
Pace 唯一支持的 agent runtime，负责模型调用、工具执行、session 状态、配置加载和 Pi 原生扩展能力。Pace 不把其他 agent runtime 纳入产品边界。 Pi 自身的扩展层级（Package → Resource，Resource 分 Extension、Skill、Prompt、Theme 四类）词义以 Pi 为准，Pace 不扩展；下面的 **Package**、**Resource** 词条只是为了引用方便而复述 Pi 的定义。Pace 只命名扩展贡献的东西（如 Surface）和自己新增的取值（如 Origin 的 drop-in），不为贡献方另造名词（ADR-0032）。
_Avoid_: Generic agent runtime, ACP agent, provider

**Resource Management**:
Pace 插件系统三个面里的管理面：安装、卸载、更新 Package，启用、禁用 Resource，并展示版本与加载诊断。另外两个面是贡献面（扩展向 GUI 声明 Surface、UI request，ADR-0018 / #85）和执行面（Pi 加载并运行 Resource，Pace 不介入）。首版只管 user scope（`~/.pi/agent/settings.json`），Package 与 Filter 写回走 Pi SDK 的 `PackageManager` 与 `SettingsManager`，不 spawn `pi` CLI，不引入 Pi 没有的概念；settings 变更与 Pi 一致，在下一个 Session 创建时生效，运行中的 Session 不受影响。它的入口是主侧边栏的 Packages 页（路由 `/packages`，旧的 `/setup` 重定向过去），与 Trajectory、Usage 并列：Add local resource 将本地资源复制到约定目录；不提供本地 Package 的 Register。Pi 0.84.3 忽略单文件／裸目录本地包的 Filter，因此不能原生禁用，Pace 明确报错。详情关联最近活动 Session 的扩展错误，包行展示 Update available（ADR-0037）。
_Avoid_: Extension control plane, plugin manager, marketplace, profile, workspace-scope toggle, hot reload

**Package**:
用户安装、卸载、更新的单位，对应 Pi settings `packages` 数组里的一项。它由 Source 标识，展开后包含零到多个 Resource；自写的单文件 extension 经 `pi install ./foo.ts` 登记后也是一个 Package，只是只含一个 Resource，用户不需要"单文件包"概念。Package 本身没有开关，禁用作用在它的 Resource 上。
_Avoid_: Plugin, extension (as umbrella), bundle, source (as noun for the thing installed)

**Resource**:
启用、禁用的单位，Pi 加载的最小可视对象，四类：Extension（注册 tool / command / event handler 的代码模块）、Skill、Prompt（prompt template）、Theme。产品文案不再拿 extension 当四类的统称。Theme 只影响 Pi 终端，对 Pace GUI 无效，管理面只读展示并标注；Skill 的启用状态被 composer 插入菜单直接消费。禁用在 Pi 里靠 settings 的 package Filter 表达，没有独立开关 API。
_Avoid_: Extension (as umbrella), plugin, capability, feature flag

**Source**:
Package 的地址，是属性不是名词性的"东西"：取值 `npm:`、`git:` 或本地路径（文件或目录）。npm / git 会下载到 `~/.pi/agent/npm/`，本地路径只登记不复制。它出现在安装输入框与 Package 详情里，不出现在动作文案里。
_Avoid_: Registry, marketplace, install target (as verb object)

**Origin**:
一个 Resource 的来历，Package 详情与 Resource 行上的字段：`package`（从某个 Package 展开）、`top-level`（settings 顶层 `extensions` / `skills` / `prompts` / `themes` 数组）、`drop-in`（`~/.pi/agent/{extensions,skills,prompts,themes}/` 约定目录自动发现）。前两个是 Pi `PathMetadata.origin` 的原值，`drop-in` 是 Pace 为约定目录发现的资源新增的取值，Pi 自己没有命名它。drop-in 的 Resource 不属于任何 Package、没有 Source，"卸载"它等于删文件；local Source 的 Package 卸载只移除登记不删文件。
_Avoid_: Provider (that is the Surface field), scope, kind

**Runtime Gateway**:
Pace 在客户端/后端与 Pi 接入实现之间固定的产品语义边界。它稳定表达 Session、Prompt、Queue、Steer、Stop、Snapshot 和 Runtime Event，不等同于 Pi SDK API 或 Pi RPC 原始协议。
_Avoid_: AI Gateway, Pi SDK API, Pi RPC protocol, renderer bridge

**Model**:
由 Pi Runtime 使用的底层 LLM 选择，可以跨 provider 切换并影响 reasoning、成本和上下文能力。它不是 Agent Runtime；Pace 支持多模型不等于支持多 agent。
_Avoid_: Runtime, agent, workspace

**Agent Run**:
Agent Workspace 中一次可运行、可停止、可观察的 Pi Runtime 实例。一个 workspace 可以同时拥有多个 Agent Run；每个 Agent Run 对应独立 Pi session 状态和 Session Trajectory；每个根 Session 的运行环境彼此隔离。它是 runtime 实例语义，不是一次 agent loop 执行；后者叫 Active Run。
_Avoid_: Workspace, model, task label, active run, agent loop run

**Subagent**:
由插件在根 Session 下创建和管理的子代理。主 Agent 通过插件工具委派、继续或取消任务，插件负责子会话的创建、运行、保留复用和释放。后台子代理可以在父 Active Run 完成后继续执行；任务完成不等于子会话销毁。用户主要通过主 Session 获取结果，不要求把每个子代理作为单独管理或观测的对象。它不是侧栏中的另一条根 Session，也不意味着独立操作系统进程。
_Avoid_: fork, detached process, Active Run

**Active Run**:
Session 中一次由 prompt 提交、steer 恢复或 queued follow-up 触发的 agent loop 执行，边界来自 agent-core 的 run 生命周期。它是 Live Chat 消息归属、Steer/Queue 可用性和 Session 运行状态的权威边界；协议中的 runId 指 Active Run。一个 Session 先后可以有多个 Active Run，但同一时刻最多一个；retry 和 steer 发生在当前 Active Run 内部，不产生新的 Active Run。
_Avoid_: Agent Run, runtime instance, turn, prompt cycle, session

**Turn**:
Active Run 内一次 model response 加 tool execution 循环的边界。一个 Active Run 包含一个或多个 Turn；同一 Turn 产生的 thinking、回答文本和 tool call 都归属该 Turn。
_Avoid_: Active Run, message, round trip

**Assistant Message**:
Turn 内一次模型调用的完整产出，由协议的 message(start/end) 界定，内部是按模型生成顺序排列的 Message Part。一个 Turn 正常只有一条；retry 会留下标记为 abandoned 的 Assistant Message，它的内容不是回答。它是「模型说了什么」的单位，不是 UI 气泡：一条 Assistant Message 的 Part 可能分别落在 Chain of Thought 和回答气泡里。
_Avoid_: Bubble, reply, response, turn, chat message

**Message Part**:
Assistant Message 内一段连续内容，partType 为 thinking、text、tool_call、image 之一，有独立 partId 和 start/update/end 生命周期。它落在哪个 surface 由 partType 决定（text/image 进 chat，thinking/tool_call 进 trace），page 不重新推断。
_Avoid_: Chunk, delta, block, segment, content index

**Thinking**:
partType 为 thinking 的 Message Part，即模型的推理正文。它属于 trace surface：在 Chain of Thought 里是一行 step（Live 时是「Thinking…」，settled 后是「Thought Ns」），正文展开可读。provider 常常只给摘要甚至不给正文，空正文是正常状态。它不是 Interim Output，后者是模型对用户说的话。
_Avoid_: Reasoning text, CoT, thought log, trace

**Tool Call**:
partType 为 tool_call 的 Message Part，即模型发出的调用意图（工具名和参数）。它只是意图，不是执行；执行叫 Tool Execution。
_Avoid_: Tool execution, tool run, function call, tool use

**Tool Execution**:
Pi Runtime 对一个 Tool Call 的真实执行，由协议的 tool 事件 start/update/end 界定，通过 toolCallId 关联回 Tool Call，有 announced/running/done 状态、耗时和 isError。它发生在所属 Assistant Message 结束之后、下一个 Turn 开始之前。
_Avoid_: Tool call, tool result message, tool step

**Interim Output**:
非最后一个 Turn 里 partType 为 text 的 Message Part，即模型在继续调用工具前对用户说的过程性话语。协议上它和 Final Answer 是同一种 Part，只有在所属 Assistant Message 结束并确认含 Tool Call 之后才能判定；Live 阶段一律先按 Final Answer 推定呈现。它在 UI 中归属 Chain of Thought 的时间线，不是独立回答气泡。
_Avoid_: Partial answer, progress message, final answer, status

**Final Answer**:
Active Run 最后一个 Turn 里 partType 为 text 的 Message Part，即所属 Assistant Message 不含 Tool Call 的那段文本。它是 Live Chat 回答气泡和 ActionBar 的归属对象。Live 阶段只能推定（见 Interim Output），run(end) 之后才能确定。
_Avoid_: Response, output, message, reply

**Chain of Thought**:
Live Chat 中承载一个 Active Run 全部过程内容的区域：Thinking、Tool Call 与 Tool Execution、Interim Output，按 Turn 顺序排成一列同形的 step。run 期间列表平铺、最后一行是走表的状态行；run(end) 时整列折进「Worked for Ns」头部，折叠只发生一次。它按 Active Run 存在，不按 Assistant Message 存在；它的阶段由 Session Projection 统一推导（见 ADR-0030），组件不自行判断。
_Avoid_: Reasoning, thinking panel, trace, run timeline, CoT rail

**Execution Checkout**:
Agent Run 操作文件系统时所属的 checkout，可以是前台本地目录，也可以在 Git Project 中是 Pace 管理的 Git worktree。它是并发运行的文件隔离边界。非 Git Project 可以使用 foreground local directory 运行 Session，但 Git-only 的 diff、managed worktree、commit、push 和 PR 能力不可用。
_Avoid_: Branch, session, workspace, Git requirement

**Pi Session State**:
由 Pi Runtime 拥有的 session 真相，包括消息、运行状态、模型配置、队列、fork/follow-up/abort 等 Pi 原生语义。Pace 通过 RPC/SDK 观察和驱动它，但不重新定义一套独立 chat 协议。
_Avoid_: Pace database record, trace, UI cache

**Runtime Event Stream**:
Pi Runtime 在 Session 运行期间向 Pace 暴露的 live 事件流，包括消息增量、工具调用、状态变更、错误、队列变化和 token/cost 增量。它驱动 Live Session View，并同步更新 Session Projection。
_Avoid_: Historical trace, file log tail, polling-only UI

**Session Event Journal**:
Runtime Gateway 为每个 Pi session 保存的边界事件日志，只收录归一化事件流中的生命周期边界，不收录流式增量。它是 Session 重放与快照恢复的事件来源：加载它得到完整静态时间线，永远不会重放 streaming。它不是 Pi Session State（Pi 自己的会话真相），也不是 Session Projection（renderer 的查询模型）。
_Avoid_: Pi session file, projection cache, event replay stream, chat history

**Structured Action Surface**:
Pace 首版替代 terminal/file-tree 的结构化操作面，通常位于 Session 页右侧，承载 diff 摘要、checkout 信息、模型/成本摘要、打开外部编辑器、运行预设命令、handoff、commit、push、PR、archive 等明确动作。它不提供任意 shell 交互，也不承担通用文件浏览器职责。这是 ADR-0008 时期的职责边界，Terminal 与 Browser 解冻后区域本身由 Dock + Surface 承载（ADR-0032），词条保留作历史定义。
_Avoid_: Terminal emulator, file explorer, IDE panel

**Dock**:
Live Session 页右侧宿主的整体：Surface 内容区加贴在右缘的图标 Rail。由工具栏开关开合、可拖宽，关闭时整体消失，窗口边上不留常驻物。它是 Session 级工作面板的停靠区，内置 Surface 与将来由 Pi 扩展注册的 Surface 都停在这里；形态是 ADR-0028 选定的 Rail 式面板，与 ADR-0028 否掉的"Dock 原型"（tab 条 + launcher）无关。
_Avoid_: Inspector, sidebar, side panel, secondary sidebar, tool window

**Rail**:
Dock 右缘的 44px 图标列，每格对应一个 Surface，单选切换，可带徽标（如 Changes 文件数、Terminal 实例数）。它是 Dock 的一部分而不是窗口 chrome：Dock 关闭时 Rail 一起消失。
_Avoid_: Activity bar, tab bar, toolbar

**Surface**:
Dock 里的一个面板，绑定当前 Session（它的 Execution Checkout、shell、预览页）。每个 Surface 在 Rail 上占一格，有 id、标题、图标、提示；多实例 Surface（如 Terminal）共用一格并在面板表头列出实例。Surface 的来源记在 provider 字段：`builtin` 或 Pi 的 extension id。
_Avoid_: Panel, tab, view, plugin, widget

**Built-in Surface**:
Pace 自带的 Surface：Changes、Files、Terminal、Browser。它们与将来扩展注册的 Surface 走同一套注册表与 Rail，只是 provider 为 `builtin`。Files 是只读的 checkout 目录树加文件预览（ADR-0035）。
_Avoid_: Core panel, native panel, first-party plugin

**Session Projection**:
Pace 自己保存的查询模型，用来支撑 Session 列表、Analyze、状态索引、成本聚合、checkout 生命周期、恢复入口和 UI 快速渲染。它是从 Pi Session State、Session Trajectory 和 Pace checkout 管理事件同步出来的投影，不是 Pi 会话内容的权威来源。
_Avoid_: Runtime truth, independent chat state, source of record

**Task**:
未来用于描述定时任务、自动化任务或队列化任务的术语。普通用户发起的一次 Pi 工作在 UI 中叫 Session，不叫 Task。
_Avoid_: Session, run, trace
