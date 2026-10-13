"""通过已登录的 Edge 网页菜单导出 SteamDB CSV，不读取 Cookie 或会话密钥。

Windows 可选依赖：pip install pywinauto
    python -m tools.steamdb_edge_export --downloads-dir D:\\Download
    python -m tools.steamdb_edge_export --game naraka_bladepoint --downloads-dir D:\\Download

只下载并核验，写入现有收件箱；导入与构建仍用 collect.py --only steamdb。
没有可用窗口时自动启动 Edge；操作期间使用临时标签页，会短暂占用前台。登录或验证需要用户自行完成。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from collectors.common import active_games
from collectors.steamdb_import import INBOX, parse


class ExportError(RuntimeError):
    pass


def download_directories() -> list[Path]:
    """只读取下载路径配置；不复制浏览器配置、不读取登录凭据。"""
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/User Data"
    directories = []
    for prefs in [root / "Default/Preferences", *root.glob("Profile */Preferences")]:
        try:
            value = json.loads(prefs.read_text(encoding="utf-8")).get("download", {}).get("default_directory")
            if value:
                directories.append(Path(value))
        except (OSError, ValueError):
            continue
    directories.append(Path.home() / "Downloads")
    return list(dict.fromkeys(p for p in directories if p.is_dir()))


def files(directories: list[Path], appid: int) -> dict[Path, tuple[int, int]]:
    out = {}
    for directory in directories:
        for path in directory.glob(f"steamdb_chart_{appid}*.csv"):
            stat = path.stat()
            out[path] = (stat.st_mtime_ns, stat.st_size)
    return out


def stage_download(path: Path, game: dict, inbox: Path = INBOX) -> dict:
    rows = parse(path, game["game_id"])
    last_complete = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    if rows[-1]["date"] < last_complete:
        raise ExportError(f"{game['display_name']} 的日汇总只到 {rows[-1]['date']}，尚未更新到 {last_complete}")
    if rows[-1]["date"] > last_complete:
        raise ExportError("CSV 含尚未结束的 UTC 日期，停止导入")
    # 核对最新三个月的逐日覆盖，不把缺口补为 0。
    recent = max(date.fromisoformat(rows[0]["date"]), date.fromisoformat(last_complete) - timedelta(days=92))
    have = {r["date"] for r in rows}
    expected = {(recent + timedelta(days=i)).isoformat() for i in range((date.fromisoformat(last_complete) - recent).days + 1)}
    missing = sorted(expected - have)
    if missing:
        raise ExportError(f"{game['display_name']} 的近期导出缺少 {len(missing)} 个日汇总：{', '.join(missing[:5])}")
    inbox.mkdir(parents=True, exist_ok=True)
    destination = inbox / f"steamdb_chart_{game['steam_app_id']}.csv"
    index = 1
    while destination.exists():
        destination = inbox / f"steamdb_chart_{game['steam_app_id']} ({index}).csv"
        index += 1
    shutil.copy2(path, destination)
    return {"game": game["game_id"], "file": str(destination), "days": len(rows),
            "first": rows[0]["date"], "last": rows[-1]["date"]}


def edge_windows(desktop) -> list:
    return [w for w in desktop.windows() if w.element_info.class_name == "Chrome_WidgetWin_1"
            and w.window_text().rstrip().endswith("Edge") and w.is_visible()]


def launch_edge() -> None:
    executable = shutil.which("msedge.exe")
    if not executable:
        for variable in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            root = os.environ.get(variable)
            if root:
                candidate = Path(root) / "Microsoft/Edge/Application/msedge.exe"
                if candidate.is_file():
                    executable = str(candidate)
                    break
    if not executable:
        raise ExportError("未找到 Edge，请安装 Microsoft Edge 后重试")
    # 网页导出需要可见、可操作的窗口；沿用浏览器默认配置和已有登录状态。
    subprocess.Popen([executable, "--new-window", "about:blank"])


def ready_edge_window(desktop, timeout: float = 30):
    windows = edge_windows(desktop)
    if not windows:
        print("未发现可用 Edge 窗口，正在启动 Edge…", flush=True)
        launch_edge()
        deadline = time.monotonic() + timeout
        while not windows:
            windows = edge_windows(desktop)
            if windows:
                break
            if time.monotonic() >= deadline:
                raise ExportError("Edge 已启动但未出现可操作窗口；请检查浏览器首次启动提示或当前桌面后重试")
            time.sleep(.5)
    return next((w for w in windows if "SteamDB" in w.window_text()), windows[0])


def export_games(games: list[dict], directories: list[Path], inbox: Path = INBOX) -> list[dict]:
    if sys.platform != "win32":
        raise ExportError("这个入口仅用于 Windows 上已打开的 Edge")
    try:
        from pywinauto import Desktop, mouse
    except ImportError as exc:
        raise ExportError("缺少可选依赖：pip install pywinauto") from exc
    desktop = Desktop(backend="uia")
    window = ready_edge_window(desktop)
    window.set_focus()
    window.type_keys("^t")
    time.sleep(.8)
    results = []
    try:
        for game in games:
            appid = int(game["steam_app_id"])
            window.type_keys("{ESC}")
            previous_charts = {g.element_info.automation_id for g in window.descendants(control_type="Group")
                               if g.element_info.automation_id.startswith("highcharts-")}
            # ValuePattern 写入地址栏，避免逐键输入触发页面快捷键或被新标签初始化打断。
            address = window.descendants(control_type="Edit")[0]
            address.set_edit_text(f"https://steamdb.info/app/{appid}/charts/#3m")
            address.type_keys("{ENTER}")
            deadline = time.monotonic() + 25
            chart = None
            while time.monotonic() < deadline:
                documents = window.descendants(control_type="Document")
                for document in documents:
                    if "Steam Charts" not in document.window_text() or "SteamDB" not in document.window_text():
                        continue
                    groups = [g for g in document.descendants(control_type="Group")
                              if g.element_info.automation_id.startswith("highcharts-")
                              and g.element_info.automation_id not in previous_charts]
                    if groups:
                        chart = groups[0]
                        break
                if chart:
                    break
                time.sleep(.6)
            if chart is None:
                raise ExportError(f"{game['display_name']} 图表未加载；请检查登录、网络或页面验证后重试")
            if not any(b.window_text() == "User menu" for b in window.descendants(control_type="Button")):
                raise ExportError("SteamDB 未显示已登录用户菜单，请先登录")
            # SVG 图表菜单不在 UIA 树中，锚定图表矩形的右上角；其余操作用命名控件。
            rectangle = chart.rectangle()
            bounds = window.rectangle()
            if rectangle.top + 70 > bounds.bottom:
                mouse.scroll(coords=(rectangle.left + 100, bounds.bottom - 150), wheel_dist=-5)
                time.sleep(.5)
                rectangle = chart.rectangle()
            if rectangle.top < bounds.top + 120 or rectangle.top + 70 > bounds.bottom:
                raise ExportError("图表菜单不在可见区域，请恢复正常窗口或调整缩放后重试")
            before = files(directories, appid)
            mouse.click(coords=(rectangle.right - 24, rectangle.top + 27))
            choices = []
            for _ in range(6):
                time.sleep(.3)
                choices = [e for e in window.descendants(control_type="ListItem") if e.window_text() == "Download CSV"]
                if choices:
                    break
            if not choices:
                raise ExportError("未找到 Download CSV；可能页面布局已变，停止操作")
            choices[0].click_input()
            deadline = time.monotonic() + 20
            downloaded = None
            while time.monotonic() < deadline:
                changed = [p for p, stat in files(directories, appid).items() if before.get(p) != stat]
                if changed:
                    candidate = max(changed, key=lambda p: p.stat().st_mtime_ns)
                    time.sleep(.4)
                    downloaded = candidate
                    break
                time.sleep(.5)
            if downloaded is None:
                raise ExportError("未发现完成的 CSV；如 Edge 询问保存位置，请完成保存后重试")
            result = stage_download(downloaded, game, inbox)
            results.append(result)
            print(f"{game['display_name']}：{result['days']} 个完整日，{result['first']} 至 {result['last']} → {result['file']}", flush=True)
    finally:
        # 仅关闭本工具创建的标签，不结束浏览器或关闭用户已有标签。
        window.type_keys("{ESC}")
        window.type_keys("^w")
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", help="省略则导出全部启用的游戏")
    parser.add_argument("--downloads-dir", type=Path, help="Edge 实际下载目录；省略则从本机下载路径配置读取")
    parser.add_argument("--inbox", type=Path, default=INBOX)
    args = parser.parse_args()
    try:
        directories = [args.downloads_dir] if args.downloads_dir else download_directories()
        if not directories or any(not p.is_dir() for p in directories):
            raise ExportError("下载目录不存在，请用 --downloads-dir 指定 Edge 的下载目录")
        export_games(active_games(args.game), directories, args.inbox)
    except (ExportError, OSError, ValueError) as exc:
        print(f"导出未完成：{exc}")
        return 1
    print("已下载并核验。导入及更新看板：python collect.py --only steamdb")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
