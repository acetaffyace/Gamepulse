"""SteamCharts 公开 HTML 的已结束自然月汇总，不采不明粒度的图形点。"""
from __future__ import annotations
from datetime import date
from html.parser import HTMLParser
import requests
from collectors.common import now_iso, run_per_game, save_raw, session
from store import db

MONTHS = {name: i for i, name in enumerate(('January', 'February', 'March', 'April', 'May', 'June',
                                          'July', 'August', 'September', 'October', 'November', 'December'), 1)}


class MonthlyParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cells, self.text, self.rows = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == 'tr': self.cells = []
        if tag == 'td': self.text = []

    def handle_data(self, data):
        if self.text is not None: self.text.append(data)

    def handle_endtag(self, tag):
        if tag == 'td' and self.text is not None:
            self.cells.append(' '.join(' '.join(self.text).split())); self.text = None
        if tag == 'tr' and len(self.cells) >= 5:
            parts = self.cells[0].split()
            if len(parts) != 2 or parts[0] not in MONTHS: return
            try:
                month = date(int(parts[1]), MONTHS[parts[0]], 1).isoformat()
                avg = float(self.cells[1].replace(',', ''))
                peak = int(self.cells[4].replace(',', ''))
                if avg < 0 or peak < 0: raise ValueError('negative_players')
                self.rows.append({'month_start': month, 'avg_players': avg, 'peak_players': peak})
            except ValueError:
                raise ValueError('invalid_monthly_row')


def collect_one(conn, game, day):
    if not game.get('steamcharts_monthly'):
        return 0, 0, 'not_registered'
    url = f"https://steamcharts.com/app/{int(game['steam_app_id'])}"
    try:
        response = session().get(url, timeout=20)
    except requests.RequestException as exc:
        return 1, 0, f'request_error:{type(exc).__name__}'
    if response.status_code != 200:
        return 1, 0, f'http_{response.status_code}'
    parser = MonthlyParser(); parser.feed(response.text)
    if not parser.rows:
        return 1, 0, 'no_monthly_rows:page_changed_or_blocked'
    # 仅保存已经结束的自然月，不将当月片段和完整月份并列。
    rows = [r for r in parser.rows if r['month_start'] < day[:7] + '-01']
    if not rows:
        return 1, 0, 'no_closed_months'
    observed = now_iso()
    with db.transaction(conn):
        db.upsert(conn, 'steamcharts_monthly', [{**r, 'game_id':game['game_id'], 'observed_at':observed, 'source_url':url} for r in rows])
    save_raw('steamcharts', game['game_id'], day, {'html': response.text})
    print(f"  {game['display_name']}: {len(rows)} 个已结束自然月，截至 {max(r['month_start'] for r in rows)}")
    return 1, 1, ''


def run(conn, games, day):
    return run_per_game(conn, 'steamcharts', games, day, collect_one)
