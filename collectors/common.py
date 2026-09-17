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
from urllib.parse import urlparse

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


# 官方频道的语区维度。顺序即看板与日志里的展示顺序：
# global 放第一位是因为它是与 Steam 海外盘人群最同源的那一个（见 youtube.py 抬头）。
#
# 注意与 games.yml 的 region 区分：region: CN 说的是厂商在哪（谁做的），
# locale 说的是这个频道发给谁看（给谁看的）。两者取值域不重叠，不要互相顶替。
YOUTUBE_LOCALES = ("global", "ja", "ko", "zh-tw")


def load_youtube_videos(game_id: str | None = None,
                        active_only: bool = True,
                        locale: str | None = None) -> list[dict]:
    videos = _load_registry("youtube_videos.yml", game_id, active_only)
    if locale:
        videos = [v for v in videos if v.get("locale") == locale]
    return videos


def load_curated_video_pairs(game_id: str | None = None) -> list[dict]:
    """Load the small, manually checked video set used by collection/dashboard."""
    videos = load_yaml("video_pairs.yml").get("videos", []) or []
    if game_id:
        videos = [v for v in videos if v.get("game_id") == game_id]
    return videos


def curated_youtube_entries(game_id: str | None = None) -> list[dict]:
    """Expand each curated pair into separate YouTube locale video records."""
    out = []
    for pair in load_curated_video_pairs(game_id):
        for locale, video_id in (pair.get("youtube") or {}).items():
            if not video_id:
                continue
            out.append({
                "video_id": video_id,
                "game_id": pair["game_id"],
                "locale": locale,
                "pair_id": pair["pair_id"],
                "character_id": pair.get("character_id"),
                "character_name": pair.get("character_name"),
                "version_id": pair.get("version_id"),
                "version_confirmed": pair.get("version_confirmed", False),
                "content_type": pair.get("content_type"),
                "pubdate": pair.get("pubdate"),
            })
    return out


def official_mid(game_id: str) -> int | None:
    accounts = load_yaml("bilibili_videos.yml").get("official_accounts", {})
    entry = accounts.get(game_id) or {}
    return entry.get("mid")


def official_mids(game_id: str) -> set[int]:
    """Return the explicitly allowlisted official Bilibili account IDs."""
    accounts = load_yaml("bilibili_videos.yml").get("official_accounts", {})
    entry = accounts.get(game_id) or {}
    mids = {mid for mid in [entry.get("mid"), *[
        account.get("mid") if isinstance(account, dict) else account
        for account in (entry.get("additional_mids") or [])
    ]] if mid is not None}
    return mids


def youtube_channels(game_id: str) -> dict[str, dict]:
    """game_id → {locale: 频道条目}，按 YOUTUBE_LOCALES 的顺序返回。

    配置里漏写某个语区不是错误（例如某游戏确实没开韩语频道），
    这里只返回实际配置了的，不补空位 —— 补空位会让下游分不清
    「没开这个频道」和「开了但还没解析」。
    """
    channels = load_yaml("youtube_videos.yml").get("official_channels", {}) or {}
    entry = channels.get(game_id) or {}
    return {loc: entry[loc] for loc in YOUTUBE_LOCALES if entry.get(loc)}


def youtube_channel(game_id: str, locale: str = "global") -> dict:
    return youtube_channels(game_id).get(locale) or {}


def youtube_locale_of_channel(game_id: str) -> dict[str, str]:
    """channel_id → locale 的反查表。

    采集时用它校验「这条视频是不是真的来自它登记的那个语区频道」。
    只比对 channel_id 是否属于本游戏还不够：日语频道的视频被误标成
    global，两者都在白名单里，单纯的归属校验发现不了。
    """
    return {e["channel_id"]: loc
            for loc, e in youtube_channels(game_id).items() if e.get("channel_id")}


def youtube_api_key() -> str | None:
    """YouTube Data API Key 只从环境变量读取，绝不入库。

    未设置时返回 None，由调用方打印申请指引后跳过 —— 缺一个可选数据源
    不应该让整条每日采集链路失败。
    """
    return os.environ.get("YOUTUBE_API_KEY") or None


# 按域名决定走不走代理。这条策略不是偏好，是实测约束：
#
#   Steam  api/store.steampowered.com 境内直连 ReadTimeout，必须走代理；
#   B 站   api.bilibili.com 直连可用，且**必须**直连 —— 接口对境外 IP 有风控，
#          走代理会让同一个指标在不同日子来自不同出口，口径漂移。
#   YouTube 境内不可达，走代理。
#
# 以前 session() 无差别继承环境代理，B 站请求也跟着出境了。分流放在这里
# 而不是各采集器里，是为了让「哪个站走哪条路」只有一处定义、无法写漏。
PROXY_HOSTS = ("steampowered.com", "steamcommunity.com",
               "googleapis.com", "youtube.com", "ytimg.com")
DIRECT_HOSTS = ("bilibili.com", "bilivideo.com", "hdslb.com")


def _env_proxies() -> dict:
    return {
        "http": os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy"),
        "https": os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"),
    }


def _host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def proxies_for(url: str) -> dict:
    """URL → 该用的 proxies 字典。直连返回显式的 None，而不是空字典 ——
    空字典在 trust_env=True 时仍会被环境代理填充。"""
    host = _host_of(url)
    if any(host == h or host.endswith("." + h) for h in DIRECT_HOSTS):
        return {"http": None, "https": None}
    if any(host == h or host.endswith("." + h) for h in PROXY_HOSTS):
        return _env_proxies()
    return _env_proxies()


class RoutedSession(requests.Session):
    """按域名自动选路的 Session。

    trust_env=False 关掉 requests 自己的环境代理合并，改由 proxies_for()
    显式决定，避免「设了 proxies 但环境变量又偷偷合并进来」这类隐式行为。
    """

    def __init__(self) -> None:
        super().__init__()
        self.trust_env = False
        self.headers.update({"User-Agent": USER_AGENT})

    def request(self, method, url, **kwargs):  # type: ignore[override]
        if kwargs.get("proxies") is None:
            kwargs["proxies"] = proxies_for(url)
        return super().request(method, url, **kwargs)


def session() -> requests.Session:
    return RoutedSession()


# 代理是本机进程，计划任务跑的时候它可能没开着。这类失败是暂时的，
# 重试一次就能过；而 HTTP 4xx/风控页是确定性的，重试没有意义也不礼貌。
_TRANSIENT = (requests.exceptions.ProxyError,
              requests.exceptions.ConnectionError,
              requests.exceptions.Timeout)


def get_json(sess: requests.Session, url: str, params: dict | None = None,
             timeout: int = 20, headers: dict | None = None,
             retries: int = 2, backoff: float = 3.0) -> tuple[dict | None, str]:
    """返回 (payload, status)。失败时 payload 为 None，绝不返回伪造值。

    只对连接层的暂时性故障重试。status 会保留最后一次的失败原因，
    并在重试过 n 次后标成 request_error:XxxError:retried{n}，
    这样采集日志能区分「网络抖了一下」和「一直连不上」。
    """
    attempts = max(1, retries + 1)
    last = "unknown"
    for attempt in range(attempts):
        try:
            resp = sess.get(url, params=params, timeout=timeout, headers=headers)
        except _TRANSIENT as exc:
            last = f"request_error:{type(exc).__name__}"
            if attempt + 1 < attempts:
                time.sleep(backoff * (attempt + 1))
                continue
            return None, f"{last}:retried{retries}" if retries else last
        except requests.RequestException as exc:
            return None, f"request_error:{type(exc).__name__}"
        if resp.status_code != 200:
            return None, f"http_{resp.status_code}"
        try:
            return resp.json(), "ok"
        except ValueError:
            # 风控页通常是 HTML，不是 JSON
            return None, "non_json_response"
    return None, last


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


def upsert_video_subset_series(game_id: str, source: str, record: dict,
                               id_key: str) -> str:
    """Merge a curated video refresh into today's row without dropping other IDs."""
    existing = next((r for r in read_series(game_id, source)
                     if r.get("date_local") == record.get("date_local")), None)
    if existing:
        merged = list(existing.get("videos") or [])
        positions = {v.get(id_key): i for i, v in enumerate(merged)}
        for video in record.get("videos") or []:
            key = video.get(id_key)
            if key in positions:
                merged[positions[key]] = video
            else:
                positions[key] = len(merged)
                merged.append(video)
        record = {**record, "videos": merged}
    return upsert_series(game_id, source, record)


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
