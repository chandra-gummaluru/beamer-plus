"""Presenter sessions — isolated state per lecture room.

Each session owns its own surveys, presentation ZIP, and temp assets.
The university hosts one Beamer+ process; instructors create a session and
share the code (or QR audience URLs scoped under /s/{session_id}/).

The session code is public — it is in every audience URL — so it is not what
makes someone the presenter. Creating a session also issues a secret presenter
token, kept in an HttpOnly cookie in the browser that created it. Every
presenter-only route and socket room requires that token (see
require_presenter); audiences only ever get the survey pages and their
respond / read-the-question endpoints.
"""
import hmac
import os
import re
import secrets
import shutil
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from functools import wraps

from flask import Blueprint, abort, jsonify, request

from . import ai_models
from .paths import UPLOAD_FOLDER

# Readable codes — omit 0/O and 1/I to reduce confusion when read aloud.
_SESSION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
SESSION_ID_LENGTH = 6
_SESSION_ID_RE = re.compile(rf'^[{_SESSION_ALPHABET}]{{{SESSION_ID_LENGTH}}}$')

MAX_RESPONSES_PER_SURVEY = 10000
MAX_RESPONSE_LENGTH = 5000


def _env_number(name, default, cast=float):
    try:
        return cast(os.environ.get(name, default))
    except (TypeError, ValueError):
        return cast(default)


# A session nobody has presented from for this long is removed, with its
# uploaded deck. Long enough for any lecture, short enough that decks don't
# pile up on the server.
SESSION_IDLE_HOURS = _env_number('BEAMER_SESSION_IDLE_HOURS', 24)
# A session that never got a deck is dropped much sooner: it is either a
# cancelled start or someone making sessions to fill the server.
EMPTY_SESSION_MINUTES = _env_number('BEAMER_EMPTY_SESSION_MINUTES', 60)
# Caps on making sessions, so one machine can't fill the server's memory.
MAX_SESSIONS = _env_number('BEAMER_MAX_SESSIONS', 200, int)
MAX_SESSIONS_PER_IP_PER_HOUR = _env_number('BEAMER_MAX_SESSIONS_PER_IP_PER_HOUR', 30, int)
MAX_LIVE_SESSIONS_PER_IP = _env_number('BEAMER_MAX_LIVE_SESSIONS_PER_IP', 10, int)


def presenter_cookie_name(session_id: str) -> str:
    return f'bp_presenter_{session_id}'


@dataclass
class SessionState:
    """In-memory state for one presenter session."""
    created_at: float
    creator_ip: str = ''
    presenter_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    last_seen: float = field(default_factory=time.time)
    surveys: dict = field(default_factory=dict)
    survey_responses: dict = field(default_factory=lambda: defaultdict(list))
    # survey_id -> set of voter ids that have answered (one answer each).
    survey_voters: dict = field(default_factory=lambda: defaultdict(set))
    # survey_id -> {client ip: answers}, for the optional per-address cap.
    survey_ip_counts: dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    current_presentation: dict = field(default_factory=lambda: {
        'file': None,
        'models': {},
        'available_models': [],
    })
    temp_assets: dict[str, bytes] = field(default_factory=dict)
    # Guards the check-then-append of answers and assets.
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def upload_dir(self, session_id: str) -> str:
        path = os.path.join(UPLOAD_FOLDER, session_id)
        os.makedirs(path, exist_ok=True)
        return path

    def temp_assets_bytes(self) -> int:
        return sum(len(b) for b in self.temp_assets.values())


_sessions: dict[str, SessionState] = {}
_lock = threading.RLock()
_creates_by_ip: dict[str, deque] = defaultdict(deque)


def _generate_session_id() -> str:
    while True:
        sid = ''.join(secrets.choice(_SESSION_ALPHABET) for _ in range(SESSION_ID_LENGTH))
        if sid not in _sessions:
            return sid


def _remove_upload_dir(session_id: str):
    # Only ever a session-code-named folder directly inside uploads/.
    if _SESSION_ID_RE.match(session_id or ''):
        shutil.rmtree(os.path.join(UPLOAD_FOLDER, session_id), ignore_errors=True)


def end_session(session_id: str):
    with _lock:
        sess = _sessions.pop(session_id, None)
    if sess is not None:
        sess.temp_assets.clear()
        _remove_upload_dir(session_id)


def _is_stale(s: SessionState, now: float) -> bool:
    if now - s.last_seen > SESSION_IDLE_HOURS * 3600:
        return True
    return not s.current_presentation.get('file') and now - s.last_seen > EMPTY_SESSION_MINUTES * 60


def expire_idle_sessions(now: float | None = None):
    now = time.time() if now is None else now
    with _lock:
        stale = [sid for sid, s in _sessions.items() if _is_stale(s, now)]
    for sid in stale:
        end_session(sid)


_sweeper_started = False


def start_idle_sweeper(every_seconds: int = 1800):
    global _sweeper_started
    if _sweeper_started:
        return
    _sweeper_started = True

    def loop():
        while True:
            time.sleep(every_seconds)
            try:
                expire_idle_sessions()
            except Exception as e:   # never let the sweeper die
                print(f'Session sweep failed: {e}')
    threading.Thread(target=loop, name='session-sweeper', daemon=True).start()


def clear_orphaned_uploads(now: float | None = None):
    """Sessions live in memory, so after a restart the session folders in
    uploads/ belong to sessions that no longer exist. Remove those untouched
    for longer than a session can stay idle (so a second server sharing the
    folder keeps its decks). Only folders named like a session code.
    Called by the entry points (app.py, launch.py), not on import."""
    now = time.time() if now is None else now
    try:
        names = os.listdir(UPLOAD_FOLDER)
    except OSError:
        return
    for name in names:
        path = os.path.join(UPLOAD_FOLDER, name)
        if not _SESSION_ID_RE.match(name) or name in _sessions or not os.path.isdir(path):
            continue
        try:
            if now - os.path.getmtime(path) > SESSION_IDLE_HOURS * 3600:
                _remove_upload_dir(name)
        except OSError:
            pass


def client_ip() -> str:
    return request.remote_addr or 'unknown'


def create_session(creator_ip: str = '') -> tuple[str, SessionState]:
    with _lock:
        session_id = _generate_session_id()
        sess = SessionState(created_at=time.time(), creator_ip=creator_ip)
        builtin_models, builtin_available = ai_models.get_builtin_models()
        sess.current_presentation['models'] = dict(builtin_models)
        sess.current_presentation['available_models'] = list(builtin_available)
        _sessions[session_id] = sess
    return session_id, sess


def get_session(session_id: str) -> SessionState | None:
    return _sessions.get(session_id)


def get_session_or_404(session_id: str) -> SessionState:
    sess = get_session(session_id)
    if not sess:
        abort(404)
    return sess


def token_matches(sess: SessionState, token) -> bool:
    return isinstance(token, str) and hmac.compare_digest(token, sess.presenter_token)


def is_presenter(session_id: str, sess: SessionState | None = None) -> bool:
    """True when this request carries the session's presenter token."""
    sess = sess or get_session(session_id)
    if sess is None:
        return False
    token = request.cookies.get(presenter_cookie_name(session_id))
    if token_matches(sess, token):
        sess.last_seen = time.time()
        return True
    return False


def same_origin_request() -> bool:
    """False for a browser request sent by another origin. SameSite=Lax keeps
    the cookie off requests from other *sites*, but a page elsewhere on the
    same site (another host under the university's domain, another port)
    still gets it sent; the Origin / Sec-Fetch-Site headers tell them apart.
    Requests without either (not a browser) pass."""
    from .core import _origin_allowed
    origin = request.headers.get('Origin')
    if origin is not None:
        return _origin_allowed(origin, request.environ)
    site = request.headers.get('Sec-Fetch-Site')
    return site in (None, 'same-origin', 'none')


def require_presenter(view):
    """Route decorator: 404 for an unknown session, 403 unless the request
    carries the presenter token (and, for anything but GET, comes from this
    server's own pages). Passes the session in as `sess`."""
    @wraps(view)
    def wrapper(session_id, *args, **kwargs):
        sess = get_session_or_404(session_id)
        if request.method not in ('GET', 'HEAD') and not same_origin_request():
            return jsonify({'error': 'Cross-origin request refused.'}), 403
        if not is_presenter(session_id, sess):
            return jsonify({'error': 'Only the presenter can do this.'}), 403
        return view(session_id, *args, sess=sess, **kwargs)
    return wrapper


def set_presenter_cookie(resp, session_id: str, sess: SessionState):
    resp.set_cookie(
        presenter_cookie_name(session_id), sess.presenter_token,
        max_age=int(SESSION_IDLE_HOURS * 3600) + 3600, path='/',
        httponly=True, samesite='Lax', secure=request.is_secure,
    )
    return resp


def presenter_room(session_id: str) -> str:
    return f'presenter_{session_id}'


def survey_room(session_id: str, survey_id: str) -> str:
    return f'survey_{session_id}_{survey_id}'


def session_room(session_id: str) -> str:
    return f'session_{session_id}'


# ── Session API ────────────────────────────────────────────────────────────

sessions_bp = Blueprint('sessions', __name__)


def _create_allowed(ip: str, now: float) -> bool:
    if len(_sessions) >= MAX_SESSIONS:
        return False
    if MAX_LIVE_SESSIONS_PER_IP > 0 and \
            sum(1 for s in _sessions.values() if s.creator_ip == ip) >= MAX_LIVE_SESSIONS_PER_IP:
        return False
    if MAX_SESSIONS_PER_IP_PER_HOUR <= 0:
        return True
    q = _creates_by_ip[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    return len(q) < MAX_SESSIONS_PER_IP_PER_HOUR


@sessions_bp.route('/api/session/create', methods=['POST'])
def api_create_session():
    now = time.time()
    expire_idle_sessions(now)
    ip = client_ip()
    with _lock:
        if not _create_allowed(ip, now):
            return jsonify({'error': 'Too many sessions. Try again later.'}), 429
        _creates_by_ip[ip].append(now)
    session_id, sess = create_session(ip)
    resp = jsonify({
        'session_id': session_id,
        'url': f'/s/{session_id}/',
    })
    return set_presenter_cookie(resp, session_id, sess)


@sessions_bp.route('/s/<session_id>/api/ping', methods=['POST'])
@require_presenter
def api_ping(session_id, sess):
    """The presenter page's heartbeat: keeps the session (and its cookie)
    alive while the tab is open."""
    return set_presenter_cookie(jsonify({'ok': True}), session_id, sess)


@sessions_bp.route('/s/<session_id>/api/close', methods=['POST'])
@require_presenter
def api_close_session(session_id, sess):
    end_session(session_id)
    resp = jsonify({'success': True})
    resp.delete_cookie(presenter_cookie_name(session_id), path='/')
    return resp
