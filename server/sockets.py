"""Socket.IO event handlers — rooms scoped per presenter session."""
from flask_socketio import emit, join_room

from .core import socketio
from .sessions import get_session, session_room


@socketio.on('join_presenter')
def join_presenter(data=None):
    data = data if isinstance(data, dict) else {}
    session_id = data.get('session_id')
    if not session_id or not get_session(session_id):
        return
    join_room(session_room(session_id))
    join_room(f'presenter_{session_id}')


@socketio.on('join_survey')
def join_survey(data):
    if not isinstance(data, dict):
        return
    session_id = data.get('session_id')
    survey_id = data.get('survey_id')
    if not session_id or not survey_id or not get_session(session_id):
        return
    join_room(session_room(session_id))
    join_room(f'survey_{session_id}_{survey_id}')


@socketio.on('widget_state')
def handle_widget_state(data):
    if not isinstance(data, dict):
        return
    widget_id = data.get('widgetId')
    state_payload = data.get('state')
    session_id = data.get('session_id')
    if not widget_id or state_payload is None or not session_id or not get_session(session_id):
        return
    emit(
        'widget_state',
        {'widgetId': widget_id, 'state': state_payload},
        room=session_room(session_id),
        include_self=False,
    )
