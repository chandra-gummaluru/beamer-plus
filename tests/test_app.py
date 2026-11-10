"""API tests for the Beamer+ Flask server.

Run with: pytest
"""
import io
import itertools
import os
import time
import zipfile

import pytest

import server.sessions as sessions_mod
import server.state as state
import server.surveys as surveys_mod
from server import app as flask_app
from server import socketio


@pytest.fixture
def client():
    flask_app.config['TESTING'] = True
    return flask_app.test_client()


@pytest.fixture
def audience():
    """A second browser: a student's phone, with no presenter cookie."""
    return flask_app.test_client()


_voters = itertools.count()


@pytest.fixture(autouse=True)
def every_answer_from_a_new_phone(request, monkeypatch):
    """Most tests post many answers from one test client; the server takes one
    per phone, so here each answer counts as a new phone. Tests of the
    one-answer rule opt out with @pytest.mark.real_voters."""
    if 'real_voters' not in request.keywords:
        monkeypatch.setattr(surveys_mod, 'voter_id', lambda: f'test:{next(_voters)}')
    sessions_mod._creates_by_ip.clear()
    # Every test session comes from 127.0.0.1; the tests of the caps set their own.
    monkeypatch.setattr(sessions_mod, 'MAX_LIVE_SESSIONS_PER_IP', 0)


def make_presentation_zip(with_model=False):
    """Build an in-memory presentation ZIP."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr('slides.pdf', b'%PDF-1.4 fake test pdf')
        zf.writestr('assets/note.txt', b'hello from the zip')
        if with_model:
            zf.writestr('ai/testmodel.py', (
                'def summarize(responses, n, api_key=None):\n'
                '    return [(f"theme {i}", len(responses)) for i in range(n)]\n'
            ))
    buf.seek(0)
    return buf


def create_session(client):
    resp = client.post('/api/session/create')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['session_id']
    assert data['url'] == f"/s/{data['session_id']}/"
    return data['session_id']


def session_prefix(session_id):
    return f'/s/{session_id}'


def upload_zip(client, session_id, **kwargs):
    resp = client.post(f'{session_prefix(session_id)}/upload', data={
        'file': (make_presentation_zip(**kwargs), 'presentation.zip'),
    }, content_type='multipart/form-data')
    assert resp.status_code == 200
    return resp.get_json()


def create_survey(client, session_id, **payload):
    resp = client.post(f'{session_prefix(session_id)}/api/survey/create', json=payload)
    assert resp.status_code == 200
    return resp.get_json()


# ── Sessions ───────────────────────────────────────────────────────────────────

def test_welcome_page(client):
    resp = client.get('/')
    assert resp.status_code == 200
    assert b'New Session' in resp.data and b'Try Demo' in resp.data


def test_session_create_and_presenter_page(client):
    session_id = create_session(client)
    resp = client.get(f'/s/{session_id}/')
    assert resp.status_code == 200
    assert session_id.encode() in resp.data
    assert b'BEAMER_SESSION_ID' in resp.data


def test_session_isolation(client):
    """Two sessions must not share surveys or presentations."""
    s1 = create_session(client)
    s2 = create_session(client)

    survey1 = create_survey(client, s1, question='Session one')
    survey2 = create_survey(client, s2, question='Session two')

    assert survey1['survey_id'] != survey2['survey_id'] or s1 != s2

    # Survey pages are scoped to their session
    assert client.get(f'/s/{s1}/survey/{survey1["survey_id"]}').status_code == 200
    assert client.get(f'/s/{s2}/survey/{survey1["survey_id"]}').status_code == 404

    upload_zip(client, s1)
    assert client.get(f'{session_prefix(s1)}/api/zip-asset/assets/note.txt').status_code == 200
    assert client.get(f'{session_prefix(s2)}/api/zip-asset/assets/note.txt').status_code == 404

    sess1 = sessions_mod.get_session(s1)
    sess2 = sessions_mod.get_session(s2)
    assert survey1['survey_id'] in sess1.surveys
    assert survey1['survey_id'] not in sess2.surveys


# ── Pages and static endpoints ─────────────────────────────────────────────────

def test_manifest_and_service_worker(client):
    assert client.get('/manifest.json').status_code == 200
    resp = client.get('/service-worker.js')
    assert resp.status_code == 200
    assert resp.headers['Service-Worker-Allowed'] == '/'


def test_widget_serving(client):
    assert client.get('/widgets/timer.html').status_code == 200


def test_widget_catalog_lists_every_widget_with_its_schema(client):
    import os
    from server.paths import WIDGETS_DIR
    catalog = client.get('/api/widgets/catalog').get_json()
    on_disk = sorted(f for f in os.listdir(WIDGETS_DIR) if f.lower().endswith('.html'))
    assert [w['file'] for w in catalog] == on_disk
    by_type = {w['type']: w for w in catalog}
    assert by_type['python-workspace']['category'] == 'Computer Science'
    assert all(w['label'] and w['category'] for w in catalog)
    # Portable (opened from the annotation toolbar): any widget with an
    # overlay mode, unless its schema says otherwise.
    assert by_type['timer']['portable'] and by_type['calculator']['portable']
    assert by_type['timer']['overlaySize'] == {'width': 0.26, 'height': 0.2}
    assert not by_type['python-workspace']['portable']
    assert not by_type['function-plotter']['portable']   # opted out


def test_widget_schemas_declare_valid_modes():
    import json, os, re
    from server.paths import WIDGETS_DIR
    rx = re.compile(r'<script[^>]*id="widget-schema"[^>]*>(.*?)</script>', re.S)
    for fname in os.listdir(WIDGETS_DIR):
        if not fname.endswith('.html'):
            continue
        with open(os.path.join(WIDGETS_DIR, fname), encoding='utf-8') as f:
            m = rx.search(f.read(64_000))
        if not m:
            continue
        schema = json.loads(m.group(1))
        modes = schema.get('modes')
        if modes is not None:
            assert modes and set(modes) <= {'full', 'overlay'}, fname
            assert not schema.get('fullSlide'), fname
    def modes_of(name):
        with open(os.path.join(WIDGETS_DIR, name), encoding='utf-8') as f:
            return json.loads(rx.search(f.read()).group(1)).get('modes')
    assert modes_of('timer.html') == ['full', 'overlay']
    assert modes_of('calculator.html') == ['full', 'overlay']


def test_vendored_libraries_served(client):
    for path in (
        '/static/vendor/socket.io.min.js',
        '/static/vendor/jszip.min.js',
        '/static/vendor/pdfjs/pdf.min.mjs',
        '/static/vendor/pdfjs/pdf.worker.min.mjs',
    ):
        assert client.get(path).status_code == 200, path


# ── Upload and ZIP assets ──────────────────────────────────────────────────────

def test_upload(client):
    session_id = create_session(client)
    data = upload_zip(client, session_id)
    assert data['success'] is True


def test_upload_never_runs_code_from_the_zip(client, tmp_path):
    marker = tmp_path / 'ran.txt'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr('slides.pdf', b'%PDF-1.4 fake')
        zf.writestr('ai/evil.py', f'open({str(marker)!r}, "w").write("x")\n'
                                  'def summarize(responses, n, api_key=None):\n    return []\n')
    buf.seek(0)
    session_id = create_session(client)
    resp = client.post(f'/s/{session_id}/upload', data={'file': (buf, 'deck.zip')},
                       content_type='multipart/form-data')
    assert resp.status_code == 200
    assert not marker.exists()
    assert 'evil' not in resp.get_json()['models']
    models = client.get(f'{session_prefix(session_id)}/api/models').get_json()['models']
    assert 'evil' not in models
    assert 'claude' in models and 'gpt4o' in models


def test_zip_asset_serving(client):
    session_id = create_session(client)
    upload_zip(client, session_id)
    resp = client.get(f'{session_prefix(session_id)}/api/zip-asset/assets/note.txt')
    assert resp.status_code == 200
    assert resp.data == b'hello from the zip'
    assert client.get(f'{session_prefix(session_id)}/api/zip-asset/assets/missing.txt').status_code == 404


def test_temp_asset_upload(client):
    session_id = create_session(client)
    resp = client.post(f'{session_prefix(session_id)}/api/upload-asset', data={
        'file': (io.BytesIO(b'temp bytes'), 'pic.png'),
        'folder': 'assets',
    }, content_type='multipart/form-data')
    assert resp.status_code == 200
    path = resp.get_json()['path']
    assert client.get(f'{session_prefix(session_id)}/api/zip-asset/{path}').data == b'temp bytes'


# ── Surveys ────────────────────────────────────────────────────────────────────

def test_survey_lifecycle(client):
    session_id = create_session(client)
    survey = create_survey(client, session_id, question='What did you learn?')
    sid = survey['survey_id']
    assert survey['url'] == f'/s/{session_id}/survey/{sid}'

    assert client.get(f'/s/{session_id}/survey/{sid}').status_code == 200
    assert client.get(f'/s/{session_id}/survey/nonexistent').status_code == 404

    resp = client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'lots'})
    assert resp.get_json()['success'] is True

    data = client.get(f'{session_prefix(session_id)}/api/survey/{sid}/responses').get_json()
    assert data['total'] == 1
    assert data['responses'][0]['text'] == 'lots'
    assert client.get(f'{session_prefix(session_id)}/api/survey/{sid}/responses?after=1').get_json()['responses'] == []

    client.post(f'{session_prefix(session_id)}/api/survey/{sid}/close')
    resp = client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'late'})
    assert resp.status_code == 403


def test_content_filter_rejects_profanity_in_free_text(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Thoughts?', kind='open')['survey_id']
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'

    resp = client.post(url, json={'response': 'this is sh1t'})
    assert resp.status_code == 422
    assert resp.get_json()['rejected'] == 'profanity'
    assert 'rephrase' in resp.get_json()['error']

    assert client.post(url, json={'response': 'recursion is neat'}).status_code == 200
    data = client.get(f'{session_prefix(session_id)}/api/survey/{sid}/responses').get_json()
    assert [r['text'] for r in data['responses']] == ['recursion is neat']


def test_content_filter_checks_each_blank(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Fill', kind='fill', meta={'template': 'A ___ B ___'})['survey_id']
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'
    assert client.post(url, json={'response': '["stack", "fuck"]'}).status_code == 422
    assert client.post(url, json={'response': '["stack", "queue"]'}).status_code == 200


def test_content_filter_skips_the_presenters_own_options(client):
    session_id = create_session(client)
    tpl = 'Rate it: BLANK(great ^ damn hard) Why: BLANK Tags: BLANK(fun | hell week)'
    sid = create_survey(client, session_id, question='Fill', kind='fill', meta={'template': tpl})['survey_id']
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'
    assert client.post(url, json={'response': '["damn hard", "too long", ["fun", "hell week"]]'}).status_code == 200
    assert client.post(url, json={'response': '["great", "damn it", []]'}).status_code == 422


def test_content_filter_can_be_turned_off_per_question(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q', kind='open', filter=False)['survey_id']
    resp = client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'damn'})
    assert resp.status_code == 200


def test_content_filter_uses_the_questions_own_lists(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q', kind='open',
                        filter_allow=['Hell'], filter_block='quiz bowl, mumble')['survey_id']
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'
    assert client.post(url, json={'response': 'the hell of exam week'}).status_code == 200
    assert client.post(url, json={'response': 'MUMBLE'}).status_code == 422
    assert client.post(url, json={'response': 'like quiz  bowl'}).status_code == 422
    assert client.post(url, json={'response': 'quiz bowling'}).status_code == 200

    # Another question keeps the default lists.
    other = create_survey(client, session_id, question='Q2', kind='open')['survey_id']
    assert client.post(f'{session_prefix(session_id)}/api/survey/{other}/respond',
                       json={'response': 'what the hell'}).status_code == 422
    assert client.post(f'{session_prefix(session_id)}/api/survey/{other}/respond',
                       json={'response': 'mumble'}).status_code == 200

    # The lists are the presenter's; the phone's view of the survey leaves them out.
    public = client.get(f'{session_prefix(session_id)}/api/survey/{sid}').get_json()
    assert 'filter_allow' not in public and 'filter_block' not in public


def test_content_filter_uses_toxicity_model_when_loaded(client, monkeypatch):
    from server import moderation

    class FakeDetox:
        def predict(self, text):
            return {'toxicity': 0.95 if 'useless' in text else 0.01}

    monkeypatch.setattr(moderation, '_detox', FakeDetox())
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q', kind='open')['survey_id']
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'
    resp = client.post(url, json={'response': 'you are useless'})
    assert resp.status_code == 422 and resp.get_json()['rejected'] == 'toxicity'
    assert client.post(url, json={'response': 'great lecture'}).status_code == 200


def test_survey_public_endpoint_does_not_leak_api_key(client):
    session_id = create_session(client)
    survey = create_survey(client, session_id, question='Q', model='claude', api_key='sk-secret')
    data = client.get(f"{session_prefix(session_id)}/api/survey/{survey['survey_id']}").get_json()
    assert 'api_key' not in data
    assert 'sk-secret' not in str(data)
    assert 'model' not in data


def test_mcq_and_wordcloud_urls(client):
    session_id = create_session(client)
    mcq = create_survey(client, session_id, question='Pick one', options=['a', 'b'])
    assert mcq['url'] == f'/s/{session_id}/mcq/{mcq["survey_id"]}'
    wc = create_survey(client, session_id, question='One word', kind='wordcloud')
    assert wc['url'] == f'/s/{session_id}/wordcloud/{wc["survey_id"]}'


def test_survey_kinds_route_to_the_right_page(client):
    session_id = create_session(client)
    pre = session_prefix(session_id)
    tf = create_survey(client, session_id, question='T?', options=['True', 'False'], kind='truefalse')
    assert tf['url'] == f'/s/{session_id}/mcq/{tf["survey_id"]}'
    rating = create_survey(client, session_id, question='Rate', kind='rating',
                           meta={'min': 1, 'max': 5, 'low': 'Bad', 'high': 'Good', 'nested': {'x': 1}})
    assert rating['url'] == f'/s/{session_id}/survey/{rating["survey_id"]}'
    info = client.get(f'{pre}/api/survey/{rating["survey_id"]}').get_json()
    assert info['kind'] == 'rating'
    assert info['meta'] == {'min': 1, 'max': 5, 'low': 'Bad', 'high': 'Good'}
    wc = create_survey(client, session_id, question='Word', kind='wordcloud')
    assert wc['url'] == f'/s/{session_id}/wordcloud/{wc["survey_id"]}'
    odd = create_survey(client, session_id, question='Q', kind='bogus')
    assert client.get(f'{pre}/api/survey/{odd["survey_id"]}').get_json()['kind'] == 'open'


def test_fill_in_the_blanks_survey_carries_its_template(client):
    session_id = create_session(client)
    tpl = '>>> f(BLANK, BLANK)\nTrue'
    fill = create_survey(client, session_id, question='Fill in the blanks', kind='fill',
                         meta={'template': tpl})
    assert fill['url'] == f'/s/{session_id}/survey/{fill["survey_id"]}'
    info = client.get(f'{session_prefix(session_id)}/api/survey/{fill["survey_id"]}').get_json()
    assert info['kind'] == 'fill'
    assert info['meta']['template'] == tpl
    # A template longer than the display-hint cap is kept, not dropped.
    long_tpl = 'x BLANK ' * 1200
    big = create_survey(client, session_id, question='Q', kind='fill', meta={'template': long_tpl})
    meta = client.get(f'{session_prefix(session_id)}/api/survey/{big["survey_id"]}').get_json()['meta']
    assert meta['template'] == long_tpl[:8000]


def test_create_survey_with_unknown_model_rejected(client):
    session_id = create_session(client)
    resp = client.post(f'{session_prefix(session_id)}/api/survey/create', json={'question': 'Q', 'model': 'nope'})
    assert resp.status_code == 400


def test_response_cap(client, monkeypatch):
    monkeypatch.setattr(state, 'MAX_RESPONSES_PER_SURVEY', 2)
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    for _ in range(2):
        assert client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'x'}).status_code == 200
    resp = client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'overflow'})
    assert resp.status_code == 429


def _add_test_model(session_id):
    sess = sessions_mod.get_session(session_id)
    sess.current_presentation['models']['testmodel'] = \
        lambda responses, n, api_key=None: [(f'theme {i}', len(responses)) for i in range(n)]
    sess.current_presentation['available_models'].append('testmodel')


def test_analyze_with_server_model(client):
    session_id = create_session(client)
    _add_test_model(session_id)
    sid = create_survey(client, session_id, question='Q', model='testmodel', num_summaries=2)['survey_id']

    assert client.post(f'{session_prefix(session_id)}/api/survey/{sid}/analyze').status_code == 400

    for text in ('alpha', 'beta', 'gamma'):
        client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': text})

    resp = client.post(f'{session_prefix(session_id)}/api/survey/{sid}/analyze')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['num_responses'] == 3
    assert len(data['summaries']) == 2
    assert data['summaries'][0] == {'summary': 'theme 0', 'num_respondents': 3}


def test_analyze_rejects_malformed_model_output(client):
    session_id = create_session(client)
    sess = sessions_mod.get_session(session_id)
    sess.current_presentation['models']['badmodel'] = lambda responses, n, **kw: [('only one', 1)]
    sess.current_presentation['available_models'].append('badmodel')
    sid = create_survey(client, session_id, question='Q', model='badmodel', num_summaries=3)['survey_id']
    client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'x'})
    assert client.post(f'{session_prefix(session_id)}/api/survey/{sid}/analyze').status_code == 500


def test_response_text_is_capped_and_coerced(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    long_text = 'x' * (state.MAX_RESPONSE_LENGTH + 500)
    client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': long_text})
    client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': {'not': 'a string'}})
    responses = client.get(f'{session_prefix(session_id)}/api/survey/{sid}/responses').get_json()['responses']
    assert len(responses[0]['text']) == state.MAX_RESPONSE_LENGTH
    assert isinstance(responses[1]['text'], str)


def test_negative_after_param_does_not_slice_from_end(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    for text in ('a', 'b', 'c'):
        client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': text})
    data = client.get(f'{session_prefix(session_id)}/api/survey/{sid}/responses?after=-2').get_json()
    assert len(data['responses']) == 3


def test_create_survey_validates_payload(client):
    session_id = create_session(client)
    resp = client.post(f'{session_prefix(session_id)}/api/survey/create', json={'question': 'Q', 'options': 'not-a-list'})
    assert resp.status_code == 400
    sid = create_survey(client, session_id, question='Q', num_summaries=9999)['survey_id']
    assert sessions_mod.get_session(session_id).surveys[sid]['num_summaries'] <= 20
    sid = create_survey(client, session_id, question='Q', num_summaries='garbage')['survey_id']
    assert sessions_mod.get_session(session_id).surveys[sid]['num_summaries'] == 3


# ── Embeddability check ────────────────────────────────────────────────────────


# ── Security: presenter-only routes, audience limits ─────────────────────────────

def test_presenter_page_needs_the_presenter_cookie(client, audience):
    session_id = create_session(client)
    assert client.get(f'/s/{session_id}/').status_code == 200
    resp = audience.get(f'/s/{session_id}/')
    assert resp.status_code == 403
    assert b'BEAMER_SESSION_ID' not in resp.data


def test_presenter_cookie_is_httponly(client):
    resp = client.post('/api/session/create')
    cookie = resp.headers['Set-Cookie']
    assert 'HttpOnly' in cookie and 'SameSite=Lax' in cookie
    token = sessions_mod.get_session(resp.get_json()['session_id']).presenter_token
    assert token not in resp.get_data(as_text=True)


def test_audience_cannot_use_presenter_routes(client, audience):
    session_id = create_session(client)
    upload_zip(client, session_id)
    sid = create_survey(client, session_id, question='Q', model='claude')['survey_id']
    pre = session_prefix(session_id)
    blocked = [
        ('post', f'{pre}/upload', dict(data={'file': (make_presentation_zip(), 'x.zip')}, content_type='multipart/form-data')),
        ('post', f'{pre}/api/upload-asset', dict(data={'file': (io.BytesIO(b'x'), 'x.html')}, content_type='multipart/form-data')),
        ('get', f'{pre}/api/zip-asset/assets/note.txt', {}),
        ('get', f'{pre}/api/zip-asset/config/s0.json', {}),
        ('get', f'{pre}/api/models', {}),
        ('post', f'{pre}/api/survey/create', dict(json={'question': 'hijack'})),
        ('get', f'{pre}/api/survey/{sid}/responses', {}),
        ('post', f'{pre}/api/survey/{sid}/analyze', {}),
        ('post', f'{pre}/api/survey/{sid}/close', {}),
        ('post', f'{pre}/api/ping', {}),
        ('post', f'{pre}/api/close', {}),
    ]
    for method, url, kw in blocked:
        assert getattr(audience, method)(url, **kw).status_code == 403, url
    sess = sessions_mod.get_session(session_id)
    assert sess.surveys[sid]['active'] is True
    assert len(sess.surveys) == 1


def test_audience_can_answer(client, audience):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    assert audience.get(f'/s/{session_id}/survey/{sid}').status_code == 200
    assert audience.get(f'{session_prefix(session_id)}/api/survey/{sid}').status_code == 200
    resp = audience.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'hi'})
    assert resp.status_code == 200


def test_presenter_posts_must_come_from_this_server(client):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    close = f'{session_prefix(session_id)}/api/survey/{sid}/close'
    # Another host on the same site gets the Lax cookie sent, but not its Origin past us.
    assert client.post(close, headers={'Origin': 'https://student.utoronto.ca'}).status_code == 403
    assert client.post(close, headers={'Sec-Fetch-Site': 'same-site'}).status_code == 403
    assert sessions_mod.get_session(session_id).surveys[sid]['active'] is True
    assert client.post(close, headers={'Origin': 'http://localhost', 'Sec-Fetch-Site': 'same-origin'}).status_code == 200


def test_heartbeat_keeps_the_session(client):
    session_id = create_session(client)
    upload_zip(client, session_id)
    sess = sessions_mod.get_session(session_id)
    sess.last_seen -= 3600
    resp = client.post(f'/s/{session_id}/api/ping')
    assert resp.status_code == 200 and 'bp_presenter_' in resp.headers['Set-Cookie']
    assert time.time() - sess.last_seen < 5


def test_sessions_without_a_deck_expire_sooner(client):
    session_id = create_session(client)
    sessions_mod.expire_idle_sessions(time.time() + sessions_mod.EMPTY_SESSION_MINUTES * 60 + 60)
    assert sessions_mod.get_session(session_id) is None


def test_live_sessions_per_address_are_capped(client, monkeypatch):
    monkeypatch.setattr(sessions_mod, 'MAX_LIVE_SESSIONS_PER_IP', 1)
    monkeypatch.setattr(sessions_mod, '_sessions', {})
    assert client.post('/api/session/create').status_code == 200
    assert client.post('/api/session/create').status_code == 429


def test_fill_template_hides_the_answer_key(client, audience):
    session_id = create_session(client)
    tpl = 'x = BLANK(True ^ *False) and BLANK(*a | b | *c)'
    sid = create_survey(client, session_id, question='Q', kind='fill', meta={'template': tpl})['survey_id']
    meta = audience.get(f'{session_prefix(session_id)}/api/survey/{sid}').get_json()['meta']
    assert meta['template'] == 'x = BLANK(True ^ False) and BLANK(a | b | c)'
    # The server keeps the marked copy (the presenter's widget has its own).
    assert sessions_mod.get_session(session_id).surveys[sid]['meta']['template'] == tpl


def test_large_zip_entries_are_streamed(client):
    session_id = create_session(client)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('slides.pdf', b'%PDF-1.4 fake')
        zf.writestr('video/big.bin', b'\0' * (3 * 1024 * 1024))
    buf.seek(0)
    client.post(f'/s/{session_id}/upload', data={'file': (buf, 'd.zip')}, content_type='multipart/form-data')
    resp = client.get(f'{session_prefix(session_id)}/api/zip-asset/video/big.bin')
    assert resp.is_streamed and resp.headers['Content-Length'] == str(3 * 1024 * 1024)
    assert len(resp.get_data()) == 3 * 1024 * 1024


def test_close_session_removes_it_and_its_deck(client):
    session_id = create_session(client)
    upload_zip(client, session_id)
    folder = os.path.join(sessions_mod.UPLOAD_FOLDER, session_id)
    assert os.path.isdir(folder)
    assert client.post(f'/s/{session_id}/api/close').status_code == 200
    assert sessions_mod.get_session(session_id) is None
    assert not os.path.exists(folder)
    assert client.get(f'/s/{session_id}/').status_code == 404


def test_idle_sessions_expire(client):
    session_id = create_session(client)
    upload_zip(client, session_id)
    sessions_mod.expire_idle_sessions(time.time() + sessions_mod.SESSION_IDLE_HOURS * 3600 + 60)
    assert sessions_mod.get_session(session_id) is None
    assert not os.path.exists(os.path.join(sessions_mod.UPLOAD_FOLDER, session_id))


def test_orphaned_upload_folders_are_cleared(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions_mod, 'UPLOAD_FOLDER', str(tmp_path))
    (tmp_path / 'ABCDEF').mkdir()
    (tmp_path / 'GHJKLM').mkdir()          # fresh: maybe another server's live session
    (tmp_path / '_keep_me').mkdir()
    (tmp_path / 'notes.txt').write_text('x')
    old = time.time() - sessions_mod.SESSION_IDLE_HOURS * 3600 - 60
    for name in ('ABCDEF', '_keep_me'):
        os.utime(tmp_path / name, (old, old))
    sessions_mod.clear_orphaned_uploads()
    assert not (tmp_path / 'ABCDEF').exists()
    assert (tmp_path / 'GHJKLM').exists()
    assert (tmp_path / '_keep_me').exists() and (tmp_path / 'notes.txt').exists()


def test_importing_the_server_deletes_nothing():
    import server
    assert 'clear_orphaned_uploads()' not in open(server.__file__).read()


def test_session_creation_is_rate_limited(client, monkeypatch):
    monkeypatch.setattr(sessions_mod, 'MAX_SESSIONS_PER_IP_PER_HOUR', 2)
    assert client.post('/api/session/create').status_code == 200
    assert client.post('/api/session/create').status_code == 200
    assert client.post('/api/session/create').status_code == 429


def test_session_count_is_capped(client, monkeypatch):
    monkeypatch.setattr(sessions_mod, 'MAX_SESSIONS', len(sessions_mod._sessions))
    assert client.post('/api/session/create').status_code == 429


@pytest.mark.real_voters
def test_one_answer_per_phone(client, audience):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    audience.get(f'/s/{session_id}/survey/{sid}')            # sets the voter cookie
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'
    assert audience.post(url, json={'response': 'one'}).status_code == 200
    assert audience.post(url, json={'response': 'two'}).status_code == 409
    other = flask_app.test_client()                          # never opened the page
    assert other.post(url, json={'response': 'three'}).status_code == 200
    assert other.post(url, json={'response': 'four'}).status_code == 409
    # A new question can be answered again.
    sid2 = create_survey(client, session_id, question='Q2')['survey_id']
    assert audience.post(f'{session_prefix(session_id)}/api/survey/{sid2}/respond',
                         json={'response': 'again'}).status_code == 200
    responses = client.get(f'{session_prefix(session_id)}/api/survey/{sid}/responses').get_json()['responses']
    assert [r['text'] for r in responses] == ['one', 'three']


@pytest.mark.real_voters
def test_optional_per_address_cap(client, monkeypatch):
    monkeypatch.setenv('BEAMER_MAX_RESPONSES_PER_IP', '2')
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    url = f'{session_prefix(session_id)}/api/survey/{sid}/respond'
    codes = []
    for _ in range(3):
        phone = flask_app.test_client()
        codes.append(phone.post(url, json={'response': 'x'}).status_code)
    assert codes == [200, 200, 429]


def test_deck_files_cannot_run_as_pages(client):
    session_id = create_session(client)
    pre = session_prefix(session_id)
    path = client.post(f'{pre}/api/upload-asset', data={
        'file': (io.BytesIO(b'<script>alert(1)</script>'), 'evil.html'),
    }, content_type='multipart/form-data').get_json()['path']
    resp = client.get(f'{pre}/api/zip-asset/{path}')
    assert resp.headers['Content-Security-Policy'] == 'sandbox'
    assert resp.headers['X-Content-Type-Options'] == 'nosniff'
    assert 'Access-Control-Allow-Origin' not in resp.headers
    upload_zip(client, session_id)
    resp = client.get(f'{pre}/api/zip-asset/assets/note.txt')
    assert resp.headers['Content-Security-Policy'] == 'sandbox'


def test_upload_asset_paths_are_cleaned(client):
    session_id = create_session(client)
    data = client.post(f'{session_prefix(session_id)}/api/upload-asset', data={
        'file': (io.BytesIO(b'x'), '../../etc/passwd'), 'folder': '../../secret',
    }, content_type='multipart/form-data').get_json()
    assert '..' not in data['path'] and not data['path'].startswith('/')


def test_temp_assets_have_a_budget(client, monkeypatch):
    import server.presentation as presentation_mod
    monkeypatch.setattr(presentation_mod, 'MAX_TEMP_ASSETS_MB', 1 / 1024)   # 1 KB
    session_id = create_session(client)
    url = f'{session_prefix(session_id)}/api/upload-asset'
    ok = client.post(url, data={'file': (io.BytesIO(b'x' * 600), 'a.bin')}, content_type='multipart/form-data')
    assert ok.status_code == 200
    big = client.post(url, data={'file': (io.BytesIO(b'x' * 600), 'b.bin')}, content_type='multipart/form-data')
    assert big.status_code == 413


def test_request_size_is_limited():
    assert flask_app.config['MAX_CONTENT_LENGTH'] and flask_app.config['MAX_CONTENT_LENGTH'] > 0


def test_survey_answers_reach_only_the_presenter_socket(client, audience):
    session_id = create_session(client)
    sid = create_survey(client, session_id, question='Q')['survey_id']
    presenter = socketio.test_client(flask_app, flask_test_client=client)
    student = socketio.test_client(flask_app, flask_test_client=audience)
    snoop = socketio.test_client(flask_app, flask_test_client=audience)
    presenter.emit('join_presenter', {'session_id': session_id})
    student.emit('join_survey', {'session_id': session_id, 'survey_id': sid})
    snoop.emit('join_presenter', {'session_id': session_id})      # no presenter cookie
    for c in (presenter, student, snoop):
        c.get_received()
    audience.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'secret'})
    assert any(m['name'] == 'survey_response' for m in presenter.get_received())
    assert not any(m['name'] == 'survey_response' for m in student.get_received())
    assert not any(m['name'] == 'survey_response' for m in snoop.get_received())
    client.post(f'{session_prefix(session_id)}/api/survey/{sid}/close')
    assert any(m['name'] == 'survey_closed' for m in student.get_received())


def test_socket_origin_check():
    from server.core import _origin_allowed
    env = {'HTTP_HOST': '192.168.1.5:5001', 'wsgi.url_scheme': 'https'}
    assert _origin_allowed('https://192.168.1.5:5001', env)
    assert _origin_allowed(None, env)
    assert not _origin_allowed('https://evil.example', env)
    assert not _origin_allowed('null', env)


def test_analyze_hides_unexpected_errors(client):
    session_id = create_session(client)
    sess = sessions_mod.get_session(session_id)

    def boom(responses, n, api_key=None):
        raise ValueError('/home/secret/path leaked')
    sess.current_presentation['models']['boom'] = boom
    sess.current_presentation['available_models'].append('boom')
    sid = create_survey(client, session_id, question='Q', model='boom')['survey_id']
    client.post(f'{session_prefix(session_id)}/api/survey/{sid}/respond', json={'response': 'x'})
    resp = client.post(f'{session_prefix(session_id)}/api/survey/{sid}/analyze')
    assert resp.status_code == 500 and 'secret' not in resp.get_data(as_text=True)
