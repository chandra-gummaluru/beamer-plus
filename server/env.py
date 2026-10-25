"""Settings from a .env file (KEY=value per line), so they needn't be set each time.

Looked for beside the repository root (app.py / launch.py). Values already in
the environment win. It is in .gitignore, since it is per-machine.
"""
import os

from .paths import BASE_PATH


def load_env():
    for path in [os.path.join(BASE_PATH, '.env')]:
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
