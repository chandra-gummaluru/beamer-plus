"""Settings from a .env file (KEY=value per line), so they needn't be set each time.

Looked for beside the repository root (app.py / launch.py) and, in a frozen
build, beside the executable. Values already in the environment win. It is in
.gitignore, since it is per-machine.
"""
import os
import sys

from .paths import BASE_PATH


def _candidates():
    yield os.path.join(BASE_PATH, '.env')
    if getattr(sys, 'frozen', False):
        yield os.path.join(os.path.dirname(sys.executable), '.env')


def load_env():
    for path in _candidates():
        try:
            with open(path, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except (FileNotFoundError, OSError):
            pass
