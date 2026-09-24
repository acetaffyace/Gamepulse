# GamePulse 技术说明与数据口径

[返回项目首页](../README.md)

用公开数据观察长线运营游戏的版本节奏、玩家结构与传播表现。
当前跟踪《鸣潮》《绝区零》《异环》三款游戏的 Steam 版本与官方视频。

![综合图](../dashboard/shots/default.png)

---

## 这个看板回答什么

不是「今天有多少人在玩」——那是公开数据回答不了的。它回答的是：

| 问题 | 用什么回答 |
|---|---|
| 版本更新后声量变了多少 | 版本更新日前后各 7 天的新增评测对比 |
| 来的是什么人 | 评测者写评测时的游戏时长分布：2 小时内 vs 100 小时以上 |
| 玩家来源结构在变吗 | 评测语种构成的 7 天分桶变化 |
| 官方视频是真的火还是只是推荐位给得多 | 互动率（点赞+投币+收藏）/ 播放，跨视频可比 |
| 在线是盘子变大还是采样撞上高峰 | 小时级采样出的日峰值 / 日谷值 / 峰谷比 |
| 版本到底哪天更新的 | Steam 官方公告 + SteamCMD 构建号双重证据 |
| 这个版本比上个版本好吗 | 把两个版本窗口按各自更新日对齐，逐日并排看 |

一条贯穿性的原则：**时间上相邻不等于因果。** 所有事件只标时间节点。

---

## 对比对象

看板只有一个视图。过去的「单游戏」和「三方对比」是同一件事的两个特例，
现在统一成一个概念：**对比对象**。

| 想比什么 | 怎么选 |
|---|---|
| 一个游戏的长线表现 | 加 1 个游戏对象 |
| 几款游戏同期对照 | 加 N 个游戏对象，对齐选「日历日期」 |
| 几款游戏的发行曲线 | 加 N 个游戏对象，对齐选「各自起点」（= 上线后第 N 天） |
| 同一游戏的 3.5 vs 3.6 | 加 2 个版本对象，对齐选「各自起点」（= 版本更新后第 N 天） |
| 鸣潮 3.6 vs 绝区零 3.2 | 加 2 个跨游戏的版本对象 |

版本对象的窗口是 **本次更新日 → 下次更新日前一天**，最后一个版本延伸到今天。
窗口长度不齐时统一**截断到最短的那个** —— 否则长窗口会在短窗口结束后继续
延伸，被读成「它表现更持久」，其实只是它有更多天的数据。

轨道自定义、预设、导出、数据表对所有情形一视同仁，不存在「这个功能只有
某个视图才有」。颜色代表对比对象；同一游戏的多个版本共用基色、以明度区分，
所以「蓝色是鸣潮」这条规则不会被版本对比破坏。

---

## 快速开始

```powershell
pip install -r requirements.txt

python collect.py                            # 采集 + 生成快照 + 校验/编译看板配置
python -m http.server 8770                   # 必须在项目根目录启动
```

访问 <http://127.0.0.1:8770/dashboard/index.html>

或者直接双击 `scripts\serve.cmd` —— 它会启动服务并自动打开浏览器，
关掉那个黑窗口就停止服务。

页面通过 `../data/*.json` 读取数据，因此 **HTTP 服务必须从项目根目录启动**，
而不是 `dashboard/` 子目录；在 `dashboard/` 里启动会全部 404。

### 自动更新（Windows 本机）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Remove
```

注册四个任务：每日 13:20 采集并构建看板、每小时第 5 分钟采在线人数、
每日 17:00 增量补近期评测、每周日 18:00 全量校准评测历史。回填失败一小时后重试一次，旧数据不被覆盖。
已打开的页面每分钟检查新快照，
发现后自动重新加载。

小时级在线采样仍保持轻量，只追加 `steam_online.jsonl`，不会每小时重建大快照；
默认看板也未开启小时峰谷轨道，因此它会在下一次每日快照构建后进入页面。自动刷新
目前覆盖每日采集、增量补评测与每周全量校准，不代表每个小时采样点都会立即出现在页面上。

每日主链路由同一个 `collect.py` 编排：Steam / 构建号 / B 站 / YouTube →
快照 → 看板配置。任一来源失败仍会继续构建快照与配置；已采到的来源会显示，
失败会通过退出码和日志保留。Steam 的商店累计评测数与好评率来自每日汇总，
主看板的评测明细历史与版本滚动口碑每天增量回填、每周全量校准；Steam 接口暂时超时留下的缺口会在
后续成功回填后重建。相邻观测跨多天的总量差会保留在明细中，不作为单日柱展示。
同一天重复采集遇到评测接口超时时，会保留当天较早的有效评测汇总；回填未完整结束时
也不会覆盖上次完整的评测历史。

**为什么是本机而不是 GitHub Actions**：Actions 的 runner 在境外。B 站接口对
境外 IP 有风控（实测搜索接口直接返回 HTTP 412），Steam 商店接口也会按 IP 跳区，
会导致同一个指标在不同日子来自不同地区口径。数据一致性比「云端自动跑」重要。
代价是关机时段会漏采。评测创建日可由后续回填补齐；无法回填的在线观测
仍由质量检查标为缺口，不插值或编造数值。

**出口 IP 按域名分流**：同样的理由在本机也成立。实测 Steam 三个接口境内直连
一律 ReadTimeout，必须走代理；B 站接口直连可用，且**必须**直连 —— 让它跟着
代理出境，等于把上面那个问题原样搬回本机。分流规则写在
`collectors/common.py` 的 `PROXY_HOSTS` / `DIRECT_HOSTS`，只有一处定义，
采集器不需要各自操心。代理是本机进程，计划任务跑的时候它可能没开着，
所以连接层的暂时性故障会重试两次，重试过仍失败的记 `unavailable`，
不记 0 —— 采集日志里能区分「网络抖了一下」和「一直连不上」。

### YouTube（可选，免费）

未配置 API Key 时 YouTube 采集会打印申请指引并跳过，不影响其他链路。

```powershell
# https://console.cloud.google.com/ → 新建项目 → 启用 YouTube Data API v3 → 创建 API 密钥
setx YOUTUBE_API_KEY "你的密钥"      # 计划任务读不到 set 设的临时变量，必须用 setx
                                     # setx 只改注册表，已开的终端要重开才生效

python collectors/youtube_discover.py --resolve                  # handle → channel_id
python collectors/youtube_discover.py --since 2026-06-01         # 列出候选（全部语区）
python collectors/youtube_discover.py --since 2026-06-01 --locale ja   # 只看日语频道
python collectors/youtube_discover.py --since 2026-06-01 --append
```

密钥只从环境变量读取，不写进任何配置或数据文件。

**语区（locale）**：每款游戏跟踪 4 个官方频道 —— `global` / `ja` / `ko` / `zh-tw`，
共 12 个频道。同一支 PV 在四个频道各发一遍，是四个不同的 `video_id`，
因此所有指标按语区分开落在 `youtube.locales.<locale>` 下，
**快照里不存在跨语区的合计字段**。把四个语区的播放量相加等于把同一支片子
数四遍，而那个数看起来完全正常 —— 结构上不提供它，就不会有人不小心用到。

跨语区对照可参考**互动率**（点赞+评论 / 播放）：它是以播放为
分母的截面比值，可减少频道体量差异的影响，但仍会受发布时间、内容类型和受众行为影响。播放量不可跨语区比大小 ——
全球频道 186 万订阅、NTE 韩语频道 3.3 万，播放差主要来自盘子大小，不是内容表现。

播放量要放进同一张图，得先把体量差处理掉。「语区对照」预设里的
**YouTube 语区播放对照**轨道用三件事做到这点：

| 手段 | 解决什么 |
|---|---|
| 对数纵轴 | 各语区播放中位数 118k / 58k / 39k / 17k、最大 607 万，跨近三个数量级。线性轴上繁中区会被压成贴底的一条直线；对数轴上读的是**垂直距离＝倍数**，语区之间那段恒定落差就是体量差本身 |
| 纵轴可切到「相对本语区」 | 每个点除以**本语区**的播放中位数，体量被除掉。这时「日语区那支 PV 跑到了本区常态的 8 倍」是可说的，而这句话在绝对值下说不出来 |
| 形状＋颜色双编码 | 语区身份由形状承载（● 全球 / ▲ 日语 / ■ 韩语 / ◆ 繁中），颜色只是辅助。多对象对照时颜色归对比对象、形状仍归语区，两条规则可以同时读 |

标尺开关在「自定义轨道」面板里那条轨道自己的行上，会跟着分享链接一起走。
互动率轨道的绝对标尺是**线性**的 —— 它本来就是 1%~20% 的截面比值，
套上对数只会把它压扁。

`--resolve` 只能证明 handle 存在，**不能证明它属于官方**。实测踩到过三次
同人号/空号（`@NevernesstoEverness` 51 订阅、`@ZZZ_TW` 1 订阅、`@NTE_KR` 0 订阅），
三者都返回 200、都打印 `[ok]`。因此解析时对订阅数做量级检查，
低于 1 万的拒绝写入 `channel_id` 并标 `[warn]` —— 宁可这个语区暂时没数据，
也不要让看板上出现一整块来自同人频道的曲线。

---

## 自定义看板

轨道不写死在代码里，来自 `config/dashboard.yml`：

```yaml
- id: bili_engagement
  title: B 站互动率
  adapter: video_scatter
  path: bilibili.videos
  field: engagement
  from_rates: true
  chart: scatter
  color: slot3
  height: 110
  unit: percent
```

加一个指标只改这个文件，不动图表代码。`build_dashboard_config.py` 会**逐条验证
path/field 能在真实快照里取到值**——把 `new_reviews` 写成 `new_review` 会在构建时
报错，而不是在页面上默默渲染一条空轨道让人以为「这个指标没数据」。

页面右上角「自定义轨道」可以增删轨道、调整顺序与高度；声明了 `scales` 的轨道
还会多一个纵轴标尺开关（目前只有两条语区轨道用到）。「预设」提供
默认 / 玩家结构 / 传播端 / 在线盘 / 语区对照 / 日本市场等组合。设置存在
localStorage，也可以通过「导出 → 复制当前视图链接」把当前视图分享出去
（URL 优先于本地设置；链接里的轨道段是 `id.高度.标尺`，旧链接缺第三段时退回默认）。

导出：按日期的 CSV、视频明细 CSV、综合图 PNG。

只有在 `app.js` 的 `ADAPTERS` 里新增一种**取数方式**时才需要改代码；
新增 adapter 必须同步登记到 `build_dashboard_config.py` 的 `ADAPTER_SHAPES`，
否则配置校验会拒绝使用它。

---

## 数据源可用性（实测）

| 数据 | 来源 | 状态 |
|---|---|---|
| 当前同时在线 | `GetNumberOfCurrentPlayers` | 可用 |
| 评测汇总 | `appreviews` | 可用 |
| 评测明细（时长/语种/渠道） | `appreviews` 游标翻页回填 | 可用 |
| 版本公告 | `ISteamNews/GetNewsForApp` | 可用 |
| 构建号与更新时间 | `api.steamcmd.net` | 可用（第三方镜像） |
| 商店价格 | `appdetails` | **不可用**（返回 `success:false`）|
| 历史在线曲线 | SteamDB | 自动接口不可用（403 / API 410）；可用 Charts CSV 手工导入 |
| 历史在线曲线 | SteamCharts | **不可用**（未收录这几个 App）|
| B 站视频七项计数 | `x/web-interface/view` | 可用 |
| B 站账号核验 | `x/web-interface/card` | 可用（无需 Cookie）|
| B 站视频搜索 | `x/web-interface/search/type` | **不可用**（HTTP 412 风控）|
| B 站官方视频发现 | `x/web-interface/archive/related` + mid 过滤 | 可用（半自动）|
| YouTube 视频统计 | `videos.list` | 可用（需免费 Key）|
| YouTube 官方视频发现 | 频道 uploads 播放列表 | 可用（**全自动**）|
| YouTube 按地区的播放拆分 | — | **不可用**（仅频道所有者的 Analytics 有）|

三款均为免费游戏，价格与折扣轨道无内容，字段保留给后续付费游戏。

SteamDB Charts 的 CSV 可用完整历史导出手工更新（每个参数对应 `games.yml` 中的 `game_id`）：

```powershell
python pipeline/import_steamdb_chart.py `
  "--game-file=wuthering_waves=imports\steamdb_chart_3513350.csv" `
  "--game-file=zenless_zone_zero=imports\steamdb_chart_4162040.csv" `
  "--game-file=neverness_to_everness=imports\steamdb_chart_4508340.csv"
```

该命令会替换相应游戏的 SteamDB 日序列，因此应传入完整导出；刷新看板页面即可加载新序列，无需重建快照或索引。

候选游戏的可用性一律用脚本实测，不靠记忆断言：

```powershell
python tools/probe_candidates.py
```

---

## 一个必须先说清楚的结构性事实

三款游戏 Steam 评测的简体中文占比：**绝区零 0.4%、鸣潮 1.4%、异环 0.2%**。

**Steam 评测与 B 站视频来自不同平台和不同抽样机制，不能视为同一批人的行为。**
所以看板不把两者合成一个「综合热度」。这也正是接入 YouTube 的理由：
YouTube 可补充海外传播侧的公开信号，但无法证明其观众与 Steam 玩家是同一批人；两者的同期变化只能作为进一步调查的线索。

---

## 口径说明

- **Steam 在线人数**：平台同时在线观测值，不是 DAU，也不是玩家总数。历史日点可由 SteamDB Charts CSV 手工回填；同日优先用有效的 Steam 官方日点，其次用 SteamDB `Players` 点位，最后用当天最新的有效小时采样。官方请求超时的 `null` 不会覆盖已有点位；SteamDB 的 `Average Players` 不等于该点位。
- **Steam 评测净增**：相邻日总评测数的差值，包含新增与删除评测；缺采时按跨日净变化计算，不是精确新增量，也不是玩家数。
- **Steam 累计好评率**：每日从 appreviews 汇总读取全局好评数 ÷ 总评测数；版本滚动累计好评率来自每日评测明细回填，覆盖日期以看板标注为准。
- **评测历史为回填重建**：全量基底只含上次全量运行时仍存在的评测，日常增量补进近期评测；
  旧评论的删除和编辑要等每周全量校准。该序列标记为 `reconstructed`，
  与逐日采集的 `observed` 分开存放，不连成同一条线。
- **评测者不是玩家的随机样本**：写评测的人本身偏向重度或极端体验，
  所有玩家结构指标只代表评测者。
- **「评测后仍在玩」有观测窗口偏差**：`playtime_forever` 是今天的累计快照，
  新评测的观测窗口必然更短。实测绝区零 90 天前那批是 90.4%、今天这批是 21.1%，
  这种差异受到观测窗口长度的显著影响，不能直接解释为留存变化。因此窗口不足 14 天的日期一律留空，
  且该指标被硬性排除在版本前后对比之外——更新日之后的窗口永远离今天更近，
  放进对比表等于系统性地造出「每次更新后留存都下降」。
- **Steam 在线历史不能通过 Steam 官方接口回填**；导入的 SteamDB CSV 日点标记为第三方来源，不代表全天均值或 DAU。
- **B 站/YouTube 播放量**：接口只返回当前累计值，没有历史曲线。散点轨道画的是
  「发布日 × 当前累计值」，不是当日播放量，也不是全站播放量或独立观众数。
  **拿当前累计值跨视频比是不公平的** —— 等于拿上线一年的游戏和上线一周的
  游戏比总流水。跨视频比较可参考互动率，但仍需控制发布时间、内容类型与受众差异，
  或用「发布后播放曲线」轨道按各自发布日对齐。
- **发布后播放曲线**只能从开始采集那天往后长。发布当天就进采集表的视频
  `ramp.available=true`，曲线含起跑段；事后补登记的视频首次采集拿到的已经是
  积累若干天的累计值，看板把这类曲线画成**虚线**并标出缺口。
- **视频按 `content_type` 分型**（版本 PV / 角色 PV / 角色演示）。版本 PV 与角色 PV
  的发布节奏和推荐位待遇不同，混在一起比没有意义。版本归属只认登记表里
  `version_confirmed` 的声明，不按发布日机械归类 —— 版本 PV 通常在更新日
  之前十来天发布，按日期归类会把它算进上一个版本。
- **默认视频轨道只纳入重点官方内容**：版本 PV/前瞻、角色 PV、角色演示与角色 EP。
  其它官方投稿仍保留在注册表和采集数据中，但暂不进入视频轨道和 B 站互动率卡片。
- **YouTube 点踩数已被平台下线**；点赞与评论可被创作者隐藏，隐藏时记 `null` 不记 0。
- **YouTube 各语区不合并统计**：同一支 PV 在 global/ja/ko/zh-tw 是四个 `video_id`，
  合计会把它数四遍。快照按语区分开且不提供跨语区合计。跨语区比较只用互动率
  这类截面比值，不比播放量绝对值。
- **YouTube 事件时间轴只取 `global` 语区**，否则每个内容节点会重复四次。
  代价是某语区独占的内容（如日本限定联动）暂不进时间轴，需要给时间轴加
  语区筛选才能覆盖。
- **播放量不分地区**：`statistics.viewCount` 是全球累计值，公开 API 不提供
  按地区的拆分（那属于频道所有者的 YouTube Analytics）。本项目的「语区」
  指的是官方开设的语区频道，不是同一支视频的地区播放拆分。
- **在线人数对已结束的版本窗口留空**。在线只有「现在」这一个观测值，
  拿它代表一段历史窗口，会让两个历史版本显示出同一个数。
- **构建号来自第三方镜像**，标 `third_party`，仅作官方公告的旁证。
- **事件仅表示时间节点，不自动表示因果关系。**

---

## 目录

```text
config/games.yml                  游戏与 Steam App ID
config/bilibili_videos.yml        按角色/版本登记并核验的 BV 号
config/youtube_videos.yml         12 个官方频道（3 游戏 × 4 语区）与自动发现的视频
config/dashboard.yml              轨道目录（看板自定义的来源）

collectors/common.py              配置、HTTP、幂等写入、采集日志
collectors/steam.py               在线人数、评测汇总、价格、官方公告
collectors/steam_online.py        小时级在线采样
collectors/steam_build.py         SteamCMD 构建号
collectors/steam_reviews_backfill.py  评测明细回填（游标翻页）
collectors/bilibili.py            七项公开计数
collectors/bilibili_discover.py   官方新视频半自动发现
collectors/youtube.py             YouTube 视频统计
collectors/youtube_discover.py    频道解析与新视频自动发现

pipeline/metrics.py               好评率、增量、互动率、日峰谷、指数化
pipeline/review_profile.py        玩家结构：时长分布、语种构成、版本前后对比
pipeline/quality.py               缺天、过期、字段缺失、倒退、owner 校验
pipeline/build_snapshot.py        组装 dashboard 快照 + 对比对象目录
pipeline/build_dashboard_config.py 编译并校验轨道配置

dashboard/index.html              页面骨架
dashboard/engine.js               对比对象模型、对齐、取数适配器、绘图
dashboard/app.js                  控件、指标卡、表格、导出

scripts/register-tasks.ps1        注册/注销 Windows 计划任务
tools/probe_candidates.py         候选游戏 Steam 可用性实测
tools/shoot.mjs                   看板视觉自检：截图 + 空轨道检测
tests/                            指标、事件、玩家结构的单元测试
```

---

## 维护

```powershell
python collect.py                                     # 每日采集（幂等，可补跑）
python collectors/steam_reviews_backfill.py --game zenless_zone_zero
python collectors/bilibili_discover.py --game zenless_zone_zero --since 2026-09-01
python -m unittest discover -s tests -v
node tools/shoot.mjs --all                            # 需先启动 http 服务
```

计划任务每天增量补评测、每周全量校准；手动运行分别用
`python collect.py --only review_backfill --incremental-review-backfill` 和
`python collect.py --only review_backfill`。

`bilibili_discover.py` 与 `youtube_discover.py` **只输出候选，不自动断言版本归属**——
角色 PV 通常早于版本更新日 5–12 天发布，按日期机械归类必然出错，
版本归属需要人工确认。

`tools/shoot.mjs` 用真实浏览器渲染页面并统计每条轨道的数据点数量。
配置驱动的前端最容易出的问题不是崩溃，而是某条轨道静默画空——
页面照样 200、照样好看，只是那条线不见了。

---

## 已知限制

- 逐日在线序列数据点仍很少，正式趋势复盘应在连续采集 30 天以上再做；
  小时级采样自 2026-09-14 起才开始积累。
- B 站视频为人工登记，不覆盖全部官方内容，也不含创作者视频。
- YouTube 未配置 Key 时该平台数据为空。
- 仅跟踪 Steam 单一平台，不代表游戏的全平台表现，也不能外推到国服。
- Reddit / Discord / X 未接入：X 自 2026-02 起对新开发者只有按量付费、无免费层；
  Reddit 新 OAuth client 需人工审批且官方已宣布收紧公共 API；
  Discord 无 Bot 时只能拿到近似在线数且无历史。三者性价比均不足。

---

## 合规

只使用公开可访问数据。不保存 Cookie、账号或 Authorization header；
API Key 仅从环境变量读取；不破解验证码、不绕过登录、不做反检测；
遵守公开接口频率与平台服务条款。

本项目是独立研究原型，不代表任何平台或游戏公司的官方系统。
