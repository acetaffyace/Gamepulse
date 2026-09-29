# GamePulse 技术说明与数据口径

[返回项目首页](../README.md) · [数据层设计](v3-data-layer.md) · [开发日志](v3-log.md)

用公开数据做的游戏长线运营看板：Steam 评测与在线、B 站与 YouTube 官方视频。
当前跟踪《鸣潮》《绝区零》《异环》三款游戏的 Steam 版本与官方视频。

---

## 架构

```
config/*.yml（人工维护）      collectors/*.py（本机白天运行）
游戏 / 版本 / 视频登记 / 指标目录   Steam / 构建号 / B 站 / YouTube / SteamDB 收件箱
            │                              │
            └──────────────┬───────────────┘
                           ▼
            data/gamepulse.sqlite（本机唯一数据源，不进 git）
                           │  python -m store.build
                           │  同步配置 → 派生事件与质量提示 → 校验指标目录与数据 → 导出
                           ▼
            dist/（发布包）
              index.html · app.css · lib/ · pages/ · vendor/
              data/gamepulse.<哈希>.sqlite.gz · data/manifest.json
                           │  python tools/publish_pages.py --push
                           ▼
            gh-pages 分支 → GitHub Pages
                           │
                           ▼
            浏览器：sql.js 打开数据库 → 指标目录 + 查询生成器 → ECharts
```

- **人工维护的在 YAML，机器采集的在 SQLite。** YAML 用 git 管理、方便审阅改动；采集结果进数据库。
- **每个指标只定义一次。** 计算方式写在 SQL 视图（`store/views.sql`）和指标目录（`config/metrics.yml`）里。
  看板页面和自助查询都通过查询生成器（`web/lib/query.js`）用"指标 + 维度 + 筛选"生成 SQL，
  所以同一个数字在任何地方看都一样。
- **发布包是纯静态文件。** 不需要服务器；网页先读 `manifest.json`，再按里面带内容哈希的文件名下载数据库，
  不会读到"新目录 + 旧数据库"的混合状态。
- **数据不进 main 分支。** `gh-pages` 每次发布都是一个没有父提交的新提交，只保留最新一份。

## 这个看板回答什么

| 问题 | 在哪里看 |
|---|---|
| 最近一段时间评测、口碑、在线怎么样 | 运营总览：一行指标卡共用同一个时间范围和截止日 |
| 这个版本比上个版本同阶段表现如何 | 版本对比：两个版本按各自的 Steam 开放日对齐（D0），截到共同天数 |
| 官方视频在各语区的传播 | 视频传播：按频道语区分开；发布后同龄对比；同一内容的各语区并排 |
| 写评测的是什么人 | 玩家结构：写评测时的游戏时长、评测语种、评测后是否还在玩 |
| 任意组合 | 自助查询：选指标 × 维度 × 筛选；也可以直接写只读 SQL |
| 数据可不可信 | 数据来源：每个来源的最近尝试、有效数据截至日期、质量提示 |

贯穿始终的原则：**时间上相邻不等于因果。** 事件只标记时间，图表不推断原因。

## 快速开始

```powershell
pip install -r requirements.txt
copy .env.example .env               # 填写 YouTube Key 与本机代理（可选）

# 首次：从 v2 数据迁移（只需一次；或者直接运行采集，从空库开始）
python -m store.migrate_v2 --source <v2 项目目录>

python collect.py                    # 采集 + 构建发布包
scripts\serve.cmd                    # 本机查看：http://127.0.0.1:8770/
```

只重建发布包：`python -m store.build`。每次构建会在 `data/backups/` 留一份当天的数据库副本，保留最近 7 天。

### 自动更新（Windows 本机）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1          # 注册
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Status  # 查看状态
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Remove  # 注销
```

| 任务 | 时间 | 做什么 |
|---|---|---|
| GamePulse-Daily | 每天 13:20 | SteamDB 收件箱、Steam、构建号、B 站、YouTube，然后构建；`.env` 里 `GAMEPULSE_AUTO_PUBLISH=1` 时推送到 gh-pages |
| GamePulse-ReviewRecovery | 每天 17:00 | 增量回填近期评测（失败一小时后重试一次） |
| GamePulse-WeeklyReviewBackfill | 每周日 18:00 | 全量校准评测：删评、改评在这时更新 |

为什么在本机而不是 GitHub Actions：Actions 的 runner 在境外，B 站接口对境外 IP 有风控，
Steam 商店接口会按 IP 跳区，同一个指标会在不同日子来自不同地区口径。代价是关机时段会漏采，
缺口在图上留空并标出跨了几天，不插值。

### SteamDB 在线人数

SteamDB 没有可用的自动接口（403 / API 410），只能在网页上手动导出。做法：
在 SteamDB 游戏页的 Charts 导出 CSV（文件名形如 `steamdb_chart_3513350.csv`），放进 `data/inbox/steamdb/`，
下次采集会自动按文件名里的 App ID 匹配游戏、按日期合并导入，文件移到 `imported/`；
无法识别的移到 `rejected/`。超过 8 天没有新数据，数据来源页会标为过期。

公开发布包含 SteamDB 导出的数据，发布前请自行确认 SteamDB 的使用条款允许这种展示。

### YouTube（可选，免费）

Google Cloud Console 新建项目 → 启用 YouTube Data API v3 → 创建 API 密钥，写进 `.env`：
`YOUTUBE_API_KEY=…`。计划任务也读 `.env`。没有 Key 时 YouTube 记为"未配置"，其他来源照常。

## 数据库

表结构见 `store/migrations/001_init.sql`，设计说明见 [v3-data-layer.md](v3-data-layer.md)。

| 类别 | 表 | 说明 |
|---|---|---|
| 维度（从 YAML 同步） | `game` `version` `video` `video_pair` | 版本窗口不存，由视图推出 |
| 事实（采集器写入） | `review` `online_daily` `steam_daily` `video_obs` `steam_news` `steam_build` | 一条评测一行；视频一天一行 |
| 派生（每次构建重建） | `event` `quality_issue` | 时间轴事件、数据质量提示 |
| 运行记录 | `collection_attempt` `review_run` `build_meta` | 采集尝试、评测回填覆盖范围 |

写入规则（`store/db.py`，都有测试）：

- 采集**成功**才写事实表；失败只写 `collection_attempt`，已有数据不受影响。
- 同一主键再次写入时，传入的列整体覆盖，包括 NULL：平台隐藏的计数就是未知，不和旧值混用；没传的列不变。
- 列名按表结构校验，拼错直接报错；每批写入在一个事务里，要么全部成功要么全部不写。
- 评测全量回填在一个事务里替换该游戏的评测集合；翻页没完整结束、或者条数异常变少时不替换。

## 口径

- **日期** 一律是 UTC+8 业务日；时间戳一律存 UTC ISO。
- **缺失** 保持为空，不当作 0。覆盖范围内没有评测的日子是真实的 0。
- **比率** 一律"分子合计 ÷ 分母合计"，不对每天的比率求平均。
- **中位数与分位数** `quantile(x, p)` 线性插值（等同 `PERCENTILE_CONT`），p = 0.5 就是标准中位数，
  偶数个时取中间两个值的平均。Python 与浏览器各注册一次，用同一份样例交叉核对。
- **评测数** 按创建日统计当前仍存在的评测（删除的不计入），是"回填重建"口径，与商店显示的累计好评率不同。
  "Steam 总评测数净变化"是另一个指标，不和评测数拼接。
- **在线** 只用 SteamDB 全天平均同时在线。它只代表 Steam 平台，不是 DAU。
  SteamDB 日汇总行的 Players 是某一时点的值，不是峰值（有的日子低于日均），只保存、不展示。
- **版本窗口** 本次 Steam 开放日至下个已开放版本前一天；最新版本开放到今天（按看的人当天的日期计算）。
  已公布未在 Steam 开放的版本不构成窗口。版本对比时开放中的版本只算到最后一个完整评测日。
- **评测后留存参考** 只统计距最后一次回填已满 14 天的评测，"评测后仍在玩"指评测后又玩了 60 分钟以上。
  这是参考，不是留存率。
- **评测语种** 是写评测时选择的语言，不等于玩家所在地区。
- **视频** 只含登记的官方视频（默认只看 `video_pairs.yml` 精选范围）。同一支内容在各语区频道各发一次，
  **播放量不跨语区相加**（指标目录强制按语区分组）。互动率 B 站为（点赞+投币+收藏）÷ 播放，
  YouTube 为（点赞+评论）÷ 播放，公式不同，不直接比较。多数视频是发布后才登记的，
  首次采到时已发布几天会标出来，不从累计值倒推起跑段。

购买渠道字段（`steam_purchase`、`received_for_free`）在三款免费游戏上全部是同一个值，没有信息量，所以不做成指标。

## 指标目录与自助查询

`config/metrics.yml` 定义事实视图（可以按哪些维度拆分）、维度（中文名、值的显示名、顺序）与指标
（聚合 SQL、单位、格式、规则）。规则由查询生成器强制执行：

- `must_group_by`：必须按这些维度分开（或筛选成单个值），例如视频播放必须按频道语区分开；
- `must_group_by_one_of`：至少按其中一组分开，例如累计播放必须按日期或发布天数；
- `kind: share`：占比，分母是同一行其余维度下的合计。

违反规则时自助查询给出原因，而不是给出一个错误的数。构建时逐条校验：视图存在、维度是视图里的列、
聚合 SQL 能执行。加一个指标只需要改 `metrics.yml`。

自助查询的"直接写 SQL"只接受一条 `SELECT` / `WITH` 查询；数据库是浏览器里的副本，写入也不会影响发布的文件。
浏览器控制台里可以直接用 `gamepulse.rows('SELECT …')`。

## 发布前校验

`store/checks.py` 中任何一项失败都不发布：数据库完整性与外键；每日评测（补 0 后）的合计等于评测行数；
版本窗口首尾相接、互不重叠；每条评测最多属于一个版本窗口；比率在 0–100；精选视频都有语区。
缺采、过期这类真实世界的状况不阻止发布，由质量提示和来源状态如实展示。

公开数据库的导出（`store/export.py`）：评测明细只存一份（按"游戏 + 日期"聚簇），大视图物化成表；
失败原因里的网址、IP 与密钥参数会被去掉；本机专用的小时在线历史不公开。

## 测试

```powershell
python -m unittest discover -s tests -q   # Python：写入规则、视图（手算样例）、目录、采集器（模拟接口）、构建、发布
npm ci; npx playwright install chromium   # 首次运行前端测试前
npm test                                  # 前端：查询生成器规则、分位数与 Python 交叉核对、格式化
npm run test:e2e                          # 端到端：合成数据发布包，逐页检查数字、导出、规则、深色、手机宽度、加载失败
```

- 视图测试用手工构造的小数据，期望值手算写在测试里，不调用被测代码——这是对 SQL 口径的独立核对。
- `tests/test_parity_v2.py` 核对迁移后的数字与 v2 已发布的一致；没有 v2 数据时自动跳过（例如 CI）。
- CI（GitHub Actions）在 Ubuntu 与 Windows 上运行 Python 测试，在 Ubuntu 上运行前端测试。

## 数据源可用性（实测）

| 数据 | 来源 | 状态 |
|---|---|---|
| 当前同时在线（仅参考） | `GetNumberOfCurrentPlayers` | 可用 |
| 评测汇总 | `appreviews` | 可用 |
| 评测明细（时长 / 语种） | `appreviews` 游标翻页 | 可用 |
| 版本公告 | `ISteamNews/GetNewsForApp` | 可用 |
| 构建号与更新时间 | `api.steamcmd.net` | 可用（第三方镜像） |
| 商店价格 | `appdetails` | **不可用**（返回 `success:false`），v3 不再采集 |
| 历史在线曲线 | SteamDB | 自动接口不可用；手动导出 CSV 放进收件箱 |
| 历史在线曲线 | SteamCharts | **不可用**（未收录这几个 App） |
| B 站视频计数 | `x/web-interface/view` | 可用 |
| B 站视频搜索 | `x/web-interface/search/type` | **不可用**（HTTP 412 风控），不使用 |
| B 站官方视频发现 | `archive/related` + mid 过滤 | 可用（半自动，只产出候选） |
| YouTube 视频统计 | `videos.list` | 可用（需免费 Key） |
| YouTube 官方视频发现 | 频道 uploads 播放列表 | 可用（只产出候选） |

`collectors/*_discover.py` 只输出候选视频，不自动判断版本归属：角色 PV 通常早于版本更新 5–12 天发布，
按日期机械归类会出错，需要人工确认后写进 YAML。新增游戏用 `python tools/add_game.py --search 名字` 实测接口。

## 目录

```
collect.py                  采集入口（各采集器 → 构建发布包）
collectors/                 各数据源采集器；common.py 为配置、HTTP、日期工具
store/                      数据库：表结构与迁移、写入、视图、配置同步、派生、校验、导出、构建、v2 迁移
config/                     人工维护：games / versions / 视频登记 / 精选配对 / 指标目录
web/                        网页（原生 ES 模块，无需构建）；vendor/ 为 ECharts 与 sql.js
scripts/                    计划任务与本机预览
tools/                      发布到 gh-pages、截图检查、新增游戏
tests/                      Python 测试；tests/web/ 为前端单元与端到端测试；tests/support/ 为合成数据
docs/                       技术说明、数据层设计、开发日志、切换步骤
spike/                      v3 可行性验证（SQLite + 浏览器 SQL）的脚本与结果
```

## 已知限制

- 自有的逐日采集自 2026-09-14 起；更早的在线数据来自 SteamDB 导入，评测来自回填重建。
- B 站视频是人工登记的官方视频，不覆盖全部官方内容，也不含创作者视频。
- 2026-09-16 至 09-28 计划任务缺少代理，YouTube 只有少数几天有效观测，这段无法补采；
  多数视频是发布后才登记的，缺少发布初期的数据。
- 只跟踪 Steam 单一平台，不代表游戏的全平台表现，也不能外推到国服。
- 分享链接保存的是筛选条件，不锁定数据版本：打开时看到的是届时最新发布的数据。
- Reddit / Discord / X 未接入：X 对新开发者只有按量付费；Reddit 新 OAuth client 需人工审批；
  Discord 无 Bot 时只能拿到近似在线数且无历史。

## 合规

只使用公开可访问数据。不保存 Cookie、账号或 Authorization header；API Key 只从 `.env` / 环境变量读取，
不写进配置或数据库，公开数据库导出时还会去掉失败原因里的请求参数；不破解验证码、不绕过登录、不做反检测；
遵守公开接口频率与平台服务条款。

本项目是独立研究原型，不代表任何平台或游戏公司的官方系统。
