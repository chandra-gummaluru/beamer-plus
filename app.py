from flask import Flask, render_template, jsonify, request, send_file
from flask_socketio import SocketIO, emit, join_room, leave_room
import uuid
import time
import os
from collections import defaultdict

app = Flask(__name__, static_folder='static', template_folder='')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# Store active surveys and responses
surveys = {}
survey_responses = defaultdict(list)

# Store current presentation
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
current_presentation = {'file': None, 'config': None}

@app.route('/')
def index():
    return render_template('index.html')

@app.route("/viewer")
def viewer():
    return render_template("viewer.html")

@app.route("/survey/<survey_id>")
def survey_page(survey_id):
    if survey_id not in surveys:
        return render_template("survey_not_found.html"), 404
    return render_template("survey_response.html", survey_id=survey_id)

# Presentation endpoints
@app.route('/api/presentation/upload', methods=['POST'])
def upload_presentation():
    global current_presentation
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    
    file = request.files['file']
    filepath = os.path.join(UPLOAD_FOLDER, 'current.zip')
    file.save(filepath)
    current_presentation['file'] = filepath
    
    return jsonify({'success': True})

@app.route('/api/presentation/current')
def get_current_presentation():
    if current_presentation['file'] and os.path.exists(current_presentation['file']):
        return send_file(current_presentation['file'], as_attachment=True, download_name='presentation.zip')
    return jsonify({'error': 'No presentation loaded'}), 404

# API endpoints for surveys
@app.route('/api/survey/create', methods=['POST'])
def create_survey():
    data = request.json
    survey_id = str(uuid.uuid4())[:8]
    surveys[survey_id] = {
        'question': data.get('question', 'What do you think?'),
        'created_at': time.time(),
        'active': True
    }
    return jsonify({'survey_id': survey_id, 'url': f'/survey/{survey_id}'})

@app.route('/api/survey/<survey_id>')
def get_survey(survey_id):
    if survey_id not in surveys:
        return jsonify({'error': 'Survey not found'}), 404
    return jsonify(surveys[survey_id])

@app.route('/api/survey/<survey_id>/respond', methods=['POST'])
def respond_survey(survey_id):
    if survey_id not in surveys:
        return jsonify({'error': 'Survey not found'}), 404
    
    if not surveys[survey_id]['active']:
        return jsonify({'error': 'Survey is closed'}), 403
    
    data = request.json
    response = {
        'text': data.get('response', ''),
        'timestamp': time.time()
    }
    survey_responses[survey_id].append(response)
    
    # Notify presenter of new response
    socketio.emit('survey_response', {
        'survey_id': survey_id,
        'response': response,
        'total': len(survey_responses[survey_id])
    }, room='presenter')
    
    return jsonify({'success': True})

@app.route('/api/survey/<survey_id>/responses')
def get_responses(survey_id):
    if survey_id not in surveys:
        return jsonify({'error': 'Survey not found'}), 404
    return jsonify({
        'responses': survey_responses[survey_id],
        'total': len(survey_responses[survey_id])
    })

@app.route('/api/survey/<survey_id>/close', methods=['POST'])
def close_survey(survey_id):
    if survey_id in surveys:
        surveys[survey_id]['active'] = False
        # Notify all users on the survey page that it's closed
        socketio.emit('survey_closed', {'survey_id': survey_id}, room=f'survey_{survey_id}')
    return jsonify({'success': True})

# Socket.IO events
@socketio.on('join_presenter')
def join_presenter():
    join_room('presenter')
    emit('joined', {'room': 'presenter'})

@socketio.on('join_viewer')
def join_viewer():
    join_room('viewer')
    emit('joined', {'room': 'viewer'})

@socketio.on('join_survey')
def join_survey(data):
    survey_id = data.get('survey_id')
    if survey_id:
        join_room(f'survey_{survey_id}')
        emit('joined', {'room': f'survey_{survey_id}'})

@socketio.on("presentation_loaded")
def handle_presentation_loaded(data):
    # Broadcast to all viewers that they should load the presentation
    emit("presentation_loaded", data, room='viewer')

@socketio.on("slide_change")
def handle_slide_change(data):
    # Broadcast to all viewers
    emit("slide_change", data, room='viewer')

@socketio.on("annotation_update")
def handle_annotation_update(data):
    # Broadcast to all viewers
    emit("annotation_update", data, room='viewer')

@socketio.on("clear_annotations")
def handle_clear_annotations():
    emit("clear_annotations", room='viewer')

@socketio.on("video_action")
def handle_video_action(data):
    # Broadcast video play/pause to all viewers
    emit("video_action", data, room='viewer')

@socketio.on("model_interaction")
def handle_model_interaction(data):
    # Broadcast 3D model interactions to all viewers
    emit("model_interaction", data, room='viewer')

@socketio.on("survey_show")
def handle_survey_show(data):
    # Broadcast to all viewers
    emit("survey_show", data, room='viewer')

@socketio.on("survey_close")
def handle_survey_close(data=None):
    # Broadcast to all viewers
    emit("survey_close", room='viewer')
    
    # Also close the survey and notify respondents
    if data and 'survey_id' in data:
        survey_id = data['survey_id']
        if survey_id in surveys:
            surveys[survey_id]['active'] = False
            # Notify all users on the survey response page
            emit('survey_closed', {'survey_id': survey_id}, room=f'survey_{survey_id}')

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)