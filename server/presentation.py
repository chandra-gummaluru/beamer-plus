"""Presentation upload, ZIP asset serving, and the bundled demo (per session)."""
import io
import mimetypes
import os
import zipfile

from flask import Blueprint, Response, jsonify, request, send_file

from . import ai_models
from .sessions import get_session_or_404

presentation_bp = Blueprint('presentation', __name__)


def _save_and_load(sess, session_id, file):
    sess.temp_assets.clear()
    filepath = os.path.join(sess.upload_dir(session_id), 'current.zip')
    file.save(filepath)
    merged, merged_available = ai_models.merge_zip_models(filepath)
    sess.current_presentation['file'] = filepath
    sess.current_presentation['models'] = merged
    sess.current_presentation['available_models'] = merged_available
    return filepath, merged_available


@presentation_bp.route('/s/<session_id>/upload', methods=['POST'])
def upload(session_id):
    sess = get_session_or_404(session_id)
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    _, available_models = _save_and_load(sess, session_id, request.files['file'])
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
def serve_zip_asset(session_id, filepath):
    sess = get_session_or_404(session_id)
    if filepath in sess.temp_assets:
        mime = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
        resp = Response(sess.temp_assets[filepath], mimetype=mime)
        resp.headers['Access-Control-Allow-Origin'] = '*'
        return resp
    if not sess.current_presentation.get('file') or not os.path.exists(sess.current_presentation['file']):
        return jsonify({'error': 'No presentation loaded'}), 404
    try:
        with zipfile.ZipFile(sess.current_presentation['file'], 'r') as z:
            if filepath not in z.namelist():
                return jsonify({'error': f'File not found: {filepath}'}), 404
            data = z.read(filepath)
            mime = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
            resp = Response(data, mimetype=mime)
            resp.headers['Access-Control-Allow-Origin'] = '*'
            return resp
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@presentation_bp.route('/s/<session_id>/api/upload-asset', methods=['POST'])
def upload_asset(session_id):
    sess = get_session_or_404(session_id)
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    folder = request.form.get('folder', 'assets')
    path = f'{folder}/{f.filename}'
    sess.temp_assets[path] = f.read()
    return jsonify({'path': path, 'url': f'/s/{session_id}/api/zip-asset/{path}'})


@presentation_bp.route('/s/<session_id>/api/models')
def get_models(session_id):
    sess = get_session_or_404(session_id)
    return jsonify({'models': sess.current_presentation.get('available_models', [])})
