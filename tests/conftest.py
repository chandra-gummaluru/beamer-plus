import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def pytest_configure(config):
    config.addinivalue_line('markers', 'real_voters: answers count as the same phone (the one-answer rule)')
