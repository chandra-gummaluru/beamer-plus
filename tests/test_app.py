"""API tests for the Beamer+ Flask server.

Run with: pytest
"""
import io
import zipfile

import pytest

import server.sessions as sessions_mod
import server.state as state
from server import app as flask_app


@pytest.fixture
def client():
    flask_app.config['TESTING'] = True
    with flask_app.test_client() as c:
        yield c


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
    assert b'Start a new session' in resp.data


def test_session_create_and_presenter_page(client):
    session_id = create_session(client)
    resp = client.get(f'/s/{session_id}/')
    assert resp.status_code == 200
    assert session_id.encode() in resp.data
    assert b'BEAMER_SESSION_ID' in resp.data


def test_session_lookup(client):
    session_id = create_session(client)
    resp = client.get(f'/api/session/{session_id}')
    assert resp.status_code == 200
    assert resp.get_json()['session_id'] == session_id
    assert client.get('/api/session/ZZZZZZ').status_code == 404


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


def test_widget_listing_and_serving(client):
    names = client.get('/api/widgets').get_json()
    assert 'timer.html' in names
    assert client.get('/widgets/timer.html').status_code == 200


def test_widget_catalog_lists_every_widget_with_its_schema(client):
    import os
    from server.paths import WIDGETS_DIR
    catalog = client.get('/api/widgets/catalog').get_json()
    on_disk = sorted(f for f in os.listdir(WIDGETS_DIR) if f.lower().endswith('.html'))
    assert [w['file'] for w in catalog] == on_disk
    by_type = {w['type']: w for w in catalog}
    assert by_type['python-ide']['label'] == 'Python IDE'
    assert by_type['python-ide']['category'] == 'Computer Science'
    assert all(w['label'] and w['category'] for w in catalog)


def test_vendored_libraries_served(client):
    for path in (
        '/static/vendor/socket.io.min.js',
        '/static/vendor/jszip.min.js',
        '/static/vendor/pdfjs/pdf.min.mjs',
        '/static/vendor/pdfjs/pdf.worker.min.mjs',
    ):
        assert client.get(path).status_code == 200, path


# ── Upload and ZIP assets ──────────────────────────────────────────────────────

def test_upload_and_current_presentation(client):
    session_id = create_session(client)
    data = upload_zip(client, session_id)
    assert data['success'] is True
    resp = client.get(f'{session_prefix(session_id)}/api/presentation/current')
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
        assert 'slides.pdf' in zf.namelist()


def test_upload_loads_zip_models_alongside_builtins(client):
    session_id = create_session(client)
    data = upload_zip(client, session_id, with_model=True)
    assert 'testmodel' in data['models']
    models = client.get(f'{session_prefix(session_id)}/api/models').get_json()['models']
    assert 'testmodel' in models
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


def test_demo_file_traversal_guard(client):
    assert client.get('/api/demo/slides.pdf').status_code == 200
    resp = client.get('/api/demo/..%2fapp.py')
    assert resp.status_code in (403, 404)
    resp = client.get('/api/demo/..%5capp.py')
    assert resp.status_code in (403, 404)


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
    wc = create_survey(client, session_id, question='One word', is_wordcloud=True)
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
    long_tpl = 'x BLANK ' * 300
    big = create_survey(client, session_id, question='Q', kind='fill', meta={'template': long_tpl})
    meta = client.get(f'{session_prefix(session_id)}/api/survey/{big["survey_id"]}').get_json()['meta']
    assert meta['template'] == long_tpl[:2000]


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


def test_analyze_with_zip_model(client):
    session_id = create_session(client)
    upload_zip(client, session_id, with_model=True)
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
    upload_zip(client, session_id, with_model=True)
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

def test_check_embeddable_rejects_bad_urls(client):
    assert client.get('/api/check-embeddable').status_code == 400
    assert client.get('/api/check-embeddable?url=ftp://x').status_code == 400
    assert client.get('/api/check-embeddable?url=javascript:alert(1)').status_code == 400
