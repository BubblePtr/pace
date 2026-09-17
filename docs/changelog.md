# 更新日志维护

Settings Dialog 的 Changelog 分类展示正式发布的用户可感知变化，入口使用当前路由的 `settings=changelog` 查询参数。打开与切换分类沿用设置弹窗行为，保留工作区和未保存的设置输入。

## 内容来源

唯一数据源是 `apps/desktop/src/entities/release/changelog.ts` 的 `changelogReleases`。内容随应用打包，因此断网也能阅读；不会在打开设置时请求 GitHub。当前构建收录 v0.0.1 至 v0.0.12，最新条目随 v0.0.12 发布。v0.0.12 的中文说明见 [发布说明](release/0.0.12.md)，涵盖排队消息拖拽重排与 steer、会话自动命名、Browser 空白启动及中断 run 结清修复。v0.0.11 的中文说明见 [发布说明](release/0.0.11.md)，涵盖 Usage 成本驾驶舱、内置 Pi 0.85.1 及会话创建时的模型选择修复。v0.0.10 的中文说明见 [发布说明](release/0.0.10.md)，涵盖 Trajectory 子会话深链、子代理停止控制及 Dock 提示位置修复。v0.0.9 的中文说明见 [发布说明](release/0.0.9.md)，涵盖历史会话即时回放、根会话进程隔离及后台扩展免系统 Node。v0.0.8 的中文说明见 [发布说明](release/0.0.8.md)，涵盖工具图标恢复静态、失败工具单行摘要及输入框层级修复。v0.0.7 的中文说明见 [发布说明](release/0.0.7.md)，涵盖 Shell 动画图标、双栏 Header 对齐、Live Chat 抢占修复及系统 Node 支持后台扩展。v0.0.6 的中文说明见 [发布说明](release/0.0.6.md)，涵盖会话列表按最近提交排序、列表头部简化及投影状态和标题宽度修复。v0.0.5 涵盖聊天文件链接、工作区自动刷新、会话恢复提示及界面和日志修复。v0.0.4 根据 [正式发布记录](https://github.com/BubblePtr/pace/releases/tag/v0.0.4) 和 [v0.0.3 至 v0.0.4 的实际改动](https://github.com/BubblePtr/pace/compare/v0.0.3...v0.0.4) 整理，UTC 发布日期为 2026-09-10，涵盖 Packages 市场、资源管理及 Changes／Files 面板改进。

页面文案沿用应用现有的英文界面。仅展示已发布功能，不把主干上的未发布变更或开发计划计入历史版本。每个版本附原始 GitHub Release 链接；桌面端通过已有 `browser_open_external` 通道打开系统浏览器，失败时在链接下提示重试。

## 新版本发布时

1. 在发布构建前为本次发布补充一条记录：`version` 不带 `v` 前缀，`date` 使用 UTC 发布日的 `YYYY-MM-DD`，`url` 指向对应 GitHub Release。
2. 填写简短标题、摘要及 `changes`。每项变更包含 `kind`、面向用户的标题和说明；`added`、`improved`、`fixed` 分别显示为新功能、改进和修复，空分类不展示。
3. 页面按日期倒序排列，同日发布的条目在数据中保持新版本在前。日期按 UTC 显示，避免用户时区把发布日期移到前一天。Latest 标记指向随当前构建收录的最新版本，不代表已联网检查更新。
4. 运行 `bun run test apps/desktop/src/pages/settings.test.tsx apps/desktop/src/pages/settings-changelog.test.tsx` 和 `bun run build`，并在开发页面检查桌面、窄窗口与内容滚动。离线记录测试从桌面应用的 `package.json` 读取版本，要求首条记录匹配当前版本、包含变更及对应 Release 链接，并保留历史版本；升级版本号时漏补记录会使测试失败。

更新已发布版本的历史说明需要随下一次应用构建分发。检查是否有新版本与下载更新仍由 About & Updates 分类负责。
