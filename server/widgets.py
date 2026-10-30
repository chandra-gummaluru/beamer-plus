"""Built-in widget serving and the iframe-embeddability probe."""
import json
import os
import re

from flask import Blueprint, jsonify, send_from_directory

from .paths import WIDGETS_DIR

widgets_bp = Blueprint('widgets', __name__)


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
            # Can be added to a split view, one half on each of its slides:
            # which panes may go on each side ({left: [...], right: [...]}).
            'split': schema.get('split') if isinstance(schema.get('split'), dict) else None,
        })
    return jsonify(out)


@widgets_bp.route('/widgets/<path:filename>')
def serve_widget(filename):
    """Serve a widget HTML file from the widgets/ folder."""
    return send_from_directory(WIDGETS_DIR, filename)
