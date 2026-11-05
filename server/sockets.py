"""Socket.IO event handlers — rooms scoped per presenter session."""
from flask_socketio import join_room

from .core import socketio
from .sessions import get_session, is_presenter, presenter_room, session_room, survey_room


@socketio.on('join_presenter')
def join_presenter(data=None):
    # The presenter room carries every answer as it comes in, so it needs the
    # presenter cookie (sent with the socket's handshake), not just the code.
    data = data if isinstance(data, dict) else {}
    session_id = data.get('session_id')
    if not isinstance(session_id, str) or not get_session(session_id):
        return
    if not is_presenter(session_id):
        return
    join_room(session_room(session_id))
    join_room(presenter_room(session_id))


@socketio.on('join_survey')
def join_survey(data):
    # Audience phones: told when the question closes, nothing more.
    if not isinstance(data, dict):
        return
    session_id = data.get('session_id')
    survey_id = data.get('survey_id')
    if not isinstance(session_id, str) or not isinstance(survey_id, str):
        return
    sess = get_session(session_id)
    if not sess or survey_id not in sess.surveys:
        return
    join_room(survey_room(session_id, survey_id))
