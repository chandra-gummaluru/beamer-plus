"""Built-in widget serving and the iframe-embeddability probe."""
import json
import os
import re
import urllib.request

from flask import Blueprint, jsonify, request, send_from_directory

from .paths import WIDGETS_DIR

widgets_bp = Blueprint('widgets', __name__)


@widgets_bp.route('/api/widgets')
def list_widgets():
    """Return sorted list of .html filenames from the widgets/ folder."""
    if not os.path.isdir(WIDGETS_DIR):
        return jsonify([])
    names = sorted(f for f in os.listdir(WIDGETS_DIR) if f.lower().endswith('.html'))
    return jsonify(names)


_SCHEMA_RE = re.compile(
    r'<script[^>]*\bid=["\']widget-schema["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def _read_schema(path):
    """The widget's own schema block, or {} if it has none or it won't parse.

    Only the head of the file is read: the schema is the first thing in
    <head>, and some widgets are several megabytes of inlined code.
    """
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            head = f.read(64_000)
        m = _SCHEMA_RE.search(head)
        return json.loads(m.group(1)) if m else {}
    except (OSError, ValueError):
        return {}


def _default_label(widget_type):
    return re.sub(r'[-_]+', ' ', widget_type).strip().title() or widget_type


@widgets_bp.route('/api/widgets/catalog')
def widget_catalog():
    """Every widget in widgets/, with the name and category its schema declares.

    Any .html dropped into the folder shows up in the Add Widget picker; one
    without a schema is listed under its file name in "Other".
    """
    if not os.path.isdir(WIDGETS_DIR):
        return jsonify([])
    out = []
    for fname in sorted(os.listdir(WIDGETS_DIR)):
        if not fname.lower().endswith('.html'):
            continue
        wtype = fname[:-5]
        schema = _read_schema(os.path.join(WIDGETS_DIR, fname))
        label = schema.get('label') if isinstance(schema.get('label'), str) else None
        category = schema.get('category') if isinstance(schema.get('category'), str) else None
        out.append({
            'file': fname,
            'type': wtype,
            'label': (label or '').strip() or _default_label(wtype),
            'category': (category or '').strip() or 'Other',
        })
    return jsonify(out)


@widgets_bp.route('/widgets/<path:filename>')
def serve_widget(filename):
    """Serve a widget HTML file from the widgets/ folder."""
    return send_from_directory(WIDGETS_DIR, filename)


@widgets_bp.route('/api/check-embeddable')
def check_embeddable():
    """HEAD-request a URL and report whether X-Frame-Options / CSP would block it."""
    url = request.args.get('url', '').strip()
    if not url or not url.startswith(('http://', 'https://')):
        return jsonify({'embeddable': False, 'reason': 'invalid_url'}), 400

    try:
        req = urllib.request.Request(
            url,
            method='HEAD',
            headers={
                'User-Agent': 'Mozilla/5.0 (compatible; BeamerPlusEmbedChecker/1.0)',
            },
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            xfo = resp.headers.get('X-Frame-Options', '')
            csp = resp.headers.get('Content-Security-Policy', '')

        blocked_by_xfo = xfo.strip().upper() in ('DENY', 'SAMEORIGIN')
        blocked_by_csp = 'frame-ancestors' in csp.lower()

        if blocked_by_xfo or blocked_by_csp:
            reason = 'x-frame-options' if blocked_by_xfo else 'csp-frame-ancestors'
            return jsonify({'embeddable': False, 'reason': reason})
        return jsonify({'embeddable': True})
    except Exception:
        # If the request fails we cannot be sure — let the iframe try. Don't
        # echo the exception text: this endpoint can be pointed at internal
        # addresses, and error details would leak what's listening there.
        return jsonify({'embeddable': True, 'note': 'unreachable'})
