# GamePulse · 游戏长线运营情报看板

用公开的 Steam、B 站和 YouTube 数据，观察游戏版本更新前后的口碑、玩家讨论与官方内容表现。目前跟踪《鸣潮》《绝区零》《异环》。

**30 秒了解项目：** 选一个或多个游戏、版本，按日历日期或“更新后第 N 天”对齐；在同一页面查看评测、同时在线、官方视频和版本事件，并能切换指标、导出数据。项目自带快照，打开页面即可查看，无需先申请 API Key 或采集数据。

## 为什么做

长线运营游戏的更新、玩家反馈和传播数据散落在多个平台。GamePulse 把这些公开信号放到同一条时间轴上，方便回答具体问题：版本更新后评测走势怎样变化？不同版本的前几天表现如何？官方视频的传播与 Steam 侧反馈是否同期变化？

它是**观察和对比工具**。事件只标记时间，图表不自动推断因果，也不把 Steam 在线人数写成 DAU。

## 主要能力

| 能力 | 实现 |
| --- | --- |
| 游戏与版本对比 | 支持多对象选择，按日历日期或各自起点对齐；版本窗口截到共同可比的长度 |
| 多源时间轴 | 汇集 Steam 评测、同时在线与公告，B 站和 YouTube 官方视频数据 |
| 玩家结构 | 从 Steam 评测明细计算评测者游戏时长与评测语种分布，展示版本前后变化 |
| 可配置看板 | 指标轨道由 YAML 定义，页面可调整轨道和预设，并导出 CSV、PNG 或视图链接 |
| 数据质量 | 区分直接观测、回填重建和第三方数据；缺失值保留为空，并提示覆盖范围 |

<a href="dashboard/shots/default.png"><img src="dashboard/shots/default.png" alt="GamePulse 看板总览" width="420"></a>

[查看版本对比截图](dashboard/shots/compare_versions.png) · [查看玩家结构截图](dashboard/shots/player_profile.png) · [技术与数据口径](docs/technical-notes.md)

**技术实现：** Python 采集与快照构建；原始时间序列存为 JSONL，页面读取 JSON 快照；前端为原生 JavaScript + ECharts 的静态页面。看板配置会在构建时校验，自动化测试覆盖关键指标与回填逻辑。

## 本地查看

需要 Python 3。在项目根目录运行：

```powershell
python -m http.server 8770
```

打开 <http://127.0.0.1:8770/dashboard/index.html>。仓库已有展示用快照，查看页面无需运行采集器。Windows 也可以双击 `scripts\serve.cmd`。

如需重新采集数据：

```powershell
pip install -r requirements.txt
python collect.py
```

YouTube 采集需要自行设置 `YOUTUBE_API_KEY`；不设置时仍可查看仓库已有快照。采集依赖公开接口及本机网络环境，运行和自动更新的细节见[技术说明](docs/technical-notes.md)。

## 阅读数据时的边界

- Steam 同时在线只是平台某时点的人数，不代表全平台玩家数或日活。
- Steam 评测者不是全部玩家的随机样本；评测净增也可能受到删除评测和缺采影响。
- 视频播放量是累计值。B 站和 YouTube 的受众、统计口径不同，不合成为一个“综合热度”。
- 历史在线数据包含手工导入的第三方 SteamDB 日点；来源在看板中标注。

详细口径、采集链路、已知限制和维护命令见[技术说明](docs/technical-notes.md)。这是独立研究项目，不代表相关平台或游戏公司。
