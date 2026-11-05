"""Flask app and Socket.IO instances.

Kept in their own module so blueprints and socket handlers can import them
without going through the package __init__ (which would be circular).
"""
import os

from flask import Flask, request
from flask_socketio import SocketIO

from .paths import BASE_PATH

app = Flask(
    "Beamer+",
    static_folder=os.path.join(BASE_PATH, 'static'),
    template_folder=os.path.join(BASE_PATH, 'templates'),
)

# Sockets are accepted only from this server's own pages (Socket.IO's default
# same-origin check). Widget iframes are srcdoc frames of the presenter page, so
# they connect with its origin. BEAMER_ALLOWED_ORIGINS (comma-separated) adds
# more, e.g. the public address when the server sits behind a proxy.
_extra_origins = [o.strip().rstrip('/') for o in os.environ.get('BEAMER_ALLOWED_ORIGINS', '').split(',') if o.strip()]


def _origin_allowed(origin, environ):
    if not origin:
        return True     # not a browser (no Origin header): nothing to protect
    origin = origin.rstrip('/')
    host = environ.get('HTTP_HOST', '')
    scheme = environ.get('wsgi.url_scheme', 'http')
    same = {f'{scheme}://{host}'}
    fwd_host = environ.get('HTTP_X_FORWARDED_HOST', host).split(',')[0].strip()
    fwd_proto = environ.get('HTTP_X_FORWARDED_PROTO', scheme).split(',')[0].strip()
    same.add(f'{fwd_proto}://{fwd_host}')
    return origin in same or origin in _extra_origins


socketio = SocketIO(app, cors_allowed_origins=_origin_allowed, async_mode='threading')

# Largest request the server accepts (a deck ZIP with its videos is the big one).
try:
    _max_mb = float(os.environ.get('BEAMER_MAX_UPLOAD_MB', '1024'))
except ValueError:
    _max_mb = 1024
app.config['MAX_CONTENT_LENGTH'] = int(_max_mb * 1024 * 1024) if _max_mb > 0 else None

# ── No caching ─────────────────────────────────────────────────────────────
# Beamer+ is edited constantly and served from a machine in the room, so a
# browser holding on to an old copy of the app costs far more than re-fetching
# it does. Flask's default for static files is a 12-hour max-age, which is how a
# stale build ends up surviving an edit, a restart and a reload.
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# Streamed presentation media is the one exception: video, audio, 3D models and
# PDFs are large and are re-requested constantly (seeking a video issues fresh
# range requests), so they keep the browser's normal caching.
_CACHEABLE_PREFIXES = ('/api/zip-asset/',)


@app.after_request
def _no_store(resp):
    path = request.path or ''
    if any(seg in path for seg in _CACHEABLE_PREFIXES):
        _security_headers(resp)
        return resp
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    _security_headers(resp)
    return resp


def _security_headers(resp):
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    # Keeps a /present?key=… address out of Referer headers sent elsewhere.
    resp.headers.setdefault('Referrer-Policy', 'same-origin')
