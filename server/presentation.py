"""Presentation upload, ZIP asset serving, and the bundled demo (per session).

Everything here except the demo is presenter-only (see sessions.require_presenter).
"""
import io
import mimetypes
import os
import posixpath
import traceback
import zipfile

from flask import Blueprint, Response, current_app, jsonify, request, send_file

import threading

from .sessions import _env_number, _sessions, require_presenter

_assets_lock = threading.Lock()


def all_temp_assets_bytes():
    return sum(s.temp_assets_bytes() for s in list(_sessions.values()))

presentation_bp = Blueprint('presentation', __name__)

# Uploaded one at a time from the editor (a widget's PDF, notebook, …) and held
# in memory, so they get a budget of their own per session.
MAX_TEMP_ASSETS_MB = _env_number('BEAMER_MAX_TEMP_ASSETS_MB', 256)
# …and all sessions together.
MAX_TEMP_ASSETS_TOTAL_MB = _env_number('BEAMER_MAX_TEMP_ASSETS_TOTAL_MB', 1024)
_CHUNK = 256 * 1024


def _asset_headers(resp):
    resp.headers['Content-Security-Policy'] = 'sandbox'
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    return resp


def _asset_response(data, filepath):
    """A deck file, served so that it can never act as a page of this app.

    Deck files and uploaded assets are presenter content, but they're served
    from the app's own origin: an HTML or SVG file opened directly would run
    with the app's privileges. `sandbox` puts any such document in an opaque
    origin with scripts off; widgets load their HTML with fetch() and are
    unaffected. nosniff stops a browser guessing a type we didn't send."""
    mime = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
    return _asset_headers(Response(data, mimetype=mime))


def _stream_zip_entry(zip_path, info):
    """An entry's bytes a chunk at a time, so a large (or falsely large)
    entry is never inflated into memory whole."""
    with zipfile.ZipFile(zip_path, 'r') as z, z.open(info) as f:
        while True:
            chunk = f.read(_CHUNK)
            if not chunk:
                break
            yield chunk


def _save_and_load(sess, session_id, file):
    sess.temp_assets.clear()
    filepath = os.path.join(sess.upload_dir(session_id), 'current.zip')
    file.save(filepath)
    # Summarizer models come only from the server's own ai/ folder. Code
    # inside an uploaded ZIP is never run (a deck can come from anywhere).
    sess.current_presentation['file'] = filepath
    return filepath


@presentation_bp.route('/s/<session_id>/upload', methods=['POST'])
@require_presenter
def upload(session_id, sess):
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    _save_and_load(sess, session_id, request.files['file'])
    available_models = sess.current_presentation.get('available_models', [])
    return jsonify({
        'success': True,
        'models': available_models,
        'models_found': len(available_models),
    })


@presentation_bp.route('/api/demo-zip')
def serve_demo_zip():
    from .paths import BASE_PATH
    demo_dir = os.path.join(BASE_PATH, 'demo')
    if not os.path.isdir(demo_dir):
        return jsonify({'error': 'Demo not found'}), 404
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(demo_dir):
            for fname in files:
                fpath = os.path.join(root, fname)
                arcname = os.path.relpath(fpath, demo_dir)
                zf.write(fpath, arcname)
    buf.seek(0)
    return send_file(buf, mimetype='application/zip', download_name='demo.zip')


@presentation_bp.route('/s/<session_id>/api/zip-asset/<path:filepath>')
@require_presenter
def serve_zip_asset(session_id, filepath, sess):
    if filepath in sess.temp_assets:
        return _asset_response(sess.temp_assets[filepath], filepath)
    if not sess.current_presentation.get('file') or not os.path.exists(sess.current_presentation['file']):
        return jsonify({'error': 'No presentation loaded'}), 404
    zip_path = sess.current_presentation['file']
    try:
        with zipfile.ZipFile(zip_path, 'r') as z:
            try:
                info = z.getinfo(filepath)
            except KeyError:
                return jsonify({'error': 'File not found'}), 404
        # A ZIP's declared sizes can be far bigger than the upload was
        # (a "zip bomb"); don't inflate anything past the upload limit.
        limit = current_app.config.get('MAX_CONTENT_LENGTH')
        if limit and info.file_size > limit:
            return jsonify({'error': 'File too large'}), 413
        mime = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
        resp = Response(_stream_zip_entry(zip_path, info), mimetype=mime)
        resp.headers['Content-Length'] = str(info.file_size)
        return _asset_headers(resp)
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Could not read the presentation'}), 500


def _clean_part(s, fallback):
    """One path segment-ish piece from the client: no '..', no leading '/'."""
    s = posixpath.normpath(str(s or '').replace('\\', '/')).lstrip('/')
    if not s or s == '.' or s.startswith('..'):
        return fallback
    return s


@presentation_bp.route('/s/<session_id>/api/upload-asset', methods=['POST'])
@require_presenter
def upload_asset(session_id, sess):
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    folder = _clean_part(request.form.get('folder'), 'assets')
    name = _clean_part(posixpath.basename((f.filename or '').replace('\\', '/')), 'file')
    path = f'{folder}/{name}'
    data = f.read()
    budget = int(MAX_TEMP_ASSETS_MB * 1024 * 1024)
    total_budget = int(MAX_TEMP_ASSETS_TOTAL_MB * 1024 * 1024)
    with _assets_lock:
        grows = len(data) - len(sess.temp_assets.get(path, b''))
        if sess.temp_assets_bytes() + grows > budget:
            return jsonify({'error': 'Too many uploaded files in this session. Save and reopen the presentation.'}), 413
        if all_temp_assets_bytes() + grows > total_budget:
            return jsonify({'error': 'The server is out of room for uploaded files. Try again later.'}), 413
        sess.temp_assets[path] = data
    return jsonify({'path': path, 'url': f'/s/{session_id}/api/zip-asset/{path}'})


@presentation_bp.route('/s/<session_id>/api/models')
@require_presenter
def get_models(session_id, sess):
    return jsonify({'models': sess.current_presentation.get('available_models', [])})
