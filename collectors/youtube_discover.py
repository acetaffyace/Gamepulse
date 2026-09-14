"""YouTube 官方频道解析与新视频发现。

与 B 站最大的不同：YouTube 的官方发现链路是通的。
每个频道都有一个 uploads 播放列表，playlistItems.list 只花 1 unit
就能按时间倒序列出该频道的全部投稿，因此新视频可以自动进候选，
不像 B 站要靠 related 接口一层层摸。

**仍然不自动确认版本归属。** 角色 PV 通常早于版本更新日 5-12 天发布，
按发布日机械归类必然出错，因此本脚本只负责把视频写进注册表并标好
content_type 的初值，version_id 留空由人工填写 —— 这与 B 站的处理一致。

用法：
    python collectors/youtube_discover.py --resolve            解析 handle → channel_id
    python collectors/youtube_discover.py --since 2026-06-01   列出候选
    python collectors/youtube_discover.py --since 2026-06-01 --append   写入注册表
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    CONFIG_DIR,
    get_json,
    load_games,
    now_iso,
    polite_sleep,
    session,
    youtube_api_key,
)

CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"
PLAYLIST_URL = "https://www.googleapis.com/youtube/v3/playlistItems"
REGISTRY = CONFIG_DIR / "youtube_videos.yml"

# 标题关键词 → content_type 的初值。只是省去人工敲字，判错了直接改 YAML。
# 与 B 站注册表使用同一套 content_type 取值，保证 pipeline 可以合并处理。
TYPE_PATTERNS = [
    (re.compile(r"\bversion\s*\d|\bv\d\.\d|version trailer", re.I), "version_trailer"),
    (re.compile(r"character (demo|gameplay)|combat (demo|showcase)", re.I), "character_demo"),
    (re.compile(r"\bEP\b|music video|\bMV\b|theme song|OST", re.I), "character_ep"),
    (re.compile(r"character (trailer|pv)|agent (trailer|pv)|resonator", re.I),
     "character_trailer"),
    (re.compile(r"trailer|\bPV\b|teaser", re.I), "season_teaser"),
]


def guess_content_type(title: str) -> str:
    for pattern, kind in TYPE_PATTERNS:
        if pattern.search(title or ""):
            return kind
    return "other"


def load_registry() -> dict:
    with REGISTRY.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def save_registry(data: dict) -> None:
    """只重写 YAML 的数据部分，文件头部的口径说明由 yaml.dump 丢弃，
    因此这里手动把原文件的注释块保留下来。"""
    original = REGISTRY.read_text(encoding="utf-8")
    header_lines = []
    for line in original.splitlines():
        if line.startswith("#") or not line.strip():
            header_lines.append(line)
        else:
            break
    body = yaml.dump(data, allow_unicode=True, sort_keys=False, width=100)
    REGISTRY.write_text("\n".join(header_lines) + "\n" + body, encoding="utf-8")


def resolve_channels(sess, api_key: str) -> int:
    """把 handle 解析成 channel_id 并回填注册表。

    handle 是人写进配置的假设，channel_id 是接口给出的事实。
    解析不到就明确报错，不猜、不用相似频道顶替。
    """
    data = load_registry()
    channels = data.get("official_channels") or {}
    resolved = 0

    for game_id, entry in channels.items():
        handle = entry.get("handle")
        if not handle:
            print(f"  [skip] {game_id}: 未填 handle")
            continue

        payload, status = get_json(sess, CHANNELS_URL, {
            "part": "snippet,contentDetails,statistics",
            "forHandle": handle,
            "key": api_key,
        }, timeout=30)

        items = (payload or {}).get("items") or []
        if status != "ok" or not items:
            err = (payload or {}).get("error", {})
            reason = (err.get("errors") or [{}])[0].get("reason") if err else status
            print(f"  [fail] {game_id}: handle {handle} 解析失败（{reason}）"
                  f" —— 请到频道页确认 handle 拼写")
            polite_sleep(0.5)
            continue

        item = items[0]
        snippet = item.get("snippet") or {}
        stats = item.get("statistics") or {}
        entry["channel_id"] = item["id"]
        entry["title"] = snippet.get("title")
        entry["uploads_playlist"] = (
            (item.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
        entry["subscribers"] = (None if stats.get("hiddenSubscriberCount")
                                else int(stats.get("subscriberCount", 0) or 0))
        entry["resolved_at"] = now_iso()
        resolved += 1
        print(f"  [ok] {game_id}: {snippet.get('title')} → {item['id']} "
              f"（订阅 {entry['subscribers'] if entry['subscribers'] is not None else '已隐藏'}）")
        polite_sleep(0.5)

    save_registry(data)
    print(f"\n已解析 {resolved}/{len(channels)} 个频道并回填 {REGISTRY.name}")
    return 0 if resolved else 1


def list_uploads(sess, api_key: str, playlist_id: str,
                 since: str, max_pages: int = 4) -> list[dict]:
    """按时间倒序列出 uploads，直到早于 since 为止。

    播放列表本身就是倒序的，因此遇到第一个早于 since 的条目即可停止翻页，
    不必把整个频道拉下来 —— 这是配额省在哪里的关键。
    """
    out: list[dict] = []
    page_token = None

    for _ in range(max_pages):
        params = {"part": "snippet,contentDetails", "playlistId": playlist_id,
                  "maxResults": 50, "key": api_key}
        if page_token:
            params["pageToken"] = page_token
        payload, status = get_json(sess, PLAYLIST_URL, params, timeout=30)
        if status != "ok" or not payload or "error" in payload:
            break

        stop = False
        for item in payload.get("items", []):
            snippet = item.get("snippet") or {}
            details = item.get("contentDetails") or {}
            published = (details.get("videoPublishedAt")
                         or snippet.get("publishedAt") or "")[:10]
            if published and published < since:
                stop = True
                continue
            out.append({
                "video_id": details.get("videoId") or snippet.get("resourceId", {}).get("videoId"),
                "title": snippet.get("title"),
                "pubdate": published or None,
            })

        page_token = payload.get("nextPageToken")
        if stop or not page_token:
            break
        polite_sleep(0.5)

    return [v for v in out if v["video_id"]]


def discover(sess, api_key: str, since: str, game_filter: str | None,
             append: bool) -> int:
    data = load_registry()
    channels = data.get("official_channels") or {}
    existing = {v["video_id"] for v in (data.get("videos") or [])}
    games = {g["game_id"]: g for g in load_games() if g.get("active")}

    new_entries: list[dict] = []

    for game_id, entry in channels.items():
        if game_filter and game_id != game_filter:
            continue
        if game_id not in games:
            continue
        playlist = entry.get("uploads_playlist")
        if not playlist:
            print(f"[skip] {game_id}: 尚未解析 channel_id，先运行 --resolve")
            continue

        print(f"\n== {games[game_id]['display_name']} · {entry.get('title')} ==")
        uploads = list_uploads(sess, api_key, playlist, since)
        fresh = [u for u in uploads if u["video_id"] not in existing]
        print(f"  {since} 起共 {len(uploads)} 条投稿，其中 {len(fresh)} 条未登记")

        for video in fresh:
            kind = guess_content_type(video["title"])
            print(f"    {video['pubdate']}  {kind:<18} {video['title'][:52]}")
            new_entries.append({
                "video_id": video["video_id"],
                "game_id": game_id,
                "character_id": None,
                "character_name": None,
                # 版本归属一律留空：角色 PV 常早于版本更新日 5-12 天发布，
                # 按日期机械归类会错，必须人工确认。
                "version_id": None,
                "version_confirmed": False,
                "content_type": kind,
                "title": video["title"],
                "pubdate": video["pubdate"],
                "is_official_account": True,
                "discovered_at": now_iso()[:10],
                "active": True,
            })
        polite_sleep(0.5)

    if not new_entries:
        print("\n没有发现未登记的新视频。")
        return 0

    if not append:
        print(f"\n共 {len(new_entries)} 条候选。确认无误后加 --append 写入注册表。")
        print("写入后请人工补 character_name 与 version_id —— 脚本不猜版本归属。")
        return 0

    data.setdefault("videos", [])
    data["videos"] = (data["videos"] or []) + new_entries
    save_registry(data)
    print(f"\n已写入 {len(new_entries)} 条到 {REGISTRY.name}。"
          f"请人工补 character_name 与 version_id。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="解析官方频道并发现新视频")
    parser.add_argument("--resolve", action="store_true",
                        help="把 handle 解析成 channel_id 并回填注册表")
    parser.add_argument("--since", default="2026-06-01", help="只看该日期之后的投稿")
    parser.add_argument("--game", help="只处理某个 game_id")
    parser.add_argument("--append", action="store_true", help="把候选写入注册表")
    args = parser.parse_args()

    api_key = youtube_api_key()
    if not api_key:
        from collectors.youtube import KEY_HELP
        print(KEY_HELP)
        return 0

    sess = session()
    if args.resolve:
        return resolve_channels(sess, api_key)
    return discover(sess, api_key, args.since, args.game, args.append)


if __name__ == "__main__":
    raise SystemExit(main())
