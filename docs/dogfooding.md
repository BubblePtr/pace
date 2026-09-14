# 用 Pace 开发 Pace（自举）

从 v0.0.1 起，Pace 自己也是开发 Pace 的工具之一。本文只记录为此必须成立的隔离规则；checkout 的选择不做特殊规定，本地 checkout 谁空闲谁用，被占用时其他工具走 worktree。

## 两个实例

- **宿主实例**：`/Applications` 里安装的正式版，只跑已发布版本，是日常使用的那份。
- **被测实例**：在某个 checkout 里执行 `bun run dev` 启动的开发版，只用来验证改动。

两者角色不互换：不要把 `bun run dev` 当宿主长期使用。

只检查会话排版、Session 列表或 Dock 的 Changes / Files 时，可以运行 `bun run dev:mock` 使用[静态功能场景](dev-static-mocks.md)，无需新开真实对话。

## 数据目录隔离

| 数据 | 宿主（打包版） | 被测（`bun run dev`） | 说明 |
| --- | --- | --- | --- |
| Pace 后端数据（journal、projections、preflight 状态） | `~/.pace` | `~/.pace-dev` | 主进程按 `app.isPackaged` 决定，见 `apps/desktop/electron/backend-environment.ts`；显式设置 `PACE_DATA_DIR` 时以其为准（`PIGUI_DATA_DIR` 仍可读一个 MINOR 版本） |
| Electron userData（renderer 的 localStorage：项目注册表、草稿、模型偏好，以及 Chromium profile） | `~/Library/Application Support/Pace` | `~/Library/Application Support/Pace-dev` | 主进程在未打包时追加 `-dev` 后缀；显式传 `--user-data-dir` 时以其为准（E2E 用法）。这一步同时是 dev 实例能与正式版并存的前提：Chromium 同一 profile 只允许一个进程，第二个会直接退出 |
| Pi 自己的数据（`~/.pi/agent`：会话、认证、扩展） | 共享 | 共享 | Pi 拥有会话真相，Pace 只读；共享认证避免重复登录 |

预检页会显示后端数据目录，可以据此确认当前实例写到哪里。默认数据目录由启动入口执行迁移时创建；单纯解析路径不会读写文件系统，迁移失败时预检页显示回退后的旧目录。

## 兼容约束

首次启动 Pace 时，若新目录不存在而旧目录存在，正式版会将 `~/.pigui` 整体重命名为 `~/.pace`，开发版独立将 `~/.pigui-dev` 迁移为 `~/.pace-dev`。Electron 通过 `app.setName("Pace")` 固定 userData 名称，再分别将 `Application Support/@pigui/desktop`、`Application Support/@pigui/desktop-dev` 迁移到 `Application Support/Pace`、`Application Support/Pace-dev`（其他平台使用各自的 appData 根目录）。

所有迁移都在首次读写前执行：新旧目录同时存在时，新目录优先，旧目录不动；重命名失败时记录警告并继续使用旧目录，不创建空的新目录替代历史数据。显式 `PACE_DATA_DIR`（或已弃用的 `PIGUI_DATA_DIR`）和 `--user-data-dir` 分别跳过对应迁移。任何改动 journal 或 projection 格式的 PR 都必须保持向后兼容读取或附带迁移，否则升级宿主会丢失历史。

## 查看历史与继续执行

打开历史会话时，Pace 直接回放已保存的消息和工具记录，不启动 Agent 或加载扩展。正在运行的会话会继续显示实时事件，切换页面不会停止它的后台任务。

重启后第一次发送消息或切换模型时，Pace 才恢复该会话的执行环境。发送期间输入框显示等待状态；若 Pi 文件、执行目录或扩展初始化有问题，错误显示在操作处，历史仍可查看，发送草稿保留供重试。模型目录可在恢复前读取。自动化验证和分段耗时见 [#304 验证记录](verification/304-lazy-session-history.md)。

## 发版节奏

宿主使用中遇到的问题记为 GitHub Issue 并打 `dogfood` 标签；攒成批次后按 [docs/release/macos.md](release/macos.md) 升 PATCH 发版。本地保留上一版 DMG，新版宿主不可用时回退。
