"""Sign in with GitHub for Beamer+ (a GitHub App's user login).

GitHub's login returns a one-time code that must be swapped for tokens using
the app's client secret, which a web page can't hold. These routes do only
that. Presentations, notes and recordings never pass through this server: the
browser reads and writes them on GitHub directly, with the user's own token.

Settings (environment variables, or a .env file beside app.py — see env.py):
  BEAMER_GH_CLIENT_ID      the GitHub App's Client ID
  BEAMER_GH_CLIENT_SECRET  a client secret generated for it
  BEAMER_GH_APP_SLUG       the app's name in its address (github.com/apps/<slug>),
                           for the "Give Beamer+ access" link
  BEAMER_APP_URL           where Beamer+ lives, e.g. https://beamer.changapp.net/
                           (when unset, whatever address the browser used)

The GitHub App's callback URL is <BEAMER_APP_URL>api/github/callback.
"""
import json
import os
import urllib.parse
import urllib.request

from flask import Blueprint, jsonify, redirect, request

github_bp = Blueprint('github', __name__)

TOKEN_URL = 'https://github.com/login/oauth/access_token'
AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'


def _app_url():
    url = os.environ.get('BEAMER_APP_URL') or request.host_url
    return url if url.endswith('/') else url + '/'


def _client():
    return os.environ.get('BEAMER_GH_CLIENT_ID', ''), os.environ.get('BEAMER_GH_CLIENT_SECRET', '')


def _exchange(fields):
    """Ask GitHub for tokens: a code or a refresh token in, access + refresh tokens out."""
    cid, secret = _client()
    body = urllib.parse.urlencode({'client_id': cid, 'client_secret': secret, **fields}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def _tokens(data):
    return {k: data.get(k) for k in ('access_token', 'refresh_token', 'expires_in', 'refresh_token_expires_in')}


def _back(fields):
    """Back to the welcome page with fields in the URL's #fragment, which browsers never send to a server."""
    return redirect(f'{_app_url()}#{urllib.parse.urlencode(fields)}')


@github_bp.get('/api/github/config')
def config():
    """What the page needs to start a sign-in: the app's public Client ID and where GitHub sends it back."""
    cid, secret = _client()
    return jsonify(
        configured=bool(cid and secret),
        authorize_url=AUTHORIZE_URL,
        client_id=cid,
        redirect_uri=_app_url() + 'api/github/callback',
        app_slug=os.environ.get('BEAMER_GH_APP_SLUG', ''),
    )


@github_bp.get('/api/github/callback')
def callback():
    """GitHub sends the browser here after sign-in: swap the code, then return to the app."""
    state = request.args.get('state', '')
    if request.args.get('error') or not request.args.get('code'):
        return _back({'gh_error': request.args.get('error_description') or 'Sign-in was cancelled.', 'state': state})
    if not all(_client()):
        return _back({'gh_error': "Sign-in with GitHub isn't set up on this server yet.", 'state': state})
    try:
        data = _exchange({'code': request.args['code']})
    except Exception:
        data = {'error_description': "Couldn't reach GitHub. Try again."}
    if not data.get('access_token'):
        return _back({'gh_error': data.get('error_description') or 'Sign-in failed.', 'state': state})
    t = {k: v for k, v in _tokens(data).items() if v is not None}
    return _back({**{'gh_' + k: v for k, v in t.items()}, 'state': state})


@github_bp.post('/api/github/refresh')
def refresh():
    """Sign-ins last 8 hours; the page calls this with its refresh token for a fresh one."""
    rt = (request.get_json(silent=True) or {}).get('refresh_token')
    if not rt:
        return jsonify(error='No refresh token.'), 400
    if not all(_client()):
        return jsonify(error="Sign-in with GitHub isn't set up on this server yet."), 503
    try:
        data = _exchange({'grant_type': 'refresh_token', 'refresh_token': rt})
    except Exception:
        return jsonify(error="Couldn't reach GitHub."), 502
    if not data.get('access_token'):
        return jsonify(error=data.get('error_description') or 'Please sign in again.'), 401
    return jsonify(_tokens(data))
