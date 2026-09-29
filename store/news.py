"""Steam 公告识别：是否官方公告、属于哪类、提到哪个版本号。

规则沿用 v2（pipeline/build_snapshot.py），采集写入与构建派生事件共用这一份。
"""

from __future__ import annotations

import re

# 官方公告标题里的版本号，例如 Version 3.2、Ver. 1.3、库洛使用的 V2.6、中文「3.2 版本」
VERSION_PATTERNS = [
    re.compile(r"\bV(?:er(?:sion)?)?\.?\s*(\d+\.\d+)", re.I),
    re.compile(r"(\d+\.\d+)\s*版本"),
]

# 同一个版本号会出现在多类公告里，日期相差可达半个月：前瞻节目预告在前，正式更新在后。
# 前瞻判定必须先于更新判定：「Version 1.4 Preview Special Program」同时含 Preview。
PREVIEW_PATTERNS = [
    re.compile(r"Special\s+Program", re.I),
    re.compile(r"Preview", re.I),
    re.compile(r"前瞻"),
]
# 各发行商措辞不同：米哈游 Update Announcement、库洛 New Content in、完美世界 Patch Notes，
# 鸣潮 3.3 的标题是「… V3.3 "…" Now Live!」
UPDATE_PATTERNS = [
    re.compile(r"Update\s+Announcement", re.I),
    re.compile(r"New\s+Content\s+in\b", re.I),
    re.compile(r"Patch\s+Notes", re.I),
    re.compile(r"版本更新"),
    re.compile(r"版本现已|正式上线"),
    re.compile(r"Now\s+Live", re.I),
]

# 新闻源混有第三方媒体（CGMagazine、GamingOnLinux 等），标题同样含版本号，
# 只有 Steam 社区官方公告可以生成版本事件。
OFFICIAL_FEEDS = {"steam_community_announcements"}


def is_official(feed_name: str | None, feed_label: str | None) -> bool:
    if feed_name:
        return feed_name.lower() in OFFICIAL_FEEDS
    # 早期采集没有 feedname，退回按 feedlabel 判断
    return (feed_label or "").lower().startswith("community announce")


def classify(title: str | None) -> str:
    """version_preview | version_update | version_news"""
    for pattern in PREVIEW_PATTERNS:
        if pattern.search(title or ""):
            return "version_preview"
    for pattern in UPDATE_PATTERNS:
        if pattern.search(title or ""):
            return "version_update"
    return "version_news"


def extract_version(title: str | None) -> str | None:
    for pattern in VERSION_PATTERNS:
        match = pattern.search(title or "")
        if match:
            return match.group(1)
    return None
