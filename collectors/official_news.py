"""公开官网列表与文章摘录；只读登记域名，失败保留已有事实。"""
from __future__ import annotations

import re
from datetime import date
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import requests

from collectors.common import load_yaml, now_iso, polite_sleep, run_per_game, save_raw, session
from store import db

ARTICLE_PATH = re.compile(r"^/news/(?:update|official|match)/(?P<stamp>\d{8})/\d+_\d+\.html$")
CATEGORY_RULES = (
    ("公平竞技", r"封禁|外挂|违规|公平|反作弊"),
    ("版本更新", r"更新公告|版本更新|赛季|新英雄|新武器|新地图"),
    ("赛事", r"赛事|联赛|冠军|总决赛|季中赛|劫杯|战队|金牌|NBPL"),
    ("活动/联动", r"联动|活动|周年|福利|礼包|网吧|直播|嘉年华|外观|商城|销售"),
)


def classify(title: str, url: str = "") -> str:
    for label, pattern in CATEGORY_RULES:
        if re.search(pattern, title, re.I):
            return label
    return "赛事" if "/news/match/" in url else "其他"


def article_url(value: str, base: str, allowed_host: str) -> str | None:
    parsed = urlparse(urljoin(base, value))
    if parsed.scheme != "https" or parsed.hostname != allowed_host or parsed.username or parsed.port:
        return None
    if not ARTICLE_PATH.fullmatch(parsed.path):
        return None
    return f"https://{allowed_host}{parsed.path}"


def displayed_date(text: str, url: str) -> tuple[str | None, str]:
    full = re.search(r"(?<!\d)(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?!\d)", text)
    short = re.search(r"\[(\d{2})-(\d{2})\]", text)
    try:
        if full:
            return date(*map(int, full.groups())).isoformat(), "page_full_date"
        if short:
            # 列表只显示月日：用路径年份定年，跨年取离建稿日最近的候选。
            stamp = ARTICLE_PATH.fullmatch(urlparse(url).path).group("stamp")
            created = date(int(stamp[:4]), int(stamp[4:6]), int(stamp[6:]))
            month, day = map(int, short.groups())
            candidates = []
            for year in (created.year - 1, created.year, created.year + 1):
                try:
                    candidates.append(date(year, month, day))
                except ValueError:
                    continue
            if candidates:
                chosen = min(candidates, key=lambda d: abs((d - created).days))
                return chosen.isoformat(), "page_month_day_url_year"
    except (ValueError, AttributeError):
        pass
    return None, "missing_page_date"


class ListParser(HTMLParser):
    """同时支持首页 li 的外置日期和列表页 a 内的日期；导航链接不会入库。"""
    def __init__(self, base: str, host: str):
        super().__init__(convert_charrefs=True)
        self.base, self.host = base, host
        self.items: dict[str, dict] = {}
        self.li_depth = 0
        self.item = None
        self.anchor = False

    def handle_starttag(self, tag, attrs):
        if tag == "li":
            self.li_depth += 1
        if tag == "a" and self.item is None:
            url = article_url(dict(attrs).get("href", ""), self.base, self.host)
            if url:
                self.item = {"url": url, "title_parts": [], "date_parts": [], "depth": self.li_depth}
                self.anchor = True

    def handle_data(self, value):
        if self.item is not None:
            self.item["date_parts"].append(value)
            if self.anchor:
                self.item["title_parts"].append(value)

    def finish(self):
        item, self.item = self.item, None
        self.anchor = False
        if item is None:
            return
        day, basis = displayed_date(" ".join(item["date_parts"]), item["url"])
        title = " ".join(" ".join(item["title_parts"]).split())
        title = re.sub(r"\[\d{2}-\d{2}\]|【(?:新闻|公告)】", "", title).strip()
        if day and title:
            self.items[item["url"]] = {"url": item["url"], "title": title, "date": day,
                                       "date_basis": basis, "category": classify(title, item["url"])}

    def handle_endtag(self, tag):
        if tag == "a":
            self.anchor = False
            if self.item and self.item["depth"] == 0:
                self.finish()
        if tag == "li":
            if self.item and self.li_depth == self.item["depth"]:
                self.finish()
            self.li_depth = max(0, self.li_depth - 1)


class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = {"title": [], "date": [], "excerpt": []}
        self.article_images = 0

    def handle_starttag(self, tag, attrs):
        if tag == "img" and self.stack and self.stack[-1][1] == "excerpt":
            self.article_images += 1
        if tag in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            return
        classes = set(dict(attrs).get("class", "").split())
        field = next((f for cls, f in [("artTitle", "title"), ("artDate", "date"), ("artText", "excerpt")]
                      if cls in classes), None)
        self.stack.append((tag, field or (self.stack[-1][1] if self.stack else None)))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, value):
        if self.stack and self.stack[-1][1] and not any(t in {"script", "style"} for t, _ in self.stack):
            self.parts[self.stack[-1][1]].append(value)

    def values(self, url: str) -> dict:
        cleaned = {k: " ".join(" ".join(v).split()) for k, v in self.parts.items()}
        day, basis = displayed_date(cleaned["date"], url)
        if not cleaned["title"] or not day or (not cleaned["excerpt"] and not self.article_images):
            raise ValueError("missing_article_fields")
        return {"title": cleaned["title"], "date": day, "date_basis": basis,
                "category": classify(cleaned["title"], url), "excerpt": cleaned["excerpt"][:600] or None}


def fetch_html(sess, url: str) -> tuple[str | None, str]:
    try:
        response = sess.get(url, timeout=20, allow_redirects=False)
    except requests.RequestException as exc:
        return None, f"request_error:{type(exc).__name__}"
    if response.status_code != 200:
        return None, f"http_{response.status_code}"
    response.encoding = "utf-8"
    return response.text, ""


def collect_one(conn, game: dict, date_local: str, *, since: str | None = None) -> tuple[int, int, str]:
    config = (load_yaml("official_news.yml").get("games") or {}).get(game["game_id"])
    if not config:
        return 0, 0, "no_official_news_config"
    host = config["allowed_host"]
    sess = session()
    rows, raw, errors = {}, {}, []
    succeeded = 0
    observed_at = now_iso()
    if since:
        date.fromisoformat(since)
    urls = list(config["list_urls"] if not since else config["list_urls"][:1])
    # 回溯时逐页检查归档，整页所有日期都早于起点后停止；不是固定取前两页。
    archive_roots = list(config.get("archive_roots", [])) if since else []
    archive_pages = {root: 1 for root in archive_roots}
    urls.extend(archive_roots)
    urls = list(dict.fromkeys(urls))
    page_count = 0
    while page_count < len(urls):
        url = urls[page_count]
        page_count += 1
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != host or parsed.username or parsed.port:
            raise ValueError("invalid_list_url")
        html, error = fetch_html(sess, url)
        raw[url] = {"html": html, "error": error}
        if html is not None:
            parser = ListParser(url, host)
            parser.feed(html)
            if parser.items:
                rows.update({k: v for k, v in parser.items.items() if not since or v["date"] >= since})
                succeeded += 1
                root = next((r for r in sorted(archive_roots, key=len, reverse=True) if url.startswith(r)), None)
                if root and max(r["date"] for r in parser.items.values()) >= since:
                    page = archive_pages[root] + 1
                    total = re.search(r'data-total="(\d+)"', html)
                    if total and page > int(total.group(1)):
                        pass  # 明确抵达归档末页
                    elif page <= 60:
                        archive_pages[root] = page
                        urls.append(urljoin(root, f"index_{page}.html"))
                    else:
                        errors.append("archive_page_limit:window_incomplete")
            else:
                error = "no_dated_articles:page_changed_or_blocked"
        if error:
            errors.append(f"list:{error}")
        polite_sleep()

    known = {r["url"]: dict(r) for r in conn.execute(
        "SELECT url, title, date, date_basis FROM official_news WHERE game_id = ? AND excerpt IS NOT NULL",
        (game["game_id"],))}
    for row in rows.values():
        previous = known.get(row["url"])
        if previous and (previous["title"], previous["date"]) == (row["title"], row["date"]):
            if previous["date_basis"] == "page_full_date":
                row["date_basis"] = "page_full_date"
        else:
            known.pop(row["url"], None)
    limit = len(rows) if since else min(20, max(0, int(config.get("detail_limit", 6))))
    details = sorted((r for r in rows.values() if r["url"] not in known),
                     key=lambda r: (r["category"] == "公平竞技", -date.fromisoformat(r["date"]).toordinal(), r["url"]))[:limit]
    detail_success = 0
    for row in details:
        html, error = fetch_html(sess, row["url"])
        raw[row["url"]] = {"html": html, "error": error}
        if html is not None:
            try:
                parser = ArticleParser()
                parser.feed(html)
                row.update(parser.values(row["url"]))
                detail_success += 1
            except ValueError as exc:
                error = str(exc)
        if error:
            errors.append(f"detail:{error}")
        polite_sleep()
    save_raw("official_news", game["game_id"], date_local, raw)
    # 有效列表可独立写入；详情失败的条目不传 excerpt，保留此前摘录。
    with db.transaction(conn):
        for row in rows.values():
            db.upsert(conn, "official_news", [{**row, "game_id": game["game_id"], "observed_at": observed_at}])
    print(f"  {game['display_name']}: {len(rows)} 条国服公告，列表 {succeeded}/{len(urls)}，新增摘录 {detail_success}/{len(details)}")
    detail = ";".join(errors[:6])
    if since and not errors:
        detail = f"window_since:{since};list_pages:{len(urls)}"
    if "archive_page_limit:window_incomplete" in errors:
        return len(urls) + len(details) + 1, succeeded + detail_success, detail
    return len(urls) + len(details), succeeded + detail_success, detail


def run(conn, games: list[dict], date_local: str, *, since: str | None = None) -> bool:
    return run_per_game(conn, "official_news", games, date_local,
                        lambda c, g, d: collect_one(c, g, d, since=since))
