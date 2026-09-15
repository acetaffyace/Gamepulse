"""YouTube 官方频道解析与新视频发现。

与 B 站最大的不同：YouTube 的官方发现链路是通的。
每个频道都有一个 uploads 播放列表，playlistItems.list 只花 1 unit
就能按时间倒序列出该频道的全部投稿，因此新视频可以自动进候选，
不像 B 站要靠 related 接口一层层摸。

**仍然不自动确认版本归属。** 角色 PV 通常早于版本更新日 5-12 天发布，
按发布日机械归类必然出错，因此本脚本只负责把视频写进注册表并标好
content_type 的初值，version_id 留空由人工填写 —— 这与 B 站的处理一致。

每款游戏有多个语区官方频道（global/ja/ko/zh-tw），逐个频道发现，
每条视频都带上 locale —— 同一支 PV 在各语区是不同的 video_id，
不带 locale 就没法分开统计。

用法：
    python collectors/youtube_discover.py --resolve            解析 handle → channel_id
    python collectors/youtube_discover.py --since 2026-06-01   列出候选（全部语区）
    python collectors/youtube_discover.py --since 2026-06-01 --locale ja   只看日语频道
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
    YOUTUBE_LOCALES,
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
#
# 多语区必须带上各语言的关键词。原来只有英文规则，日/韩/繁中频道的标题
# （「キャラクターPV」「캐릭터 PV」「角色PV」）会全部落进 other ——
# 那样按 content_type 分型的轨道在这三个语区上会整体失效，
# 而失效的表现是「这些语区好像只发 other」，不是报错。
TYPE_PATTERNS = [
    (re.compile(r"\bversion\s*\d|\bv\d\.\d|version trailer"
                r"|バージョン|ver\.?\s*\d|버전|版本", re.I), "version_trailer"),
    (re.compile(r"character (demo|gameplay)|combat (demo|showcase)"
                r"|実機|戦闘演出|戦闘ショーケース|전투|실전|實機|戰鬥", re.I),
     "character_demo"),
    (re.compile(r"\bEP\b|music video|\bMV\b|theme song|OST"
                r"|主題歌|主题曲|テーマソング|주제가|주제곡", re.I), "character_ep"),
    (re.compile(r"character (trailer|pv)|agent (trailer|pv)|resonator"
                r"|キャラクターPV|キャラPV|エージェントPV|캐릭터\s*PV|角色PV|角色宣傳", re.I),
     "character_trailer"),
    (re.compile(r"trailer|\bPV\b|teaser|予告|ティザー|예고|티저|預告", re.I),
     "season_teaser"),
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


# 官方频道的订阅数下限。低于此值几乎肯定不是官方号，而是同人号或搬运号。
# 依据：实测 12 个官方频道最低的是 NTE 韩语 32,700；而误配进来的
# @NevernesstoEverness 是 51、@ZZZ_TW 是 1、@NTE_KR 是 0。两者相差三个数量级，
# 一万这条线放在中间，既不会误伤刚开的官方新频道，也能挡住所有同人号。
MIN_OFFICIAL_SUBSCRIBERS = 10_000


def resolve_channels(sess, api_key: str) -> int:
    """把 handle 解析成 channel_id 并回填注册表。

    handle 是人写进配置的假设，channel_id 是接口给出的事实。
    解析不到就明确报错，不猜、不用相似频道顶替。

    **解析成功不等于解析对了。** forHandle 只验证「这个 handle 存在」，
    不验证「它属于官方」。实测踩过三次同人号/空号，都返回 200、都打印 [ok]。
    因此这里额外对订阅数做量级检查，可疑的标 [warn] 并拒绝写入 channel_id ——
    宁可这个语区暂时没数据，也不要让看板上出现一整块来自同人频道的曲线。
    """
    data = load_registry()
    channels = data.get("official_channels") or {}
    resolved = 0
    suspicious = 0
    total = sum(len(locales or {}) for locales in channels.values())

    for game_id, locales in channels.items():
        print(f"\n== {game_id} ==")
        for locale, entry in (locales or {}).items():
            tag = f"{game_id}/{locale}"
            handle = entry.get("handle")
            if not handle:
                print(f"  [skip] {tag}: 未填 handle")
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
                print(f"  [fail] {tag}: handle {handle} 解析失败（{reason}）"
                      f" —— 请到频道页确认 handle 拼写")
                polite_sleep(0.5)
                continue

            item = items[0]
            snippet = item.get("snippet") or {}
            stats = item.get("statistics") or {}
            hidden = bool(stats.get("hiddenSubscriberCount"))
            subs = None if hidden else int(stats.get("subscriberCount", 0) or 0)
            title = snippet.get("title")

            # 订阅数被隐藏时无法做量级检查，放行但标注 —— 官方频道极少隐藏订阅数，
            # 遇到了值得人工看一眼。
            if subs is not None and subs < MIN_OFFICIAL_SUBSCRIBERS:
                suspicious += 1
                print(f"  [warn] {tag}: {handle} → 「{title}」订阅仅 {subs:,}，"
                      f"低于官方量级下限 {MIN_OFFICIAL_SUBSCRIBERS:,}，"
                      f"疑似同人号或搬运号，**未写入 channel_id**。"
                      f"确认它确实是官方后，把 handle 改对或调低下限。")
                polite_sleep(0.5)
                continue

            entry["channel_id"] = item["id"]
            entry["title"] = title
            entry["uploads_playlist"] = (
                (item.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
            entry["subscribers"] = subs
            entry["resolved_at"] = now_iso()
            resolved += 1
            print(f"  [ok] {locale:<6} {title} → {item['id']} "
                  f"（订阅 {f'{subs:,}' if subs is not None else '已隐藏'}）")
            polite_sleep(0.5)

    save_registry(data)
    print(f"\n已解析 {resolved}/{total} 个频道并回填 {REGISTRY.name}")
    if suspicious:
        print(f"其中 {suspicious} 个因订阅量级可疑被拒绝写入，见上方 [warn]。")
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
             locale_filter: str | None, append: bool) -> int:
    data = load_registry()
    channels = data.get("official_channels") or {}
    existing = {v["video_id"] for v in (data.get("videos") or [])}
    games = {g["game_id"]: g for g in load_games() if g.get("active")}

    new_entries: list[dict] = []
    per_locale: dict[str, int] = {}

    for game_id, locales in channels.items():
        if game_filter and game_id != game_filter:
            continue
        if game_id not in games:
            continue

        for locale, entry in (locales or {}).items():
            if locale_filter and locale != locale_filter:
                continue
            playlist = entry.get("uploads_playlist")
            if not playlist:
                print(f"[skip] {game_id}/{locale}: 尚未解析 channel_id，先运行 --resolve")
                continue

            print(f"\n== {games[game_id]['display_name']} · [{locale}] "
                  f"{entry.get('title')} ==")
            uploads = list_uploads(sess, api_key, playlist, since)
            fresh = [u for u in uploads if u["video_id"] not in existing]
            print(f"  {since} 起共 {len(uploads)} 条投稿，其中 {len(fresh)} 条未登记")

            for video in fresh:
                kind = guess_content_type(video["title"])
                print(f"    {video['pubdate']}  {kind:<18} {video['title'][:52]}")
                new_entries.append({
                    "video_id": video["video_id"],
                    "game_id": game_id,
                    # 语区必须落到每条视频上：同一支 PV 在 4 个语区是 4 个
                    # 不同的 video_id，不带 locale 就无法分开统计，
                    # 播放量会被跨语区相加 —— 等于把同一支片子数 4 遍。
                    "locale": locale,
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
                per_locale[locale] = per_locale.get(locale, 0) + 1
            existing.update(u["video_id"] for u in fresh)
            polite_sleep(0.5)

    if per_locale:
        print("\n按语区统计：" + "  ".join(
            f"{loc}={n}" for loc, n in sorted(per_locale.items())))

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
    parser.add_argument("--locale", choices=YOUTUBE_LOCALES,
                        help="只处理某个语区；省略则处理全部语区")
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
    return discover(sess, api_key, args.since, args.game, args.locale, args.append)


if __name__ == "__main__":
    raise SystemExit(main())
