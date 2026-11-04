"""Content filter for free-text survey answers.

Two layers, both on this computer (no answer leaves it):

1. Word list — `better-profanity` (in requirements.txt). Catches swear words,
   including leetspeak spellings ("sh1t"). Each question can carry its own
   allow list (words never to flag, e.g. course terms) and block list (extra
   words to flag), set in the widget and sent with the survey.
2. Toxicity model — `detoxify`, optional (pip install detoxify). Catches
   insults and threats that use no swear words. Loaded in the background at
   startup, so the server comes up at once; until it is ready, only the word
   list runs. Not installed: only the word list runs, as before.

Settings (environment or .env):
  BEAMER_CONTENT_FILTER=off        turn the filter off entirely
  BEAMER_TOXICITY_THRESHOLD=0.8    detoxify score (0–1) at which to reject
"""
import functools
import os
import re
import threading

# The answers worth checking: the ones a student types in their own words.
# Choices, ratings, numbers and plot points can't carry anything to filter.
TEXT_KINDS = {'open', 'wordcloud', 'fill'}

# Caps on a question's own lists, so a survey can't carry a dictionary.
MAX_LIST_WORDS = 200
MAX_WORD_LEN   = 60

# detoxify labels that mean "don't put this on the projector".
_TOX_LABELS = ('toxicity', 'severe_toxicity', 'obscene', 'threat', 'insult',
               'identity_attack', 'sexual_explicit')

_detox = None            # a Detoxify model, once loaded
_detox_state = 'idle'    # idle | loading | ready | unavailable


def enabled():
    return os.environ.get('BEAMER_CONTENT_FILTER', 'on').strip().lower() not in ('off', '0', 'false', 'no')


def _threshold():
    try:
        return min(1.0, max(0.0, float(os.environ.get('BEAMER_TOXICITY_THRESHOLD', '0.8'))))
    except ValueError:
        return 0.8


def clean_words(words):
    """A question's allow or block list as sent by the widget: lower-cased,
    trimmed, de-duplicated, capped."""
    if isinstance(words, str):
        words = re.split(r'[,\n]', words)
    if not isinstance(words, list):
        return []
    out = []
    for w in words:
        w = ' '.join(str(w).split()).lower()[:MAX_WORD_LEN]
        if w and w not in out:
            out.append(w)
    return out[:MAX_LIST_WORDS]


_better_profanity_missing = False


@functools.lru_cache(maxsize=64)
def _profanity_for(allow, block):
    """A word-list checker with this question's allow and block lists.
    Cheap to build (~10 ms) and cached, since a poll checks every answer
    against the same lists."""
    global _better_profanity_missing
    try:
        from better_profanity.better_profanity import Profanity
    except ImportError:
        if not _better_profanity_missing:
            print('Content filter: better-profanity is not installed (pip install -r requirements.txt); '
                  'free-text answers are only checked against block lists.')
        _better_profanity_missing = True
        return None
    p = Profanity()
    p.load_censor_words(whitelist_words=list(allow))
    words = [w for w in block if ' ' not in w]
    if words:
        p.add_censor_words(words)
    return p


def _has_phrase(text, phrases):
    """Block-list entries of more than one word, matched as whole words."""
    low = ' '.join(text.lower().split())
    return any(re.search(r'(?<!\w)' + re.escape(ph) + r'(?!\w)', low) for ph in phrases)


def _without(text, allow):
    """The text with allowed words taken out, so the toxicity model doesn't
    flag a course term the presenter has said is fine."""
    for w in allow:
        text = re.sub(r'(?<!\w)' + re.escape(w) + r'(?!\w)', ' ', text, flags=re.I)
    return text


def _load_detoxify():
    global _detox, _detox_state
    try:
        from detoxify import Detoxify
    except ImportError:
        _detox_state = 'unavailable'
        return
    try:
        model = Detoxify('unbiased')   # fewer false flags on text that names identity groups
        model.predict('warm up')
        _detox = model
        _detox_state = 'ready'
        print('Content filter: detoxify model ready.')
    except Exception as e:   # no network for the first download, a broken torch install, …
        print(f'Content filter: detoxify could not be loaded ({e}); using the word list only.')
        _detox_state = 'unavailable'


def init():
    """Load the filters. Called once at startup; detoxify loads in the background."""
    global _detox_state
    if not enabled():
        return
    _profanity_for((), ())
    if _detox_state == 'idle':
        _detox_state = 'loading'
        threading.Thread(target=_load_detoxify, name='detoxify-load', daemon=True).start()


def status():
    return {'enabled': enabled(), 'word_list': not _better_profanity_missing, 'toxicity_model': _detox_state}


def check(texts, allow=(), block=()):
    """Return None when the answer is fine, or a short reason it was rejected.

    `texts` is the answer's own words: one string, or one per blank.
    `allow` / `block` are the question's own lists (see clean_words)."""
    if not enabled():
        return None
    if isinstance(texts, str):
        texts = [texts]
    texts = [t for t in texts if isinstance(t, str) and t.strip()]
    if not texts:
        return None
    allow, block = tuple(clean_words(list(allow))), tuple(clean_words(list(block)))
    phrases = [w for w in block if ' ' in w]
    if phrases and any(_has_phrase(t, phrases) for t in texts):
        return 'profanity'
    prof = _profanity_for(allow, block)
    if prof is not None and any(prof.contains_profanity(t) for t in texts):
        return 'profanity'
    if _detox is not None:
        try:
            scored = _without(' / '.join(texts), allow)
            if scored.strip(' /'):
                scores = _detox.predict(scored)
                limit = _threshold()
                if any(float(scores.get(k, 0)) >= limit for k in _TOX_LABELS):
                    return 'toxicity'
        except Exception as e:
            print(f'Content filter: detoxify failed on an answer ({e}); let it through.')
    return None
