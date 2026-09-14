"""共享工具：配置加载、HTTP、快照读写、采集日志。

设计约束（来自需求文档）：
- 字段不可用时写 null 并标记 unavailable，不用 0 填充；
- 保留 raw response，便于回溯口径；
- 同一天重复运行覆盖当天记录，保证幂等。
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
SERIES_DIR = DATA_DIR / "series"
IMPORT_DIR = DATA_DIR / "imports"
COLLECT_LOG = DATA_DIR / "collect-log.tsv"

USER_AGENT = "game-ops-radar/0.1 (public-data dashboard; contact via repo)"

# 字段级来源标签，dashboard 依据它决定是否绘制该点
OBSERVED = "observed"
DERIVED = "derived"
PROXY = "proxy"
MANUAL = "manual"
UNAVAILABLE = "unavailable"


def _force_utf8_stdout() -> None:
    """Windows 控制台默认 GBK，会让中文标题变乱码。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


_force_utf8_stdout()


def today_local() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_yaml(name: str) -> dict:
    path = CONFIG_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"缺少配置文件: {path}")
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_games() -> list[dict]:
    return load_yaml("games.yml").get("games", [])


def get_game(game_id: str) -> dict:
    for game in load_games():
        if game.get("game_id") == game_id:
            return game
    raise KeyError(f"games.yml 中没有 game_id={game_id}")


def _load_registry(filename: str, game_id: str | None,
                   active_only: bool) -> list[dict]:
    videos = load_yaml(filename).get("videos", []) or []
    if active_only:
        videos = [v for v in videos if v.get("active")]
    if game_id:
        videos = [v for v in videos if v.get("game_id") == game_id]
    return videos


def load_videos(game_id: str | None = None, active_only: bool = True) -> list[dict]:
    return _load_registry("bilibili_videos.yml", game_id, active_only)


def load_youtube_videos(game_id: str | None = None,
                        active_only: bool = True) -> list[dict]:
    return _load_registry("youtube_videos.yml", game_id, active_only)


def official_mid(game_id: str) -> int | None:
    accounts = load_yaml("bilibili_videos.yml").get("official_accounts", {})
    entry = accounts.get(game_id) or {}
    return entry.get("mid")


def youtube_channel(game_id: str) -> dict:
    channels = load_yaml("youtube_videos.yml").get("official_channels", {}) or {}
    return channels.get(game_id) or {}


def youtube_api_key() -> str | None:
    """YouTube Data API Key 只从环境变量读取，绝不入库。

    未设置时返回 None，由调用方打印申请指引后跳过 —— 缺一个可选数据源
    不应该让整条每日采集链路失败。
    """
    return os.environ.get("YOUTUBE_API_KEY") or None


def session() -> requests.Session:
    sess = requests.Session()
    sess.headers.update({"User-Agent": USER_AGENT})
    return sess


def get_json(sess: requests.Session, url: str, params: dict | None = None,
             timeout: int = 20, headers: dict | None = None) -> tuple[dict | None, str]:
    """返回 (payload, status)。失败时 payload 为 None，绝不返回伪造值。"""
    try:
        resp = sess.get(url, params=params, timeout=timeout, headers=headers)
    except requests.RequestException as exc:
        return None, f"request_error:{type(exc).__name__}"
    if resp.status_code != 200:
        return None, f"http_{resp.status_code}"
    try:
        return resp.json(), "ok"
    except ValueError:
        # 风控页通常是 HTML，不是 JSON
        return None, "non_json_response"


def write_json(path: Path, payload: dict) -> None:
    """原子写：先写临时文件再替换，避免中断留下半个文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def save_raw(source: str, game_id: str, date_local: str, payload: dict) -> Path:
    path = RAW_DIR / date_local / f"{source}_{game_id}.json"
    write_json(path, payload)
    return path


def series_path(game_id: str, source: str) -> Path:
    return SERIES_DIR / game_id / f"{source}.jsonl"


def read_series(game_id: str, source: str) -> list[dict]:
    path = series_path(game_id, source)
    if not path.exists():
        return []
    records = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def upsert_series_keyed(game_id: str, source: str, record: dict,
                        keys: tuple[str, ...] = ("date_local",)) -> str:
    """按 keys 组成的逻辑主键幂等写入。返回 'insert' 或 'update'。

    日粒度序列用默认的 date_local；小时级采样需要 (date_local, hour_local)，
    否则同一天的 24 个采样点会互相覆盖，只剩最后一个。
    """
    path = series_path(game_id, source)
    records = read_series(game_id, source)

    def key_of(rec: dict) -> tuple:
        return tuple(rec.get(k) for k in keys)

    target = key_of(record)
    action = "insert"
    for idx, existing in enumerate(records):
        if key_of(existing) == target:
            records[idx] = record
            action = "update"
            break
    else:
        records.append(record)
    records.sort(key=key_of)

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    os.replace(tmp, path)
    return action


def upsert_series(game_id: str, source: str, record: dict) -> str:
    """按 date_local 幂等写入。返回 'insert' 或 'update'。"""
    return upsert_series_keyed(game_id, source, record, keys=("date_local",))


def log_collection(source: str, game_id: str, date_local: str,
                   status: str, detail: str = "") -> None:
    COLLECT_LOG.parent.mkdir(parents=True, exist_ok=True)
    new_file = not COLLECT_LOG.exists()
    with COLLECT_LOG.open("a", encoding="utf-8") as fh:
        if new_file:
            fh.write("collected_at\tsource\tgame_id\tdate_local\tstatus\tdetail\n")
        fh.write(f"{now_iso()}\t{source}\t{game_id}\t{date_local}\t{status}\t{detail}\n")


def polite_sleep(seconds: float = 1.2) -> None:
    """请求间隔，避免给公开接口造成压力。"""
    time.sleep(seconds)
