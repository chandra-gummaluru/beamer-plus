"""Presenter sessions — isolated state per lecture room.

Each session owns its own surveys, presentation ZIP, and temp assets.
The university hosts one Beamer+ process; instructors create a session and
share the code (or QR audience URLs scoped under /s/{session_id}/).
"""
import os
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass, field

from flask import Blueprint, abort, jsonify

from . import ai_models
from .paths import UPLOAD_FOLDER

# Readable codes — omit 0/O and 1/I to reduce confusion when read aloud.
_SESSION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
SESSION_ID_LENGTH = 6

MAX_RESPONSES_PER_SURVEY = 10000
MAX_RESPONSE_LENGTH = 5000


@dataclass
class SessionState:
    """In-memory state for one presenter session."""
    created_at: float
    surveys: dict = field(default_factory=dict)
    survey_responses: dict = field(default_factory=lambda: defaultdict(list))
    current_presentation: dict = field(default_factory=lambda: {
        'file': None,
        'models': {},
        'available_models': [],
    })
    temp_assets: dict[str, bytes] = field(default_factory=dict)

    def upload_dir(self, session_id: str) -> str:
        path = os.path.join(UPLOAD_FOLDER, session_id)
        os.makedirs(path, exist_ok=True)
        return path


_sessions: dict[str, SessionState] = {}


def _generate_session_id() -> str:
    while True:
        sid = ''.join(secrets.choice(_SESSION_ALPHABET) for _ in range(SESSION_ID_LENGTH))
        if sid not in _sessions:
            return sid


def create_session() -> tuple[str, SessionState]:
    session_id = _generate_session_id()
    sess = SessionState(created_at=time.time())
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


def presenter_room(session_id: str) -> str:
    return f'presenter_{session_id}'


def survey_room(session_id: str, survey_id: str) -> str:
    return f'survey_{session_id}_{survey_id}'


def session_room(session_id: str) -> str:
    return f'session_{session_id}'


# ── Session API ────────────────────────────────────────────────────────────

sessions_bp = Blueprint('sessions', __name__)


@sessions_bp.route('/api/session/create', methods=['POST'])
def api_create_session():
    session_id, _ = create_session()
    return jsonify({
        'session_id': session_id,
        'url': f'/s/{session_id}/',
    })
