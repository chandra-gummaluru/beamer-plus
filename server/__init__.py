"""Beamer+ Flask server package.

Module map:
- core.py          Flask app + Socket.IO instances
- paths.py         BASE_PATH and derived folders
- state.py         shared limits (MAX_RESPONSES_PER_SURVEY, …)
- sessions.py      per-presenter session registry + create API
- ai_models.py     survey-summarization model loading (server ai/ folder only)
- pages.py         HTML pages and PWA files
- presentation.py  upload, ZIP assets, demo packaging
- widgets.py       built-in widget serving, embeddability probe
- surveys.py       survey REST API
- moderation.py    content filter for free-text answers
- sockets.py       Socket.IO handlers
- env.py           settings from a .env file

Entry points import `app` and `socketio` from here (see ../app.py, ../launch.py).
"""
from .env import load_env

load_env()   # before anything reads the environment

from .core import app, socketio  # noqa: E402

from . import sockets  # noqa: F401  (registers Socket.IO handlers on import)
from .ai_models import init_builtin_models  # noqa: E402
from . import moderation  # noqa: E402
from .pages import pages_bp
from .presentation import presentation_bp
from .sessions import sessions_bp
from .surveys import surveys_bp
from .widgets import widgets_bp

app.register_blueprint(pages_bp)
app.register_blueprint(presentation_bp)
app.register_blueprint(widgets_bp)
app.register_blueprint(surveys_bp)
app.register_blueprint(sessions_bp)

init_builtin_models()
moderation.init()

# Idle sessions are swept while the server runs. (Old decks left in uploads/
# by an earlier run are cleared by the entry points: sessions.clear_orphaned_uploads.)
from .sessions import start_idle_sweeper  # noqa: E402
start_idle_sweeper()
