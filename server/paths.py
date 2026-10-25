"""Filesystem locations for the Beamer+ server.

Everything is resolved relative to BASE_PATH, the repository root.
"""
import os

# This file lives in server/, so the repo root is one level up.
BASE_PATH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UPLOAD_FOLDER = os.path.join(BASE_PATH, 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

WIDGETS_DIR = os.path.join(BASE_PATH, 'widgets')
os.makedirs(WIDGETS_DIR, exist_ok=True)

AI_MODELS_DIR = os.path.join(BASE_PATH, 'ai')
