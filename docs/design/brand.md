# Pace 品牌资源

## 已确认的方向

软件侧栏不展示品牌字标，让导航与会话内容成为重点。Figma 04 版独立 PACE 矢量字标保留为官网、宣传图片与社媒背景的品牌资源，采用平直端点和切角轮廓。应用图标使用圆润开口 P、黑白底稿与 Icon Composer 原生材质；不使用 Figma 中的烟晶、冰晶或 IP 插画探索版。

设计来源：[Figma 第 04 版字标](https://www.figma.com/design/r5HLnoU3mVD8ddnAXMiGrA?node-id=3-197)，以及 `build/Pace.icon` 源工程。

## 字标资源

`PaceWordmark` 位于 `apps/desktop/src/shared/ui/pace-wordmark.tsx`，直接保留确认后的六条矢量路径，不依赖字体。默认高度为 `h-6`，宽高比为 824:180，颜色继承 `currentColor`；明暗主题使用界面的 foreground。字标和应用图标保持极简的黑白呈现。

字标不用于工作区侧栏；Design 页保留资源预览。仅用于品牌识别，不添加点击行为。根 SVG 默认 `role="img"`、`aria-label="Pace"`，支持 `className` 与其他 SVG 属性透传。Design 页展示小尺寸和大尺寸。

## Pi 强调色

Pace 的 logo 与界面主体保持黑白极简，但颜色可以在"Pi 在场"的位置出现：Pi 是 Pace 唯一的引擎，用 Pi 图标的三色标记这种关系。三色取自 [pi.dev press-kit](https://pi.dev/press-kit)：珊瑚 `#F09082`、蓝 `#4D9ABF`、黄 `#F1BE58`，以 `--pi-coral` / `--pi-blue` / `--pi-yellow` 注册在 `apps/desktop/src/app/styles.css`。

目前使用的位置只有两处：新会话空屏标题中的 "Pace" 字样（`TextShimmer` 的 `tone="brand"` 变体）和 composer 聚焦、发送时的三色描边。不要把三色扩散到侧栏、列表或状态文案；"Thinking…" 一类的运行态 shimmer 仍然是灰色。

## 应用图标

About & Updates 顶部使用同一份 `build/icon-512.png`，配合界面标准字体显示 **Pace Agent** 和版本号，不使用艺术字标。图标与名称相邻，图片使用空 alt 避免重复朗读。

`build/Pace.icon/Assets/P-rounded.svg` 是独立前景层，保留 1024 画布及原始位置；背景和 Liquid Glass 参数保存在 `icon.json`。编辑后运行 `bun run build:icon:mac`，一起提交源工程和三个生成文件：

- `build/Assets.car`：由 Xcode actool 编译，macOS 打包复制到应用 Resources，通过 `CFBundleIconName=Pace` 使用系统渲染。
- `build/icon.icns`：旧 macOS 与 Linux 的兼容图标，包含 16–1024 像素。
- `build/icon-512.png`：未打包 Electron 的 Dock 图标。

兼容图标来自同一个 Icon Composer 默认外观渲染，不另画一套；透明外沿按 actool 的 macOS 图标比例保留。日常打包使用已提交的生成资源，不要求 Linux 或 CI 安装 Icon Composer。

应用标识、界面文案与发布产物统一使用 Pace，macOS bundle id 固定为 `com.bubbleptr.pace`。后端数据目录使用 `~/.pace`（开发版 `~/.pace-dev`），Electron userData 通过 `app.setName("Pace")` 固定并保留开发版 `-dev` 隔离；旧目录的迁移与失败回退规则见 [自举隔离说明](../dogfooding.md)。内部包作用域、环境变量、localStorage、IPC 与 CSS 前缀本轮保留。
