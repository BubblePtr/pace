# ADR-0037：Resource Management 与 Pi 原生管理边界

- 状态：Accepted
- 日期：2026-09-10
- 来源：Resource Management PRD、#251–#254 与实现期 SDK contract tests

## 背景

[ADR-0031](0031-bundled-pi-runtime-and-extension-compatibility.md) 承诺扩展安装、启用配置与加载故障可理解、可诊断。只读 Config Inventory 不能让用户在 Pace 中处理这些配置；已有事件历史虽然保留加载与事件处理错误，也还没有关联到资源管理页。本 ADR 落实其可诊断承诺，不另建扩展生态或诊断事件通道。

## 决策

### 1. 三个面各自负责

| 面 | 责任 |
| --- | --- |
| 管理面（Resource Management） | 主侧边栏 Packages 页（`/packages`）中安装、卸载、更新 Package，开关 Resource，导入和删除 drop-in，展示更新与历史错误 |
| 贡献面 | Extension 声明 GUI Surface 与标准 UI request；由 ADR-0018、#85 后续推进 |
| 执行面 | Pi 加载并运行资源；Pace 不接管执行与上下文真相 |

只跟 Pi 原生走，初期不为 Pi 拓展功能。首版只操作 user scope（`~/.pi/agent/settings.json`，可由 `PI_CODING_AGENT_DIR` 指定），不引入 project scope、Project Trust、profile、整包禁用、市场或热重载。

### 2. Package 是安装单位，Resource 是开关单位

Package 由 Source 标识，对应 settings 的 packages 项；展开后包含 Extension、Skill、Prompt、Theme。用户动作使用 Install / Remove / Update package，不以 Source 命名动作。

约定目录自动发现的资源没有 Package。Pace 将 Pi 元数据中 `metadata.source === "auto"` 的资源标为 Origin `drop-in`；Pi 本身仍将其归入 top-level，contract test 守住此映射。显式写入顶层数组的资源保留 top-level。

Theme 只影响 Pi 终端，GUI 只读展示。drop-in 没有 Package Filter，不显示开关，提供 Reveal in Finder 和确认后删除；顶层显式资源同样不支持 Package Filter。Skill 开关后失效共享 inventory query，composer 插入菜单同步刷新。

### 3. 本地文件只提供 Add local resource

安装框接收 npm / git 来源，交给 SDK 校验与安装。本地 extension 文件（`.ts` / `.js`）、prompt（`.md`）、theme（`.json`）和含 `SKILL.md` 的 Skill 目录由 Add local resource 复制到对应约定目录；同名覆盖与删除必须确认，删除 Skill 会删除整个目录。

不提供 Register（`pi install ./path` 的 GUI 版）：它与复制进约定目录重复，原文件移动后 Pi 还会报告登记路径缺失。CLI 已登记的本地 Package 仍可展示与卸载，卸载只移除登记，保留源文件。

### 4. 写回走 SDK，并承认原生限制

后端使用 `DefaultPackageManager` 和 `SettingsManager`，不 spawn CLI。每次动作重新读取 settings，同 agentDir 的写动作串行化；SDK FileSettingsStorage 锁保护落盘，写后等待 `flush()` 并检查 `drainErrors()`，不能把失败报告为成功。不同进程同时更新 packages 数组仍受 SDK 的最后写入语义约束，Pace 不承诺跨进程事务。

Resource Filter 用 `+path` / `-path` 精确项，不用 `!pattern`：文件名可能含 glob 字符，而且 `!` 无法覆盖已有 `+path`。Pi 0.84.3 至 0.85.1 对 CLI 登记的单文件本地包和裸目录包忽略 Filter，无法原生禁用；UI 禁用控件并解释，后端返回明确错误，不写出假成功，SDK contract test 固定这一边界。

管理动作没有 Session 身份。进度由 SDK callback 累计，随方法结果一次性返回，不进入 Session 事件流；实时进度通道留待后续设计。settings 变更在下一个新 Session 生效，运行中的 Session 不受影响，`/reload` 不纳入。

### 5. 诊断读取已有证据，更新检查按需执行

`get_config_inventory` 在只读 inventory 上附加 Resource 的 `lastError`，无需新增 gateway 方法。读取 Session Projection 中 `updatedAt` 最新的 Session（即最近活动的 Session）的 journal，只取 `extension_load_error` 与 `extension_error`；按 ADR-0031 的 `path: detail` 消息格式，用完整资源路径或目录子路径边界关联，显示该资源最新错误的时间与消息。Package 详情与独立 drop-in 行共用展示，无错误不占位。最近 Session 没有错误或没有 journal 时，不回退展示旧 Session 的错误；配置为 enabled 不等于实际加载成功。

Packages 页打开时检查一次 `check_package_updates`，不按窗口聚焦、重连或后台定时轮询。按 Source 与 Scope 给 Package 行显示 `Update available` Token；安装、卸载或更新成功后失效更新查询，重查后移除已更新的徽标。检查失败显式展示错误，不阻断资源管理动作。

### 6. 后续：Marketplace 发现入口

2026-09-10，用户在三个交互原型中选择 Marketplace，并授权正式落地。第 1 节“首版不引入市场”的阶段限制至此结束；Package / Resource、user scope、SDK 写回与生效时机保持原决策。

Discover 查询 npm 公共目录中标记 `pi-package` 的包，安装仍交给 Pi；Pace 不维护自己的包仓库或评分。主题推荐进入目录搜索，详情中的资源控制来自本地库存，不能用 manifest 里的目录声明模拟已安装 Resource。目录请求失败时，Installed 和 Updates 保持独立。完整布局、分页与类型筛选边界见 [Packages Marketplace 设计决定](../design/packages-marketplace.md)。

## 后果与验证

- 资源配置仍使用 Pi 原生格式；查询不安装、不执行扩展、不写 settings，运行事件仍由既有 journal 持有。
- 诊断依赖现有消息中的路径格式；未来 SDK 或适配器改变该格式时，需要同步 contract 与关联测试，不可改用任意消息子串猜测归属。
- 后端 mkdtemp fixture journal 测试覆盖最近 Session、路径边界、目录扩展与最新错误；Setup 行为测试覆盖徽标检查和更新后的重查、Package / drop-in 错误时间与空态。
- SDK 写回与本地包 Filter 限制见 `resource-management.test.ts`，Origin 映射见 `config.test.ts`；全仓 typecheck、test 与 UI 截图作为交付检查。
