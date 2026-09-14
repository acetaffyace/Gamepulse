# GamePulse：游戏长线运营情报雷达

一个桌面端、浅色、单图的公开数据趋势看板，跟踪**鸣潮 / 绝区零 / 异环**
三款同期二次元开放世界手游的 Steam 表现。

看板把公开信号放在**同一条横轴**上：Steam 每日新增评测、好评率、
同时在线人数、各自的版本更新节奏、B 站官方视频发布与播放量。

两种视图：

| 视图 | 内容 |
|---|---|
| 单游戏 | 四条轨道 + 该游戏版本更新贯穿竖线 |
| 三方对比 | 五条轨道，颜色固定跟随游戏；版本节奏三行并排 |

对比视图提供两种对齐方式：

- **日历日期** —— 看同期表现（与 SteamDB 一致）
- **上线后天数** —— 按各自 Steam 上线日对齐，比较发行曲线形状。
  三款上线时间相差一年，日历对齐会把「上线热度」和「同期表现」混在一起。

只跟踪公开信号，不声称拥有内部 DAU、收入、留存或全网讨论量。

## 快速开始

```powershell
pip install -r requirements.txt
python collect.py                      # 采集 + 生成快照
python -m http.server 8770             # 必须在项目根目录启动
```

然后访问 <http://127.0.0.1:8770/dashboard/index.html>

页面通过 `../data/snapshot_{game_id}.json` 读取数据，因此 **HTTP 服务必须从
项目根目录启动**，而不是 `dashboard/` 子目录。

## 目录

```text
config/games.yml                  游戏与 Steam App ID
config/bilibili_videos.yml        按版本/角色登记并核验的 BV 号
collectors/common.py              配置、HTTP、幂等写入、采集日志
collectors/steam.py               在线人数、评测汇总、价格、官方公告
collectors/steam_reviews_backfill.py  评测历史回填（游标翻页）
collectors/bilibili.py            登记视频的公开播放字段
collectors/bilibili_discover.py   官方新视频半自动发现
pipeline/metrics.py               好评率、新增评测、播放增量、折扣事件
pipeline/quality.py               缺天、过期、字段缺失、倒退、owner 校验
pipeline/build_snapshot.py        组装单游戏快照、版本事件抽取
pipeline/build_compare.py         组装三方对比数据集（含相对天数轴）
dashboard/index.html              页面结构与样式
dashboard/app.js                  单游戏视图
dashboard/compare.js              三方对比视图
tests/                            指标、质量检查、版本事件抽取单元测试
```

## 当前数据（2026-09-14）

| 游戏 | App ID | 上线 | 评测历史 | 累计好评率 | 登记视频 |
|---|---|---|---|---|---|
| 鸣潮 | 3513350 | 2025-06-28 | 444 天 | 86.89% | 8 |
| 绝区零 | 4162040 | 2026-06-17 | 90 天 | 87.77% | 16 |
| 异环 | 4508340 | 2026-07-08 | 69 天 | 83.08% | 19 |

共同窗口 2026-07-08 → 2026-09-14（69 天）。

鸣潮的评测回填覆盖率为 71.7%（缺 2025-04 至 2025-06 的早期评测，
因翻页上限截断）。**该缺口完全位于共同窗口之前，不影响三方对比**；
如需完整历史，用 `--max-pages` 提高上限重跑即可（默认已改为按总数自动推算）。

## 数据源可用性（实测 2026-09-14，appid 4162040）

| 数据 | 来源 | 状态 |
|---|---|---|
| 当前同时在线 | `GetNumberOfCurrentPlayers` | 可用 |
| 评测汇总 | `appreviews` | 可用 |
| 评测历史 | `appreviews` 游标翻页回填 | 可用，100% 覆盖 |
| 版本更新日 | `ISteamNews/GetNewsForApp` | 可用 |
| 商店价格 | `appdetails` | **不可用**（返回 `success:false`）|
| 历史在线曲线 | SteamDB | **不可用**（403 / API 410）|
| 历史在线曲线 | SteamCharts | **不可用**（未收录该 App）|
| B 站播放量 | `x/web-interface/view` | 可用 |
| 官方视频发现 | `x/web-interface/archive/related` | 可用 |

《绝区零》为免费游戏，价格与折扣轨道对它没有内容，字段保留给后续接入的
付费游戏。B 站搜索接口有风控，本项目**不使用**搜索接口，改用 related
接口 + `owner.mid` 过滤发现官方视频，再人工确认版本归属。

## 口径说明

- **Steam 在线人数**：平台同时在线观测值，不是 DAU，也不是玩家总数。
- **新增评测**：讨论热度代理，不等于讨论量或玩家数。
- **评测历史为回填重建**：只包含今天仍然存在的评测，被删除或隐藏的不会出现，
  因此越早的日期越可能低估当日真实值。该序列标记为 `reconstructed`，
  与逐日采集的 `observed` 分开存放，不连成同一条线。
- **Steam 在线历史无法回填**，只能自今日起逐日积累。
- **B 站播放量**：接口只返回当前累计值，没有历史曲线。图中散点表示
  「发布日 × 当前累计播放量」，不是当日播放量，也不是全站播放量。
- **版本竖线**取自 Steam 官方社区公告，已做两重过滤：
  - 排除第三方媒体条目。新闻源混有 CGMagazine、GamingOnLinux 等外部内容，
    其标题同样含版本号（如「Wuthering Waves 3.0 Hands-On」），
    不过滤会造出并不存在的版本竖线。
  - 区分前瞻节目与正式更新。两者日期可相差半个月，且三家措辞不同：
    米哈游 `Update Announcement`、库洛 `New Content in ... Version X.Y`、
    完美世界 `Ver. X.Y ... Patch Notes`。
- **事件仅表示时间节点，不自动表示因果关系。**
- **三方对比的额外限制**：各游戏登记视频数量不同，总播放量不可直接比较，
  应看单条视频量级与发布节奏；共同窗口之前其余游戏已在运营，
  不代表其数值为 0；相对天数视图下在线轨道暂不可比，
  因为每款游戏只有 1 个采集点且处于上线后不同天数。

## 添加新游戏

在 `config/games.yml` 增加条目并设 `active: true`：

```yaml
- game_id: your_game
  display_name: 游戏名
  steam_app_id: 123456
  region: CN
  active: true
```

图表代码按 `game_id` 驱动，无需改动。若该游戏有 B 站官方账号，在
`config/bilibili_videos.yml` 的 `official_accounts` 下登记 mid，
再用 `bilibili_discover.py` 列出候选视频。

## 维护

```powershell
python collect.py                                   # 每日采集
python collectors/steam_reviews_backfill.py --game zenless_zone_zero
python collectors/bilibili_discover.py --game zenless_zone_zero --since 2026-09-01
python -m unittest discover -s tests -v
```

评测回填不需要每天跑，版本更新后跑一次即可刷新历史。
`bilibili_discover.py` 只输出候选，不会自动改写注册表——版本归属需要人工
判断，因为版本 PV 与角色 PV 通常早于版本更新日 5–12 天发布。

## 已知限制

- 逐日在线序列目前数据点很少，需要持续积累；正式趋势复盘应在连续采集
  30 天以上再做。
- B 站视频为人工登记，不覆盖全部官方内容，也不含创作者视频。
- 仅跟踪 Steam 单一平台，不代表游戏的全平台表现。《绝区零》评测语言分布
  显示 Steam 侧以海外玩家为主，简体中文评测占比很低，因此该看板的结论
  不能外推到国服。
