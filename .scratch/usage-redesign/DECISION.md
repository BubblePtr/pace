# Usage 页重构 — 决策记录

日期：2026-09-17 · 来源：`/proto/usage` 两轮原型（emil-prototype 流程）

## 选定：Cockpit + Rhythm

- 骨架：周期选择（7D / 30D / 90D / All）→ 4 个 KPI 卡（Cost / Tokens / Sessions / Avg cost per session，各带火花线与环比）→ 日成本折线（悬停十字线，tooltip 给项目拆分）→ **Rhythm 热力图（星期 × 小时，本地时间，当前周期）** → By project / By model 排行 → Tools / Skills 排行。
- 主口径为 **USD 成本**，token 降为次要指标。
- 热力图分档按**排名**而非线性比例（离群日不再把全年压平）；顺序色由 `--pigui-data-blue` 经 `color-mix` 向 `--surface` 推五档，不新增 token。
- 图表为手写 SVG 原语，不引入图表库。

## 否决

- **Baseline（现状）**：token / 成本双口径混杂，长项目路径撑破图例。
- **Ledger（行优先 + 会话表）**：偏账单明细工具，作为主页面缺分布与趋势；会话表可能后续作为 Cockpit 底部区块回归。
- **Digest（编辑式月报 + 月历）**：只有月粒度，作为唯一 Usage 视图偏窄。
- **Calendar（全年日历热力图）**：52 列在页面里太短，右侧空荡；只读。
- **Drill（可点击日历 + 会话表）**：交互最重，选中某天后 KPI 与热力图两套口径并存。

## 前提修正

Pace 已是完整桌面 Agent，不再以"观测台账"作为唯一页面语言评判 UI；标准分析仪表盘形状的通用性是优点。README / AGENTS.md 的观测定位描述待更新（另开）。

## 待办 / 已知问题

- 日分桶用 UTC、Rhythm 用本地时间，口径需统一（沿用自旧 `usage-aggregation`）。
- 后续按需要再加图表（用户原话："后面再看看到底需要什么图表，再加"）。
