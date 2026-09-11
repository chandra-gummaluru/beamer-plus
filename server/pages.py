"""HTML pages and PWA files (manifest, service worker)."""
import os

from flask import Blueprint, render_template, send_file

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


@pages_bp.route('/service-worker.js')
def service_worker():
    # Served only so browsers still carrying the old caching worker can replace
    # it with the tombstone that removes itself. See service-worker.js.
    resp = send_file(os.path.join(BASE_PATH, 'service-worker.js'),
                     mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp
