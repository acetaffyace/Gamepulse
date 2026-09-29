# GamePulse · 游戏长线运营看板

[![CI](https://github.com/acetaffyace/Gamepulse/actions/workflows/ci.yml/badge.svg)](https://github.com/acetaffyace/Gamepulse/actions/workflows/ci.yml)

用 Steam、B 站和 YouTube 的公开数据，看游戏版本更新前后的评测、口碑、在线与官方视频表现，
并且可以自己选指标、维度和筛选条件做查询。目前跟踪《鸣潮》《绝区零》《异环》。

**在线看板：** <https://acetaffyace.github.io/Gamepulse/>（静态页面，打开即用，不需要账号）

<a href="docs/screenshots/versions.png"><img src="docs/screenshots/versions.png" alt="版本对比页" width="720"></a>

截图：[运营总览](docs/screenshots/overview.png) · [版本对比](docs/screenshots/versions.png) ·
[视频传播](docs/screenshots/videos.png) · [玩家结构](docs/screenshots/players.png) ·
[自助查询](docs/screenshots/explore.png) · [数据来源](docs/screenshots/sources.png) · [手机](docs/screenshots/mobile.png)

## 能做什么

| 页面 | 内容 |
|---|---|
| 运营总览 | 所选时间范围内的评测数、日均评测、好评率、SteamDB 日均在线、评测时时长中位数；一行指标卡共用同一个时间范围和截止日 |
| 版本对比 | 两个版本按各自的 Steam 开放日对齐（D0），截到共同天数；逐日评测、好评率、在线，时长与语种构成 |
| 视频传播 | 官方视频按频道语区分开；最新值排名、发布后同龄对比、同一内容在各语区并排 |
| 玩家结构 | 写评测时的游戏时长、评测语种、不同时长段的好评率、评测后是否还在玩 |
| 自助查询 | 选指标 × 维度 × 筛选，现场在浏览器里计算；不合理的组合（比如跨语区相加播放量）会说明原因；也可以直接写只读 SQL |
| 数据来源 | 每个来源最近一次采集、有效数据截至哪天、是否过期，数据质量提示与口径说明 |

每张图都能切换成数据表，并导出 CSV / PNG；筛选条件存在网址里，复制链接就能分享当前视图；支持深色模式和手机。

## 怎么做的

- **数据层：SQLite。** 采集器把数据写进本机的 SQLite；采集失败只记录失败，不覆盖已有的好数据；拿不到的值保持为空，不当作 0。
- **指标只定义一次。** 计算方式写在 SQL 视图和指标目录（`config/metrics.yml`）里。看板页面和自助查询都由同一个查询生成器生成 SQL，同一个数字在哪里看都一样。
- **浏览器里跑 SQL。** 发布时导出一份压缩的数据库（约 1.3 MB），网页用 [sql.js](https://github.com/sql-js/sql.js)（WebAssembly 版 SQLite）打开，任意切片都现场计算，不需要服务器。
- **前端：** 原生 ES 模块 + ECharts，没有构建步骤；配色经过色盲友好校验，浅色与深色各自选定。
- **发布：** 构建时先校验数据与指标目录，通过后导出发布包，推送到 `gh-pages` 分支；数据不进 main 分支，仓库不会随数据变大。

详细的架构、口径、写入规则和已知限制见 [技术说明](docs/technical-notes.md)；
从 JSON 快照迁移到 SQLite 的设计与过程见 [数据层设计](docs/v3-data-layer.md) 和 [开发日志](docs/v3-log.md)。

## 本地运行

需要 Python 3.10+。

```powershell
pip install -r requirements.txt
copy .env.example .env        # 填写 YouTube Key 与本机代理（可选）
python collect.py             # 采集并生成发布包 dist/
scripts\serve.cmd             # 打开 http://127.0.0.1:8770/
```

在线人数来自 SteamDB：把 SteamDB Charts 导出的 CSV 放进 `data/inbox/steamdb/`，下次采集自动导入。
Windows 计划任务的注册方式见 [技术说明](docs/technical-notes.md#自动更新windows-本机)。

## 读数时的边界

- Steam 同时在线只是 Steam 平台的人数，不代表全平台玩家数，也不是 DAU。
- 评测数按创建日统计当前仍存在的评测；评测者不是全部玩家的随机样本；评测语种是写评测时选择的语言，不等于玩家所在地区。
- 视频播放是累计观看次数；B 站和 YouTube 的受众与统计口径不同，不合成"综合热度"，同一内容的各语区版本不相加；多数视频是发布后才登记的，缺少发布初期的数据。
- 时间轴上的事件只标记时间，不推断因果。

这是独立研究项目，不代表相关平台或游戏公司。代码以 [MIT 许可证](LICENSE) 发布；数据来自各平台公开接口，使用仍受相应平台条款约束。
ECharts（Apache-2.0）与 sql.js（MIT）按各自许可随附于 `web/vendor/`。

## 测试

```powershell
python -m unittest discover -s tests -q     # Python：写入规则、SQL 视图（手算样例）、指标目录、采集器、构建、发布
npm ci; npx playwright install chromium      # 首次运行前端测试前
npm test                                     # 前端：查询生成器规则、分位数与 Python 交叉核对
npm run test:e2e                             # 端到端：用合成数据逐页检查
```

推送到 main 时，GitHub Actions 在 Ubuntu 与 Windows 上运行 Python 测试，在 Ubuntu 上运行前端测试。
