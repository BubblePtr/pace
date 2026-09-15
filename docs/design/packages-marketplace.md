# Packages Marketplace 设计决定

2026-09-10，用户比较 Baseline、Marketplace 和 Directory 后选定 Marketplace，并授权落地。保留精选主题、卡片目录和独立详情弹窗；窗口栏已有 Packages 标题，内容区只保留介绍与安装入口。

## 取舍

| 方向 | 处理 | 原因 |
| --- | --- | --- |
| Marketplace | 采用 | 用户明确偏好用途优先、可探索的插件市场布局 |
| Baseline | 移除比较入口 | 密集清单的资源诊断能力保留在详情和配置检查入口 |
| Directory | 移除比较入口 | 用户选择 Marketplace；没有额外推断逐项拒绝理由 |

## 正式实现

- Discover 从 npm 公共目录查询 `pi-package`，按页加载；搜索先请求目录排序，再按输入词过滤已加载结果；类型筛选与名称排序也作用于已加载结果。npm 关键词查询只调整排序，不保证过滤掉其他 Pi 包。精选主题进入相关搜索，不维护第二套推荐包数据库。
- 目录只读，不下载或执行包代码。manifest 声明用于标识资源类型，不当成真实安装后的资源清单；声明读取失败保留包并明确显示类型未知。
- Installed、Updates、详情内 Resource 均来自已有本地库存和更新接口。版本固定的 npm 来源按包名匹配目录，但更新和移除始终使用原始来源。目录故障不阻塞本地管理。
- 安装单位为 Package，Source 只出现在属性和输入说明中。沿用真实 Pi SDK 安装、更新、移除、资源开关及下个新 Session 生效语义。
- 本地资源导入、覆盖/删除确认、配置默认值、环境检查和 journal 诊断保持可达。Theme 仍只影响 Pi 终端；top-level、裸目录与单文件包的开关限制不变。
- 使用 Astryx 现有组件和语义 token；页面组合留在 `pages/packages/`，无新增 `shared/ui/` 原语。原型目录、演示状态和变体选择器在落地后删除。
- 搜索栏文字沿用 Astryx TextInput 的默认正文字号，占位提示与输入内容同字号；保留原有输入框高度。
- 包名所在列填满图标右侧的可用空间；标题始终单行，超长名称以省略号收尾，详情仍显示完整名称。包名按钮按内容宽度收缩，文字两侧各保留 `--spacing-1` 留白，并与作者信息左对齐。悬停保留淡背景过渡，圆角使用 `--radius-inner`，不加下划线；卡片保留原有的悬停边框加深。键盘焦点沿用 Astryx，减动效模式下立即切换背景。

- 插件卡片不显示 tooltip；作者、描述和来源仍保留截断，完整信息通过详情弹窗查看。

## 验证边界

目录错误/分页、真实库存关联和写动作失效行为先写失败测试；纯版式复用按可逆 UI 组合豁免新增字面量测试。以正式页面的开发服务截图核对布局和导航。浏览器 mock 仅用于确定性视觉验收，不写用户配置。

目录协议参考 [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)；包声明参考 [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。
