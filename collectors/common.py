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
import tempfile
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
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
BUSINESS_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
_LOCKS: dict[str, threading.RLock] = {}
_LOCK_GUARD = threading.Lock()
_HELD_LOCKS = threading.local()

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
    return datetime.now(BUSINESS_TZ).date().isoformat()


def business_date(value) -> str | None:
    """UTC timestamps/ISO instants -> one UTC+8 business date, independent of host TZ."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        instant = datetime.fromtimestamp(value, timezone.utc)
    else:
        instant = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=BUSINESS_TZ)
    return instant.astimezone(BUSINESS_TZ).date().isoformat()


@contextmanager
def file_lock(path: Path, timeout: float = 30):
    """Reentrant thread + process lock covering the complete read/modify/write."""
    # Windows resolve() may change spelling after a previously absent file is
    # created (case/8.3 paths). The reentrant key must not change mid-operation.
    name = os.path.normcase(os.path.abspath(path))
    with _LOCK_GUARD:
        lock = _LOCKS.setdefault(name, threading.RLock())
    if not lock.acquire(timeout=timeout):
        raise TimeoutError(f"Timed out waiting for {path.name}")
    held = getattr(_HELD_LOCKS, "paths", set())
    _HELD_LOCKS.paths = held
    stream = None
    try:
        if name in held:
            yield
            return
        lock_path = path.with_name(path.name + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        stream = lock_path.open("a+b")
        if stream.tell() == 0:
            stream.write(b"0"); stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for {path.name}")
                time.sleep(.025)
        held.add(name)
        try:
            yield
        finally:
            held.remove(name)
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        if stream is not None:
            stream.close()
        lock.release()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as fh:
            tmp = Path(fh.name)
            fh.write(text); fh.flush(); os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


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
            reason = f"http_{resp.status_code}"
            try:
                error = resp.json().get("error", {})
                codes = [x.get("reason") for x in error.get("errors", []) if isinstance(x, dict)] if isinstance(error, dict) else []
                reason += ":" + ",".join(str(c) for c in codes if c) if any(codes) else ""
            except (ValueError, AttributeError, TypeError):
                pass
            if resp.status_code in (429, 500, 502, 503, 504) and attempt + 1 < attempts:
                try:
                    delay = float(resp.headers.get("Retry-After", backoff * (attempt + 1)))
                except (ValueError, TypeError):
                    delay = backoff * (attempt + 1)
                time.sleep(max(0, min(delay, 60)))
                continue
            return None, reason
        try:
            payload = resp.json()
            return (payload, "ok") if isinstance(payload, dict) else (None, "invalid_json_shape")
        except ValueError:
            # 风控页通常是 HTML，不是 JSON
            return None, "non_json_response"
    return None, last


def write_json(path: Path, payload: dict) -> None:
    """原子写：先写临时文件再替换，避免中断留下半个文件。"""
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def save_raw(source: str, game_id: str, date_local: str, payload: dict) -> Path:
    path = RAW_DIR / date_local / f"{source}_{game_id}.json"
    archive = RAW_DIR / date_local / "attempts" / f"{source}_{game_id}_{uuid.uuid4().hex}.json"
    write_json(archive, {"attempted_at": now_iso(), "payload": payload})
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


def retain_observation(existing: dict, incoming: dict) -> dict:
    """Keep earlier valid values only within the SAME logical sampling period."""
    attempted = incoming.get("sampled_at") or incoming.get("collected_at") or now_iso()
    note = incoming.get("note", "")
    invalid_identity = incoming.get("identity_verified") is False or any(
        token in note for token in ("owner_mismatch", "channel_not_official", "locale_mismatch"))
    if invalid_identity:
        return {**incoming, "identity_verified": False}
    old_valid = (existing.get("status") or existing.get("build_status")) in (OBSERVED, "third_party")
    failed = (incoming.get("status") or incoming.get("build_status")) in (UNAVAILABLE, "failed", "error")
    if old_valid and failed:
        return {**existing, "retained_observation": True,
                "observed_at": existing.get("observed_at") or existing.get("sampled_at") or existing.get("date_local"),
                "last_attempt": {"at": attempted, "status": "failed", "note": note}}
    # A successful response may deliberately hide an individual counter. Do
    # not combine an earlier like/comment count with a newly measured view.
    if incoming.get("status") in (OBSERVED, "third_party"):
        return dict(incoming)
    result = dict(incoming)
    retained = []
    groups = {"current_players": "current_players_status",
              "total_reviews": "reviews_status", "total_positive": "reviews_status", "total_negative": "reviews_status",
              "price_final": "price_status", "price_initial": "price_status", "discount_percent": "price_status",
              "buildid": "build_status", "build_updated_at": "build_status", "build_updated_date": "build_status"}
    for key, value in existing.items():
        if key in incoming and incoming[key] is None and value is not None and incoming.get(groups.get(key)) == UNAVAILABLE:
            result[key] = value
            retained.append(key)
    if existing.get("items") and incoming.get("status") == UNAVAILABLE:
        result["items"] = existing["items"]
        retained.append("items")
    if retained:
        result["retained_fields"] = retained
        result["retained_observed_at"] = existing.get("observed_at") or existing.get("sampled_at") or existing.get("date_local")
        result["last_attempt"] = {"at": attempted, "status": "partial", "note": note}
    return result


def _merge_record(existing: dict, incoming: dict) -> dict:
    result = retain_observation(existing, incoming)
    if "videos" in incoming:
        id_key = "bvid" if any("bvid" in v for v in incoming["videos"]) else "video_id"
        old = {v.get(id_key): {**v, "observed_at": v.get("observed_at") or existing.get("sampled_at") or existing.get("date_local")} for v in existing.get("videos", [])}
        result["videos"] = [retain_observation(old.get(v.get(id_key), {}), v)
                            for v in incoming["videos"]]
    return result


def upsert_series_keyed(game_id: str, source: str, record: dict,
                        keys: tuple[str, ...] = ("date_local",)) -> str:
    record = {"sampled_at": now_iso(), **record}
    if "videos" in record:
        record["videos"] = [{"observed_at": record["sampled_at"], **v} for v in record["videos"]]
    path = series_path(game_id, source)
    with file_lock(path):
        records = read_series(game_id, source)
        key_of = lambda row: tuple(row.get(k) for k in keys)
        target = key_of(record)
        if any(value is None for value in target):
            raise ValueError(f"Missing series key: {keys}")
        action = "insert"
        for idx, existing in enumerate(records):
            if key_of(existing) == target:
                records[idx] = _merge_record(existing, record)
                action = "update"
                break
        else:
            records.append(record)
        records.sort(key=key_of)
        atomic_write_text(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))
        return action


def upsert_series(game_id: str, source: str, record: dict) -> str:
    return upsert_series_keyed(game_id, source, record, keys=("date_local",))


def upsert_video_subset_series(game_id: str, source: str, record: dict,
                               id_key: str) -> str:
    with file_lock(series_path(game_id, source)):
        existing = next((r for r in read_series(game_id, source)
                         if r.get("date_local") == record.get("date_local")), None)
        if existing:
            merged = {v[id_key]: {**v, "observed_at": v.get("observed_at") or existing.get("sampled_at") or existing.get("date_local")} for v in existing.get("videos", [])}
            for video in record.get("videos", []):
                key = video[id_key]
                merged[key] = retain_observation(merged.get(key, {}), video)
            record = {**record, "videos": list(merged.values())}
        return upsert_series(game_id, source, record)


def collection_result(source: str, game_id: str, date_local: str,
                      expected: int, succeeded: int, detail: str = "") -> dict:
    status = "disabled" if detail == "not_configured" else "skipped" if not expected else "success" if succeeded == expected else "partial" if succeeded else "failed"
    result = {"date_local": date_local, "source": source, "game_id": game_id,
              "attempted_at": now_iso(), "status": status, "expected": expected,
              "succeeded": succeeded, "detail": detail}
    upsert_series_keyed(game_id, "collection_attempts", result, ("date_local", "source"))
    return result


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
