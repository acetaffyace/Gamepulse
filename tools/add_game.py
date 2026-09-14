"""把一款新游戏接进跟踪列表。

为什么需要这个脚本
------------------
加一款游戏要动三处配置，而且每一处都有个「必须由接口回答、不能凭记忆填」的字段：

    games.yml              steam_app_id  —— 靠搜名字猜会拿到联动页而不是游戏本体
    bilibili_videos.yml    official mid  —— B 站搜索接口有风控（HTTP 412），
                                            只能从一条已知官方视频反查
    youtube_videos.yml     handle        —— 拼错不会报错，只会解析不到

这个脚本把三件事串起来，并且每一步都用接口核验，核验不过就不写。

用法：
    # 1) 先确认 Steam 侧可用（拿到 appid）
    python tools/add_game.py --search "Reverse 1999"

    # 2) 确认后写入 games.yml
    python tools/add_game.py --add --game-id reverse_1999 --name 重返未来1999 \
        --appid 3092660 --developer 深蓝互动

    # 3) 从任意一条官方视频反查并登记 B 站官方账号
    python tools/add_game.py --bili-from https://www.bilibili.com/video/BVxxxxxxxxx \
        --game-id reverse_1999

    # 4) YouTube 频道（可选，需 API Key）
    python tools/add_game.py --yt-handle '@Reverse1999_Official' --game-id reverse_1999
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
    now_iso,
    polite_sleep,
    session,
    today_local,
)

SEARCH_URL = "https://store.steampowered.com/api/storesearch/"
PLAYERS_URL = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/"
REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/"
BILI_VIEW = "https://api.bilibili.com/x/web-interface/view"
BILI_CARD = "https://api.bilibili.com/x/web-interface/card"
YT_CHANNELS = "https://www.googleapis.com/youtube/v3/channels"

BV_PATTERN = re.compile(r"(BV[0-9A-Za-z]{10})")


def edit_yaml(name: str, mutate) -> None:
    """改 YAML 但保留文件头部的口径说明注释。

    这些文件的注释块记录了核验方式与踩过的坑，被 yaml.dump 抹掉的话
    下一个人（包括三个月后的自己）就不知道为什么不能用搜索接口了。
    """
    path = CONFIG_DIR / name
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
    path.write_text("\n".join(header) + "\n" + body, encoding="utf-8")


def search_steam(term: str) -> int:
    sess = session()
    payload, status = get_json(sess, SEARCH_URL,
                               {"term": term, "cc": "cn", "l": "schinese"})
    items = (payload or {}).get("items") or []
    if not items:
        print(f"storesearch 没有结果（{status}）。中文名常常搜不到，试试英文名。")
        return 1

    print(f"\n{'appid':>9}  {'名称':<40} {'在线':>9} {'评测':>9} {'好评率':>7} {'公告':>4}")
    print("-" * 86)
    for item in items[:6]:
        appid = item.get("id")
        name = (item.get("name") or "")[:38]

        payload, _ = get_json(sess, PLAYERS_URL, {"appid": appid})
        resp = (payload or {}).get("response") or {}
        players = resp.get("player_count") if resp.get("result") == 1 else None
        polite_sleep(0.5)

        payload, _ = get_json(sess, REVIEWS_URL.format(appid=appid),
                              {"json": 1, "num_per_page": 0, "language": "all",
                               "purchase_type": "all", "filter": "all"})
        summary = (payload or {}).get("query_summary") or {}
        total = summary.get("total_reviews")
        positive = summary.get("total_positive")
        polite_sleep(0.5)

        payload, _ = get_json(sess, NEWS_URL,
                              {"appid": appid, "count": 3, "maxlength": 1})
        news = ((payload or {}).get("appnews") or {}).get("newsitems") or []

        rate = f"{positive / total * 100:.1f}%" if total else ""
        print(f"{appid:>9}  {name:<40} "
              f"{(f'{players:,}' if players is not None else '×'):>9} "
              f"{(f'{total:,}' if total else '×'):>9} {rate:>7} "
              f"{(len(news) or '×'):>4}")
        polite_sleep(0.5)

    print("\n三项都要有值才值得跟踪。评测数决定回填出的历史长度，"
          "低于约 2000 条的游戏日粒度曲线会很稀疏。")
    print("确认后用 --add --game-id ... --name ... --appid ... 写入 games.yml")
    return 0


def add_game(game_id: str, name: str, appid: int, developer: str | None) -> int:
    def mutate(data):
        games = data.setdefault("games", [])
        if any(g.get("game_id") == game_id for g in games):
            raise SystemExit(f"games.yml 里已经有 {game_id} 了")
        if any(g.get("steam_app_id") == appid for g in games):
            raise SystemExit(f"appid {appid} 已被其他条目占用")
        games.append({
            "game_id": game_id, "display_name": name, "short_name": name,
            "steam_app_id": appid,
            # partial = 在线/评测/公告可用，appdetails 商店详情不可用。
            # 首次采集后看 collect-log 的 observed_fields 再按实际调整。
            "steam_status": "partial",
            "developer": developer, "region": "CN", "currency": "CNY",
            "added_at": today_local(), "active": True,
        })
    edit_yaml("games.yml", mutate)
    print(f"已写入 games.yml：{name}（appid {appid}）")
    print(f"下一步：\n"
          f"  python collect.py --game {game_id}\n"
          f"  python collectors/steam_reviews_backfill.py --game {game_id}")
    return 0


def add_bili(url_or_bvid: str, game_id: str) -> int:
    """从一条已知官方视频反查官方账号 mid。

    B 站搜索接口有风控（实测 HTTP 412），没法按名字搜账号。
    但 view 接口能从 BV 号拿到 owner.mid，card 接口能用 mid 反查账号名做二次确认。
    所以流程是：你贴一条官方视频链接 → 脚本解析出 mid → card 接口核对 → 写入。
    """
    match = BV_PATTERN.search(url_or_bvid)
    if not match:
        print("没能从输入里解析出 BV 号。请贴完整视频链接或 BV 号。")
        return 1
    bvid = match.group(1)

    sess = session()
    headers = {"Referer": "https://www.bilibili.com/"}
    payload, status = get_json(sess, BILI_VIEW, {"bvid": bvid}, headers=headers)
    if status != "ok" or not payload or payload.get("code") != 0:
        print(f"view 接口读取失败：{status} / code={(payload or {}).get('code')}")
        return 1

    data = payload.get("data") or {}
    owner = data.get("owner") or {}
    mid, owner_name = owner.get("mid"), owner.get("name")
    print(f"视频：{data.get('title')}")
    print(f"UP 主：{owner_name}（mid {mid}）")

    polite_sleep(0.8)
    card, status = get_json(sess, BILI_CARD, {"mid": mid}, headers=headers)
    confirmed = ((card or {}).get("data") or {}).get("card") or {}
    if confirmed.get("name") != owner_name:
        print(f"⚠ card 接口返回的账号名是 {confirmed.get('name')}，与 view 不一致，未写入")
        return 1
    print(f"card 接口二次确认通过：{confirmed.get('name')}"
          f"（粉丝 {confirmed.get('fans', '?'):,}）")

    print("\n请确认这确实是**该游戏的官方账号**，而不是游戏中心、攻略组或搬运号。")
    print("（核验历史上剔除过多个伪装度很高的非官方投稿，见 bilibili_videos.yml 注释）")
    if input("确认写入？[y/N] ").strip().lower() != "y":
        print("已取消。")
        return 0

    def mutate(data_yaml):
        accounts = data_yaml.setdefault("official_accounts", {})
        accounts[game_id] = {"mid": mid, "name": owner_name,
                             "verified_at": today_local()}
    edit_yaml("bilibili_videos.yml", mutate)
    print(f"已登记 {game_id} 的官方账号 mid={mid}")
    print(f"下一步：python collectors/bilibili_discover.py --game {game_id} "
          f"--since 2026-06-01")
    return 0


def add_youtube(handle: str, game_id: str) -> int:
    from collectors.common import youtube_api_key
    api_key = youtube_api_key()
    if not api_key:
        # 没 Key 也先把 handle 记下来，等配置好 Key 再 --resolve
        def mutate(data):
            channels = data.setdefault("official_channels", {})
            channels[game_id] = {"handle": handle, "channel_id": None,
                                 "title": None, "resolved_at": None}
        edit_yaml("youtube_videos.yml", mutate)
        print(f"未设置 YOUTUBE_API_KEY，已先记下 handle {handle}（未核验）。")
        print("配置好 Key 后运行：python collectors/youtube_discover.py --resolve")
        return 0

    sess = session()
    payload, status = get_json(sess, YT_CHANNELS, {
        "part": "snippet,contentDetails,statistics",
        "forHandle": handle, "key": api_key}, timeout=30)
    items = (payload or {}).get("items") or []
    if not items:
        print(f"handle {handle} 解析失败（{status}）。请到频道页确认拼写。")
        return 1

    item = items[0]
    snippet = item.get("snippet") or {}
    stats = item.get("statistics") or {}
    print(f"频道：{snippet.get('title')} → {item['id']}")

    def mutate(data):
        channels = data.setdefault("official_channels", {})
        channels[game_id] = {
            "handle": handle, "channel_id": item["id"],
            "title": snippet.get("title"),
            "uploads_playlist": ((item.get("contentDetails") or {})
                                 .get("relatedPlaylists") or {}).get("uploads"),
            "subscribers": (None if stats.get("hiddenSubscriberCount")
                            else int(stats.get("subscriberCount", 0) or 0)),
            "resolved_at": now_iso(),
        }
    edit_yaml("youtube_videos.yml", mutate)
    print(f"已登记 {game_id} 的 YouTube 频道")
    print(f"下一步：python collectors/youtube_discover.py --game {game_id} "
          f"--since 2026-06-01")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="把一款新游戏接进跟踪列表")
    parser.add_argument("--search", help="按名字搜 Steam 并实测接口可用性")
    parser.add_argument("--add", action="store_true", help="写入 games.yml")
    parser.add_argument("--game-id")
    parser.add_argument("--name")
    parser.add_argument("--appid", type=int)
    parser.add_argument("--developer")
    parser.add_argument("--bili-from", help="一条官方 B 站视频的链接或 BV 号")
    parser.add_argument("--yt-handle", help="YouTube 频道 handle，形如 @Name")
    args = parser.parse_args()

    if args.search:
        return search_steam(args.search)
    if args.add:
        if not all([args.game_id, args.name, args.appid]):
            parser.error("--add 需要同时提供 --game-id --name --appid")
        return add_game(args.game_id, args.name, args.appid, args.developer)
    if args.bili_from:
        if not args.game_id:
            parser.error("--bili-from 需要 --game-id")
        return add_bili(args.bili_from, args.game_id)
    if args.yt_handle:
        if not args.game_id:
            parser.error("--yt-handle 需要 --game-id")
        return add_youtube(args.yt_handle, args.game_id)

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
