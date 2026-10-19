"""Sign in with GitHub: the three token-exchange routes (GitHub itself is faked)."""
from urllib.parse import parse_qs, urlparse

import pytest

import server.github as gh
from server import app as flask_app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('BEAMER_GH_CLIENT_ID', 'cid')
    monkeypatch.setenv('BEAMER_GH_CLIENT_SECRET', 'secret')
    monkeypatch.setenv('BEAMER_GH_APP_SLUG', 'beamer-plus')
    monkeypatch.delenv('BEAMER_APP_URL', raising=False)
    flask_app.config['TESTING'] = True
    with flask_app.test_client() as c:
        yield c


def frag(resp):
    return {k: v[0] for k, v in parse_qs(urlparse(resp.headers['Location']).fragment).items()}


def test_config(client):
    d = client.get('/api/github/config').get_json()
    assert d['configured'] is True
    assert d['client_id'] == 'cid'
    assert d['redirect_uri'] == 'http://localhost/api/github/callback'
    assert d['app_slug'] == 'beamer-plus'
    assert 'secret' not in str(d)


def test_config_unconfigured(client, monkeypatch):
    monkeypatch.delenv('BEAMER_GH_CLIENT_SECRET')
    assert client.get('/api/github/config').get_json()['configured'] is False


def test_app_url_override(client, monkeypatch):
    monkeypatch.setenv('BEAMER_APP_URL', 'https://beamer.example.org')
    d = client.get('/api/github/config').get_json()
    assert d['redirect_uri'] == 'https://beamer.example.org/api/github/callback'


def test_callback_swaps_code(client, monkeypatch):
    seen = {}

    def fake(fields):
        seen.update(fields)
        return {'access_token': 'A', 'refresh_token': 'R', 'expires_in': 28800}
    monkeypatch.setattr(gh, '_exchange', fake)
    r = client.get('/api/github/callback?code=xyz&state=s1')
    assert r.status_code == 302
    assert r.headers['Location'].startswith('http://localhost/#')
    f = frag(r)
    assert f == {'gh_access_token': 'A', 'gh_refresh_token': 'R', 'gh_expires_in': '28800', 'state': 's1'}
    assert seen == {'code': 'xyz'}
    assert r.headers['Cache-Control'] == 'no-store'


def test_callback_cancelled(client):
    f = frag(client.get('/api/github/callback?error=access_denied&state=s'))
    assert 'gh_error' in f and f['state'] == 's'


def test_callback_failure(client, monkeypatch):
    monkeypatch.setattr(gh, '_exchange', lambda fields: {'error_description': 'bad code'})
    assert frag(client.get('/api/github/callback?code=x&state=s'))['gh_error'] == 'bad code'


def test_refresh(client, monkeypatch):
    monkeypatch.setattr(gh, '_exchange', lambda fields: {'access_token': 'B', 'refresh_token': 'R2', 'expires_in': 1})
    r = client.post('/api/github/refresh', json={'refresh_token': 'R'})
    assert r.get_json()['access_token'] == 'B'
    assert client.post('/api/github/refresh', json={}).status_code == 400


def test_refresh_rejected(client, monkeypatch):
    monkeypatch.setattr(gh, '_exchange', lambda fields: {'error_description': 'expired'})
    r = client.post('/api/github/refresh', json={'refresh_token': 'R'})
    assert r.status_code == 401 and r.get_json()['error'] == 'expired'
