#!/usr/bin/env python3
"""
pco.py — Read songs and chord charts from Planning Center Services.

Every command prints ONE JSON object to stdout ({"error": "..."} on failure)
for the ChordPresenter UI.

Usage:
  python3 pco.py test                                  # check credentials
  python3 pco.py songs --query "amazing grace"         # search the song library
  python3 pco.py arrangements --song SONG_ID           # arrangements + chord charts
  python3 pco.py service-types                         # e.g. "Sunday Service"
  python3 pco.py plans --service-type ST_ID            # upcoming plans
  python3 pco.py plan-songs --service-type ST_ID --plan PLAN_ID

Credentials are a Planning Center Personal Access Token (an Application ID +
Secret from https://api.planningcenteronline.com/oauth/applications). They are
read from ChordPresenter's config file (~/.config/chordpresenter/config.json,
keys pco_app_id / pco_secret) — never from the command line, so they don't end
up in the app log. PCO_APP_ID / PCO_SECRET environment variables override the
file (handy for testing from a terminal).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API_ROOT = 'https://api.planningcenteronline.com/services/v2'
CONFIG_PATH = os.path.join(os.path.expanduser('~'), '.config', 'chordpresenter', 'config.json')
MAX_PAGES = 10          # safety cap when following "next" links


class PcoError(Exception):
    pass


# ── Credentials / HTTP ─────────────────────────────────────────────────────────

def load_credentials() -> tuple[str, str]:
    app_id = os.environ.get('PCO_APP_ID', '')
    secret = os.environ.get('PCO_SECRET', '')
    if not (app_id and secret):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            app_id = app_id or cfg.get('pco_app_id', '')
            secret = secret or cfg.get('pco_secret', '')
        except (OSError, ValueError):
            pass
    if not (app_id and secret):
        raise PcoError('Planning Center is not connected. Open Preferences → '
                       'Planning Center and enter your Application ID and Secret.')
    return app_id.strip(), secret.strip()


def api_get(path_or_url: str, params: dict | None = None) -> dict:
    """GET a Services API path (or a full "next" link) and return parsed JSON."""
    url = path_or_url if path_or_url.startswith('https://') else API_ROOT + path_or_url
    if params:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
    app_id, secret = load_credentials()
    token = base64.b64encode(f'{app_id}:{secret}'.encode()).decode()
    req = urllib.request.Request(url, headers={
        'Authorization': f'Basic {token}',
        'Accept': 'application/json',
        'User-Agent': 'ChordPresenter',
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise PcoError('Planning Center rejected the Application ID / Secret. '
                           'Check them in Preferences → Planning Center.')
        if e.code == 403:
            raise PcoError('This Planning Center login does not have access to Services.')
        if e.code == 429:
            raise PcoError('Planning Center rate limit reached — wait a few seconds and try again.')
        raise PcoError(f'Planning Center returned HTTP {e.code} for {path_or_url}')
    except urllib.error.URLError as e:
        raise PcoError(f'Could not reach Planning Center: {e.reason}')


def api_get_all(path: str, params: dict | None = None) -> tuple[list, list]:
    """Follow JSON:API pagination. Returns (data, included)."""
    data, included = [], []
    page = api_get(path, params)
    for _ in range(MAX_PAGES):
        data.extend(page.get('data', []))
        included.extend(page.get('included', []))
        nxt = page.get('links', {}).get('next')
        if not nxt:
            break
        page = api_get(nxt)
    return data, included


def _rel_id(resource: dict, name: str) -> str | None:
    rel = (resource.get('relationships') or {}).get(name) or {}
    data = rel.get('data')
    return data.get('id') if isinstance(data, dict) else None


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_test(_args) -> dict:
    org = api_get('').get('data', {})
    return {'ok': True, 'organization': org.get('attributes', {}).get('name', '')}


def cmd_songs(args) -> dict:
    params = {'order': 'title', 'per_page': 50}
    if args.query.strip():
        params['where[title]'] = args.query.strip()
    songs = api_get('/songs', params).get('data', [])
    return {'songs': [{
        'id': s['id'],
        'title': s['attributes'].get('title') or '',
        'author': s['attributes'].get('author') or '',
        'ccli': s['attributes'].get('ccli_number'),
    } for s in songs]}


def _arrangement(a: dict) -> dict:
    at = a.get('attributes', {})
    return {
        'id': a['id'],
        'name': at.get('name') or 'Default Arrangement',
        'chord_chart': at.get('chord_chart') or '',
        'chord_chart_key': at.get('chord_chart_key') or '',
        'has_chord_chart': bool(at.get('has_chord_chart') or at.get('chord_chart')),
        'lyrics': at.get('lyrics') or '',
        'sequence': at.get('sequence') or [],
        'bpm': at.get('bpm'),
        'meter': at.get('meter') or '',
    }


def cmd_arrangements(args) -> dict:
    song = api_get(f'/songs/{_id(args.song)}').get('data', {})
    arrs, _ = api_get_all(f'/songs/{_id(args.song)}/arrangements', {'per_page': 25})
    at = song.get('attributes', {})
    return {
        'song': {'id': song.get('id'), 'title': at.get('title') or '', 'author': at.get('author') or ''},
        'arrangements': [_arrangement(a) for a in arrs],
    }


def cmd_service_types(_args) -> dict:
    types, _ = api_get_all('/service_types', {'per_page': 50, 'order': 'sequence'})
    return {'service_types': [{'id': t['id'], 'name': t['attributes'].get('name') or ''}
                              for t in types]}


def cmd_plans(args) -> dict:
    plans = api_get(f'/service_types/{_id(args.service_type)}/plans',
                    {'filter': 'future', 'order': 'sort_date', 'per_page': 12}).get('data', [])
    return {'plans': [{
        'id': p['id'],
        'dates': p['attributes'].get('dates') or '',
        'title': p['attributes'].get('title') or '',
        'series_title': p['attributes'].get('series_title') or '',
    } for p in plans]}


def cmd_plan_songs(args) -> dict:
    items, included = api_get_all(
        f'/service_types/{_id(args.service_type)}/plans/{_id(args.plan)}/items',
        {'per_page': 100, 'include': 'song,arrangement,key'})
    keys = {r['id']: r.get('attributes', {}) for r in included if r.get('type') == 'Key'}
    out = []
    for it in items:
        at = it.get('attributes', {})
        if at.get('item_type') != 'song' or not _rel_id(it, 'song'):
            continue
        key_id = _rel_id(it, 'key')
        key_attrs = keys.get(key_id, {}) if key_id else {}
        out.append({
            'item_id': it['id'],
            'title': at.get('title') or '',
            'song_id': _rel_id(it, 'song'),
            'arrangement_id': _rel_id(it, 'arrangement'),
            # The key this song is scheduled in for THIS plan.
            'key': at.get('key_name') or key_attrs.get('starting_key') or '',
        })
    return {'songs': out}


def _id(value: str) -> str:
    """IDs go into URL paths — only allow what PCO IDs look like."""
    if not value or not value.isdigit():
        raise PcoError(f'Invalid Planning Center id: {value!r}')
    return value


COMMANDS = {
    'test': cmd_test,
    'songs': cmd_songs,
    'arrangements': cmd_arrangements,
    'service-types': cmd_service_types,
    'plans': cmd_plans,
    'plan-songs': cmd_plan_songs,
}


def main() -> int:
    ap = argparse.ArgumentParser(description='Planning Center Services reader for ChordPresenter')
    ap.add_argument('command', choices=sorted(COMMANDS))
    ap.add_argument('--query', default='')
    ap.add_argument('--song', default='')
    ap.add_argument('--service-type', default='')
    ap.add_argument('--plan', default='')
    args = ap.parse_args()
    try:
        result = COMMANDS[args.command](args)
    except PcoError as e:
        result = {'error': str(e)}
    except Exception as e:  # never leave the UI with unparseable output
        result = {'error': f'{type(e).__name__}: {e}'}
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
