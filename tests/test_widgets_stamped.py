"""Every widget carries its own copy of the shared base stylesheet and kit, so
it works opened on its own. Those copies must match the sources."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_widget_copies_are_current():
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'stamp_widgets.py'), '--check'],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
