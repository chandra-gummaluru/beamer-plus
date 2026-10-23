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

# cors_allowed_origins='*' lets any page on the LAN open a socket. That's
# deliberate — widget iframes connect from assorted origins — but it means the
# widget_state relay trusts its senders. Beamer+ assumes a cooperative local
# network; do not expose this server to the public internet.
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

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
        return resp
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp
