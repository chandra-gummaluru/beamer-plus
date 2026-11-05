"""Loading of survey-summarization models.

Models come only from the server's own `ai/*.py` files (see
paths.AI_MODELS_DIR), which only whoever runs the server can change. An
`ai/` folder inside an uploaded presentation ZIP is ignored: loading a deck
never runs code from it.

A model file must expose `summarize(responses, n, api_key=None)` returning a
list of exactly n (summary_text, num_respondents) tuples.
"""
import importlib.util
import os
import sys

from .paths import AI_MODELS_DIR

_builtin_models: dict = {}
_builtin_available: list = []


def init_builtin_models():
    global _builtin_models, _builtin_available
    _builtin_models, _builtin_available = load_builtin_models()


def get_builtin_models():
    """Return (models dict, available name list) for new session initialization."""
    return _builtin_models, _builtin_available


def load_builtin_models():
    models = {}
    available_models = []
    if not os.path.isdir(AI_MODELS_DIR):
        return models, available_models
    for filename in sorted(os.listdir(AI_MODELS_DIR)):
        if not filename.endswith('.py') or filename.startswith('_'):
            continue
        model_name = filename[:-3]
        model_path = os.path.join(AI_MODELS_DIR, filename)
        try:
            spec = importlib.util.spec_from_file_location(model_name, model_path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'builtin_ai_{model_name}'] = module
            spec.loader.exec_module(module)
            if hasattr(module, 'summarize'):
                models[model_name] = getattr(module, 'summarize')
                available_models.append(model_name)
        except Exception as e:
            print(f'Error loading built-in model {filename}: {e}')
    return models, available_models
