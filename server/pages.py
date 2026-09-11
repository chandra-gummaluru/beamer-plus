"""HTML pages and PWA files (manifest, service worker)."""
import hashlib
import os

from flask import Blueprint, Response, render_template, send_file

from .paths import BASE_PATH
from .sessions import get_session_or_404

pages_bp = Blueprint('pages', __name__)


@pages_bp.route('/')
def welcome():
    # Institution / host label shown under the wordmark on the landing page.
    # Override per deployment with the BEAMER_INSTITUTION environment variable.
    institution = os.environ.get('BEAMER_INSTITUTION', 'University of Toronto')
    return render_template('welcome.html', institution=institution)


@pages_bp.route('/s/<session_id>/')
@pages_bp.route('/s/<session_id>')
def presenter(session_id):
    get_session_or_404(session_id)
    return render_template('index.html', session_id=session_id)


@pages_bp.route('/s/<session_id>/survey/<survey_id>')
def survey_page(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return render_template('survey_not_found.html'), 404
    return render_template('survey_response.html', session_id=session_id, survey_id=survey_id)


@pages_bp.route('/s/<session_id>/wordcloud/<survey_id>')
def wordcloud_page(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return render_template('survey_not_found.html'), 404
    return render_template('survey_response.html', session_id=session_id, survey_id=survey_id)


@pages_bp.route('/s/<session_id>/mcq/<survey_id>')
def mcq_page(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return render_template('survey_not_found.html'), 404
    return render_template('mcq_response.html', session_id=session_id, survey_id=survey_id)


# ── PWA ────────────────────────────────────────────────────────────────────

@pages_bp.route('/manifest.json')
def manifest():
    resp = send_file(os.path.join(BASE_PATH, 'manifest.json'), mimetype='application/manifest+json')
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


# Directories whose contents are the app itself. A change to any file under
# them should invalidate the browser's service-worker caches.
_BUILD_STAMP_DIRS = ('static', 'widgets', 'templates')


def _build_stamp():
    """A short hash over the app's files, used as the service worker's cache version.

    Derived from each file's path, size and modification time rather than its
    contents: enough to change whenever anything is edited, cheap enough to do
    on the rare request for the service worker script, and it needs no build
    step. Every edit therefore retires the previous caches automatically, which
    is the whole point — a hand-maintained version number gets forgotten, and a
    forgotten bump leaves the browser serving a stale build.
    """
    h = hashlib.sha1()
    for rel in _BUILD_STAMP_DIRS:
        root = os.path.join(BASE_PATH, rel)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith('.') and d != '__pycache__')
            for name in sorted(filenames):
                if name.startswith('.'):
                    continue
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                h.update(os.path.relpath(full, BASE_PATH).replace(os.sep, '/').encode())
                h.update(b'%d:%d' % (st.st_size, int(st.st_mtime)))
    sw = os.path.join(BASE_PATH, 'service-worker.js')
    try:
        st = os.stat(sw)
        h.update(b'sw%d:%d' % (st.st_size, int(st.st_mtime)))
    except OSError:
        pass
    return h.hexdigest()[:12]


@pages_bp.route('/service-worker.js')
def service_worker():
    with open(os.path.join(BASE_PATH, 'service-worker.js'), 'r', encoding='utf-8') as f:
        source = f.read()
    resp = Response(source.replace('__BUILD__', _build_stamp()),
                    mimetype='application/javascript')
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp
