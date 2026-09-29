# 从 v2 切换到 v3 的步骤

v3 在 `v3` 分支（工作目录 `D:\CodexArchive\game-ops-radar-v3`）开发，v2 仍在原目录
`D:\CodexArchive\game-ops-radar` 的 main 分支上由计划任务每天采集。切换就是：停掉 v2 的采集、
把原目录截至当天的数据迁移进 v3 数据库、合并分支、改为发布 gh-pages、重新注册计划任务。

标 **【需要确认】** 的步骤会影响本机以外（GitHub 仓库、线上网站）或不容易撤回，执行前先确认。

## 0. 前提

- v3 目录里全部测试通过：`python -m unittest discover -s tests -q`、`npm test`、`npm run test:e2e`。
- 已确认 SteamDB 的使用条款允许在公开网站展示它的导出数据（公开发布包里包含这些数据）。

## 1. 停掉 v2 的采集（原目录）

```powershell
cd D:\CodexArchive\game-ops-radar
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Remove
```

## 2. 保存 v2 的最后一份数据（原目录）

原目录的 `data/series/` 里有计划任务写入、还没提交的数据。先提交到 main，再打一个 tag，最后整体复制一份作为迁移来源：

```powershell
git add data
git commit -m "Final v2 data before the v3 cutover"
git tag -a v2-final -m "Last v2 commit, with data up to the cutover"
robocopy data ..\gamepulse-v2-data\data /E            # 包含 raw/ 里的评测回填原始文件
```

迁移只从备份里读数据；游戏、版本、视频登记等配置用的是仓库里的 `config/`。

## 3. 合并 v3（原目录）

v3 删除了 `data/` 下的全部入库文件，而 main 刚提交过这些文件，合并时会出现"一边修改、一边删除"的冲突，按 v3 删除处理：

```powershell
git merge v3
# 如有 modify/delete 冲突：
git rm -r --cached data
git commit
```

合并后原目录的 `data/` 里只剩本机文件（`raw/`、`logs/` 等，已被 .gitignore 忽略）。

## 4. 迁移并核对（原目录）

```powershell
pip install -r requirements.txt
python -m store.migrate_v2 --source ..\gamepulse-v2-data
set GAMEPULSE_V2=..\gamepulse-v2-data
python -m unittest tests.test_parity_v2 -v        # 迁移后的数字必须与 v2 已发布的一致
python -m store.build
scripts\serve.cmd                                  # 本机检查页面
```

`test_parity_v2` 拿 v3 的结果和 v2 最后一次发布的快照比对。如果最后一次采集之后 v2 没有重新构建快照
（例如只跑了小时在线采样），对照可能只在最新一天有出入；这时在备份目录里用 `v2-final` 的代码运行一次
`python pipeline/build_snapshot.py` 再比对。

## 5. 发布到 GitHub Pages 【需要确认】

1. GitHub 仓库 → Settings → Pages → Source 选 **Deploy from a branch**，分支选 `gh-pages`，目录 `/ (root)`。
2. 推送代码与 tag：`git push origin main v2 v2-final`。
3. 推送发布包：`python tools/publish_pages.py --push`。
4. 打开 <https://acetaffyace.github.io/Gamepulse/> 检查。

## 6. 重新注册计划任务（原目录）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
```

脚本会顺带删除 v2 的小时在线采样任务。确认每日任务正常后，在 `.env` 里设 `GAMEPULSE_AUTO_PUBLISH=1`，
每日任务就会在构建后自动推送 gh-pages。**【需要确认】**

## 7. 收尾

```powershell
git worktree remove ..\game-ops-radar-v3     # 不再需要单独的 v3 目录
git branch -d v3
```

`..\gamepulse-v2-data` 建议保留一段时间，确认 v3 稳定运行后再删除。

## 回退

- 页面有问题：GitHub Pages 的来源改回 main 分支根目录（v2 的 `index.html` 跳转页在 `v2-final` 里），
  或者在本地 `git checkout v2-final` 后按 v2 的方式发布。
- 采集有问题：`git checkout v2-final`，把 `..\gamepulse-v2-data\data` 复制回 `data\`，重新注册 v2 的计划任务。
- 数据库有问题：`data\backups\` 里有最近 7 天每天一份的数据库副本，复制回 `data\gamepulse.sqlite` 即可。
