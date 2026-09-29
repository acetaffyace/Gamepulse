"""采集器共享工具：配置加载、HTTP、日期换算、原始响应归档。

数据写入在 store/db.py：采集成功才写事实表，失败只记采集尝试（见 docs/v3-data-layer.md）。
- 字段不可用时写 NULL，不用 0 填充；
- 原始响应按日期归档到 data/raw/，便于回溯口径；
- 这里的文件锁与原子写只用于人工维护的 YAML 配置（发现脚本、add_game 会改写它们）。
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
BUSINESS_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
_LOCKS: dict[str, threading.RLock] = {}
_LOCK_GUARD = threading.Lock()
_HELD_LOCKS = threading.local()

USER_AGENT = "game-ops-radar/0.1 (public-data dashboard; contact via repo)"

# 采集器内部标记一次取数是否成功；成功的字段才写进数据库
OBSERVED = "observed"
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


def load_local_env(path: Path = ROOT / ".env") -> None:
    """读取仓库根目录的 .env（已被 .gitignore 忽略），只补充未设置的变量。

    计划任务不继承终端里临时设置的 HTTPS_PROXY：此前每日任务访问
    googleapis.com 一律 ConnectTimeout，只有手动在带代理的终端里运行才成功。
    把代理与 API Key 放进 .env，交互运行和计划任务就使用同一份网络配置。
    """
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        if key and value and not os.environ.get(key):
            os.environ[key] = value


load_local_env()


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
    from store.config_sync import read_yaml   # 与配置同步共用带缓存的解析
    return read_yaml(path)



def edit_config_yaml(name: str, mutate) -> None:
    """在跨进程锁内完成「读取 → 修改 → 原子写回」，并保留文件头部的口径说明注释。

    这些文件的注释块记录了核验方式与踩过的坑，被 yaml.dump 抹掉的话
    下一个人（包括三个月后的自己）就不知道为什么不能用搜索接口了。
    """
    path = CONFIG_DIR / name
    with file_lock(path):
        original = path.read_text(encoding="utf-8")
        data = yaml.safe_load(original) or {}

        header = []
        for line in original.splitlines():
            if line.startswith("#") or not line.strip():
                header.append(line)
            else:
                break

        mutate(data)
        body = yaml.dump(data, allow_unicode=True, sort_keys=False, width=100)
        atomic_write_text(path, "\n".join(header) + "\n" + body)


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


def proxy_configured() -> bool:
    return any(_env_proxies().values())


def proxy_missing_for(url: str) -> bool:
    """该域名在境内必须走代理，但当前进程没有代理配置。"""
    host = _host_of(url)
    return (any(host == h or host.endswith("." + h) for h in PROXY_HOSTS)
            and not proxy_configured())


def proxies_for(url: str) -> dict:
    """URL → 该用的 proxies 字典。直连返回显式的 None，而不是空字典 ——
    空字典在 trust_env=True 时仍会被环境代理填充。"""
    host = _host_of(url)
    if any(host == h or host.endswith("." + h) for h in DIRECT_HOSTS):
        return {"http": None, "https": None}
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


def attempt_status(expected: int, succeeded: int, detail: str = "") -> str:
    """一次采集尝试的结论：未配置 / 没有要采的 / 全部成功 / 部分成功 / 全部失败。"""
    if detail == "not_configured":
        return "disabled"
    if not expected:
        return "skipped"
    if succeeded >= expected:
        return "success"
    return "partial" if succeeded else "failed"


def polite_sleep(seconds: float = 1.2) -> None:
    """请求间隔，避免给公开接口造成压力。"""
    time.sleep(seconds)


def active_games(game_id: str | None = None) -> list[dict]:
    if game_id:
        return [get_game(game_id)]
    return [g for g in load_games() if g.get("active")]


def run_per_game(conn, source: str, games: list[dict], date_local: str, collect_one) -> bool:
    """逐个游戏采集并记录采集尝试。返回是否有游戏失败或部分失败。

    collect_one(conn, game, date_local) 返回 (期望数, 成功数, 失败原因)。
    某个游戏抛异常时记为失败，不影响其他游戏继续采集。
    """
    from store import db   # 延迟导入：发现脚本等只读配置的工具不需要数据库

    failed = False
    for game in games:
        try:
            expected, succeeded, detail = collect_one(conn, game, date_local)
        except Exception as exc:  # noqa: BLE001 —— 任何异常都要落到采集记录里
            expected, succeeded, detail = 1, 0, f"{type(exc).__name__}: {exc}"[:300]
            print(f"[failed] {source} {game['game_id']}: {detail}")
        status = attempt_status(expected, succeeded, detail)
        db.record_attempt(conn, source, game["game_id"], date_local, status,
                          expected=expected, succeeded=succeeded, detail=detail or None)
        failed = failed or status in ("failed", "partial")
    return failed
