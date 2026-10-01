"""
pco.py against canned Planning Center (JSON:API) responses — no network.

Run from the repo root:
    python3 -m unittest discover -s scripts/tests
"""

import base64
import io
import json
import os
import sys
import unittest
import urllib.error
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pco  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def serve(routes):
    """Patch urlopen: routes maps a URL substring → JSON body (first match wins)."""
    seen = []

    def urlopen(req, timeout=None):
        seen.append(req)
        for fragment, body in routes:
            if fragment in req.full_url:
                if isinstance(body, Exception):
                    raise body
                return FakeResponse(json.dumps(body).encode())
        raise AssertionError(f'unexpected request {req.full_url}')

    return mock.patch.object(pco.urllib.request, 'urlopen', urlopen), seen


class PcoTests(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, {'PCO_APP_ID': 'app', 'PCO_SECRET': 'shh'})
        env.start()
        self.addCleanup(env.stop)

    def test_basic_auth_header_uses_app_id_and_secret(self):
        patch, seen = serve([('/services/v2', {'data': {'attributes': {'name': 'Grace Church'}}})])
        with patch:
            self.assertEqual(pco.cmd_test(None), {'ok': True, 'organization': 'Grace Church'})
        expected = 'Basic ' + base64.b64encode(b'app:shh').decode()
        self.assertEqual(seen[0].get_header('Authorization'), expected)

    def test_arrangements_follow_pagination(self):
        arr = lambda i: {'id': str(i), 'attributes': {'name': f'Arr {i}', 'chord_chart': '[G]Hi',
                                                      'chord_chart_key': 'G', 'sequence': ['V1']}}
        patch, _ = serve([
            ('offset=25', {'data': [arr(2)], 'links': {}}),
            ('/songs/7/arrangements', {'data': [arr(1)], 'links': {
                'next': 'https://api.planningcenteronline.com/services/v2/songs/7/arrangements?offset=25'}}),
            ('/songs/7', {'data': {'id': '7', 'attributes': {'title': 'Song', 'author': 'Me'}}}),
        ])
        with patch:
            out = pco.cmd_arrangements(SimpleNamespace(song='7'))
        self.assertEqual([a['name'] for a in out['arrangements']], ['Arr 1', 'Arr 2'])
        self.assertEqual(out['arrangements'][0]['sequence'], ['V1'])

    def test_plan_songs_skip_non_songs_and_read_scheduled_key(self):
        rel = lambda t, i: {'data': {'type': t, 'id': i} if i else None}
        patch, _ = serve([('/plans/9/items', {
            'data': [
                {'id': '1', 'attributes': {'item_type': 'header', 'title': 'Worship'}},
                {'id': '2', 'attributes': {'item_type': 'song', 'title': 'Song A', 'key_name': None},
                 'relationships': {'song': rel('Song', '10'), 'arrangement': rel('Arrangement', '20'),
                                   'key': rel('Key', '30')}},
                {'id': '3', 'attributes': {'item_type': 'song', 'title': 'Song B', 'key_name': 'Bb'},
                 'relationships': {'song': rel('Song', '11'), 'arrangement': rel('Arrangement', None),
                                   'key': rel('Key', None)}},
            ],
            'included': [{'type': 'Key', 'id': '30', 'attributes': {'starting_key': 'D'}}],
            'links': {},
        })])
        with patch:
            out = pco.cmd_plan_songs(SimpleNamespace(service_type='5', plan='9'))
        self.assertEqual([(s['title'], s['arrangement_id'], s['key']) for s in out['songs']],
                         [('Song A', '20', 'D'), ('Song B', None, 'Bb')])

    def test_bad_credentials_give_a_readable_error(self):
        err = urllib.error.HTTPError('u', 401, 'Unauthorized', {}, None)
        patch, _ = serve([('/songs', err)])
        with patch, self.assertRaises(pco.PcoError) as ctx:
            pco.cmd_songs(SimpleNamespace(query='x'))
        self.assertIn('Application ID / Secret', str(ctx.exception))

    def test_ids_are_validated_before_going_into_a_url(self):
        with self.assertRaises(pco.PcoError):
            pco.cmd_arrangements(SimpleNamespace(song='7/../../people'))

    def test_missing_credentials(self):
        with mock.patch.dict(os.environ, {'PCO_APP_ID': '', 'PCO_SECRET': ''}), \
             mock.patch.object(pco, 'CONFIG_PATH', '/nonexistent/config.json'), \
             self.assertRaises(pco.PcoError) as ctx:
            pco.load_credentials()
        self.assertIn('not connected', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
