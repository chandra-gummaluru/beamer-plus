"""Survey API: creation, audience responses, and AI summarization (per session)."""
import inspect
import time
import traceback
import uuid

from flask import Blueprint, jsonify, request

from . import state
from .core import socketio
from .sessions import get_session_or_404, presenter_room, survey_room

surveys_bp = Blueprint('surveys', __name__)

# What the audience is asked to give. Decides which response page they get
# and what that page asks for; the server stores every answer as text either way.
SURVEY_KINDS = {'open', 'choice', 'truefalse', 'rating', 'numeric', 'wordcloud'}


def _clean_meta(meta):
    """Small, flat, public display hints for the response page (scale ends, a unit)."""
    if not isinstance(meta, dict):
        return {}
    out = {}
    for k, v in list(meta.items())[:12]:
        if isinstance(k, str) and isinstance(v, (str, int, float, bool)) or v is None:
            out[str(k)[:40]] = v[:120] if isinstance(v, str) else v
    return out


@surveys_bp.route('/s/<session_id>/api/survey/create', methods=['POST'])
def create_survey(session_id):
    sess = get_session_or_404(session_id)
    data = request.json
    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid request body'}), 400
    survey_id = str(uuid.uuid4())[:8]
    model_name = data.get('model')
    if model_name and model_name not in sess.current_presentation.get('models', {}):
        return jsonify({'error': f'Model "{model_name}" not found'}), 400
    try:
        num_summaries = max(1, min(20, int(data.get('num_summaries', 3))))
    except (TypeError, ValueError):
        num_summaries = 3
    options = data.get('options')
    if options is not None:
        if not isinstance(options, list) or not all(isinstance(o, str) for o in options):
            return jsonify({'error': 'options must be a list of strings'}), 400
    is_wordcloud = bool(data.get('is_wordcloud', False))
    kind = data.get('kind')
    if kind not in SURVEY_KINDS:
        kind = 'choice' if options else ('wordcloud' if is_wordcloud else 'open')
    sess.surveys[survey_id] = {
        'question': str(data.get('question', 'What do you think?')),
        'created_at': time.time(),
        'active': True,
        'model': model_name,
        'api_key': data.get('api_key') or None,
        'num_summaries': num_summaries,
        'options': options,
        'kind': kind,
        'meta': _clean_meta(data.get('meta')),
    }
    if options and kind in ('choice', 'truefalse'):
        url = f'/s/{session_id}/mcq/{survey_id}'
    elif kind == 'wordcloud':
        url = f'/s/{session_id}/wordcloud/{survey_id}'
    else:
        url = f'/s/{session_id}/survey/{survey_id}'
    return jsonify({
        'survey_id': survey_id,
        'url': url,
    })


@surveys_bp.route('/s/<session_id>/api/survey/<survey_id>')
def get_survey(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return jsonify({'error': 'Survey not found'}), 404
    s = sess.surveys[survey_id]
    return jsonify({
        'survey_id': survey_id,
        'question': s.get('question'),
        'options': s.get('options'),
        'kind': s.get('kind', 'open'),
        'meta': s.get('meta', {}),
        'active': s.get('active', False),
    })


@surveys_bp.route('/s/<session_id>/api/survey/<survey_id>/respond', methods=['POST'])
def respond_survey(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return jsonify({'error': 'Survey not found'}), 404
    if not sess.surveys[survey_id]['active']:
        return jsonify({'error': 'Survey is closed'}), 403
    if len(sess.survey_responses[survey_id]) >= state.MAX_RESPONSES_PER_SURVEY:
        return jsonify({'error': 'Response limit reached'}), 429
    data = request.json
    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid request body'}), 400
    text = data.get('response', '')
    if not isinstance(text, str):
        text = str(text)
    response = {'text': text[:state.MAX_RESPONSE_LENGTH], 'timestamp': time.time()}
    sess.survey_responses[survey_id].append(response)
    payload = {'survey_id': survey_id, 'response': response, 'total': len(sess.survey_responses[survey_id])}
    socketio.emit('survey_response', payload, room=presenter_room(session_id))
    socketio.emit('survey_response', payload, room=survey_room(session_id, survey_id))
    return jsonify({'success': True})


@surveys_bp.route('/s/<session_id>/api/survey/<survey_id>/responses')
def get_responses(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return jsonify({'error': 'Survey not found'}), 404
    try:
        after = max(0, int(request.args.get('after', 0)))
    except ValueError:
        after = 0
    all_responses = sess.survey_responses[survey_id]
    return jsonify({'responses': all_responses[after:], 'total': len(all_responses)})


@surveys_bp.route('/s/<session_id>/api/survey/<survey_id>/analyze', methods=['POST'])
def analyze_survey(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id not in sess.surveys:
        return jsonify({'error': 'Survey not found'}), 404
    survey = sess.surveys[survey_id]
    responses = sess.survey_responses[survey_id]
    if not responses:
        return jsonify({'error': 'No responses to analyze'}), 400
    model_name = survey.get('model')
    if not model_name:
        return jsonify({'error': 'No model specified'}), 400
    model_func = sess.current_presentation.get('models', {}).get(model_name)
    if not model_func:
        return jsonify({'error': f'Model "{model_name}" not loaded'}), 404
    try:
        num_summaries = survey.get('num_summaries', 3)
        api_key = survey.get('api_key')
        call_kwargs = {'api_key': api_key} if api_key and 'api_key' in inspect.signature(model_func).parameters else {}
        summaries = model_func([r['text'] for r in responses], num_summaries, **call_kwargs)
        if not isinstance(summaries, list) or len(summaries) != num_summaries:
            return jsonify({'error': f'Model must return a list of {num_summaries} summaries'}), 500
        for i, item in enumerate(summaries):
            if not isinstance(item, tuple) or len(item) != 2 or not isinstance(item[0], str) or not isinstance(item[1], int):
                return jsonify({'error': f'Summary {i} must be a (str, int) tuple'}), 500
        return jsonify({
            'summaries': [{'summary': s[0], 'num_respondents': s[1]} for s in summaries],
            'model': model_name,
            'num_responses': len(responses),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@surveys_bp.route('/s/<session_id>/api/survey/<survey_id>/close', methods=['POST'])
def close_survey(session_id, survey_id):
    sess = get_session_or_404(session_id)
    if survey_id in sess.surveys:
        sess.surveys[survey_id]['active'] = False
        socketio.emit('survey_closed', {'survey_id': survey_id}, room=survey_room(session_id, survey_id))
    return jsonify({'success': True})
