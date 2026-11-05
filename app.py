"""Beamer+ development entry point.

All server code lives in the server/ package; this file only assembles the
app and provides the lightweight `python app.py` dev runner. The production
launcher is launch.py, which generates a real self-signed certificate.
"""
from server import app, socketio  # noqa: F401  (launch.py imports both from here)

# Running `python app.py` directly is the lightweight dev entry point. Here we
# fall back to Flask-SocketIO's built-in "adhoc" certificate so that HTTPS-only
# browser features (e.g. the camera widget) work on LAN addresses, dropping to
# plain HTTP only when forced or when `cryptography` is missing.
if __name__ == '__main__':
    import argparse
    from server.sessions import clear_orphaned_uploads
    clear_orphaned_uploads()
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5001)
    parser.add_argument('--http', action='store_true', help='Force plain HTTP (disables camera widget on LAN)')
    args = parser.parse_args()

    def _can_use_adhoc_ssl():
        try:
            from cryptography import x509  # noqa: F401  (required by adhoc SSL)
            return True
        except ImportError:
            return False

    # debug=False: this binds 0.0.0.0, so we must not expose the Werkzeug
    # interactive debugger to the LAN. allow_unsafe_werkzeug: serving over
    # Werkzeug is fine for the cooperative-LAN deployment model (launch.py
    # does the same).
    if args.http or not _can_use_adhoc_ssl():
        if not args.http:
            print('[WARN] Could not start HTTPS (cryptography library not found). Falling back to HTTP.')
            print('[WARN] The camera widget requires HTTPS on LAN addresses.')
        socketio.run(app, host='0.0.0.0', port=args.port, debug=False, allow_unsafe_werkzeug=True)
    else:
        socketio.run(app, host='0.0.0.0', port=args.port, debug=False, ssl_context='adhoc', allow_unsafe_werkzeug=True)
