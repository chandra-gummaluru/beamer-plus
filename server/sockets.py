"""Socket.IO event handlers — rooms scoped per presenter session."""
from flask_socketio import join_room

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
