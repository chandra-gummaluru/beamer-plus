from flask import Flask, render_template, jsonify, request, send_file
from flask_socketio import SocketIO, emit, join_room, leave_room
import uuid
import time
import os
import importlib.util
import sys
import tempfile
import zipfile
from collections import defaultdict
from typing import List
import shutil

# Get the correct base path for PyInstaller
def get_base_path():
    """Get the base path for resources, works with PyInstaller"""
    if getattr(sys, 'frozen', False):
        # Running as compiled executable
        return sys._MEIPASS
    else:
        # Running as normal Python script
        return os.path.dirname(os.path.abspath(__file__))

BASE_PATH = get_base_path()

app = Flask("Beamer+", 
            static_folder=os.path.join(BASE_PATH, 'static'), 
            template_folder=BASE_PATH)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# Store active surveys and responses
surveys = {}
survey_responses = defaultdict(list)

# Store current presentation
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

current_presentation = {
    'file': None,
    'config': None,
    'models': {},  # Store loaded model functions
    'available_models': []  # List of available model names
}

presentation_state = {
    "presentation_loaded": None,   # Last payload broadcast in presentation_loaded
    "current_slide": 0,
    "annotations": {},             # Store annotationData or list of strokes
    "video": {},                   # Store video status per slide
    "models": {},                  # Store 3d camera state per slide
    "active_survey": None,         # payload broadcast in survey_show
}

def extract_and_load_models(zip_path):
    """
    Extract AI models from the uploaded ZIP file and load them.
    Models should be in the 'ai/' directory within the ZIP.
    """
    models = {}
    available_models = []
    
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            # Find all .py files in the ai/ directory
            ai_files = [f for f in zip_ref.namelist() if f.startswith('ai/') and f.endswith('.py')]
            
            if not ai_files:
                print("No AI models found in ZIP file")
                return models, available_models
            
            # Create a temporary directory to extract models
            temp_dir = tempfile.mkdtemp()
            
            for ai_file in ai_files:
                try:
                    # Extract the file
                    zip_ref.extract(ai_file, temp_dir)
                    
                    # Get model name from filename
                    model_name = os.path.splitext(os.path.basename(ai_file))[0]
                    
                    # Skip __init__.py and other special files
                    if model_name.startswith('_'):
                        continue
                    
                    # Full path to the extracted file
                    model_path = os.path.join(temp_dir, ai_file)
                    
                    # Load the model function
                    spec = importlib.util.spec_from_file_location(model_name, model_path)
                    module = importlib.util.module_from_spec(spec)
                    
                    # Add to sys.modules with unique name
                    unique_name = f"ai_model_{model_name}_{int(time.time())}"
                    sys.modules[unique_name] = module
                    spec.loader.exec_module(module)
                    
                    # Check if the summarize function exists
                    if hasattr(module, 'summarize'):
                        models[model_name] = getattr(module, 'summarize')
                        available_models.append(model_name)
                        print(f"Loaded model: {model_name}")
                    else:
                        print(f"Warning: {ai_file} does not define a 'summarize' function")
                
                except Exception as e:
                    print(f"Error loading model {ai_file}: {str(e)}")
            
            # Don't delete temp_dir immediately - keep it for the session
            # We could implement cleanup on server shutdown if needed
    
    except Exception as e:
        print(f"Error extracting models from ZIP: {str(e)}")
    
    return models, available_models

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
    
    # Extract and load AI models from the ZIP
    models, available_models = extract_and_load_models(filepath)
    
    current_presentation['file'] = filepath
    current_presentation['models'] = models
    current_presentation['available_models'] = available_models
    
    print(f"Presentation uploaded with {len(available_models)} AI models")
    
    return jsonify({
        'success': True,
        'models_found': len(available_models),
        'models': available_models
    })

@app.route('/api/presentation/current')
def get_current_presentation():
    if current_presentation['file'] and os.path.exists(current_presentation['file']):
        return send_file(current_presentation['file'], as_attachment=True, download_name='presentation.zip')
    return jsonify({'error': 'No presentation loaded'}), 404

# Model endpoints
@app.route('/api/models')
def get_models():
    """Get list of available AI models from the current presentation"""
    return jsonify({
        'models': current_presentation.get('available_models', [])
    })

# API endpoints for surveys
@app.route('/api/survey/create', methods=['POST'])
def create_survey():
    data = request.json
    survey_id = str(uuid.uuid4())[:8]
    
    model_name = data.get('model', None)
    
    # Validate that the model exists
    if model_name and model_name not in current_presentation.get('models', {}):
        return jsonify({
            'error': f'Model "{model_name}" not found in current presentation'
        }), 400
    
    surveys[survey_id] = {
        'question': data.get('question', 'What do you think?'),
        'created_at': time.time(),
        'active': True,
        'model': model_name,
        'num_summaries': data.get('num_summaries', 3)
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

@app.route('/api/survey/<survey_id>/analyze', methods=['POST'])
def analyze_survey(survey_id):
    """
    Analyze survey responses using the specified model from the presentation ZIP.
    """
    if survey_id not in surveys:
        return jsonify({'error': 'Survey not found'}), 404
    
    survey = surveys[survey_id]
    responses = survey_responses[survey_id]
    
    if len(responses) == 0:
        return jsonify({'error': 'No responses to analyze'}), 400
    
    model_name = survey.get('model')
    num_summaries = survey.get('num_summaries', 3)
    
    if not model_name:
        return jsonify({'error': 'No model specified for this survey'}), 400
    
    # Get the model function from loaded models
    model_func = current_presentation.get('models', {}).get(model_name)
    
    if not model_func:
        return jsonify({'error': f'Model "{model_name}" not loaded'}), 404
    
    try:
        # Extract response texts
        response_texts = [r['text'] for r in responses]
        
        # Call the summarize function
        summaries = model_func(response_texts, num_summaries)
        
        # Validate the output
        if not isinstance(summaries, list):
            return jsonify({'error': 'Model must return a list of summaries'}), 500
        
        if len(summaries) != num_summaries:
            return jsonify({
                'error': f'Model returned {len(summaries)} summaries, expected {num_summaries}'
            }), 500
        
        # Validate tuple format: (summary, num_respondents)
        for i, item in enumerate(summaries):
            if not isinstance(item, tuple) or len(item) != 2:
                return jsonify({
                    'error': f'Summary {i} must be a tuple of (summary, num_respondents)'
                }), 500
            if not isinstance(item[0], str) or not isinstance(item[1], int):
                return jsonify({
                    'error': f'Summary {i} has invalid types: expected (str, int)'
                }), 500
        
        # Convert tuples to dicts for JSON
        summaries_json = [
            {
                'summary': s[0],
                'num_respondents': s[1]
            }
            for s in summaries
        ]
        
        return jsonify({
            'summaries': summaries_json,
            'model': model_name,
            'num_responses': len(responses)
        })
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Error analyzing responses: {str(e)}'}), 500

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
    emit("state_sync", {
        "presentation_loaded": presentation_state["presentation_loaded"],
        "current_slide": presentation_state["current_slide"],
        "annotations": presentation_state["annotations"],
        "active_survey": presentation_state["active_survey"],
        # later: "video": ..., "models": ..., "widgets": ...
    })

@socketio.on('join_survey')
def join_survey(data):
    survey_id = data.get('survey_id')
    if survey_id:
        join_room(f'survey_{survey_id}')
        emit('joined', {'room': f'survey_{survey_id}'})

@socketio.on("presentation_loaded")
def handle_presentation_loaded(data):
    # Broadcast to all viewers that they should load the presentation
    presentation_state["presentation_loaded"] = data
    emit("presentation_loaded", data, room='viewer')

@socketio.on("slide_change")
def handle_slide_change(data):
    # Broadcast to all viewers
    presentation_state["current_slide"] = data.get("slide", 0)
    emit("slide_change", data, room='viewer')

@socketio.on("annotation_update")
def handle_annotation_update(data):
    # Broadcast to all viewers
    slide = data.get("slide", presentation_state["current_slide"])
    presentation_state["annotations"][slide] = data.get("annotation", data)
    emit("annotation_update", data, room='viewer')

@socketio.on("clear_annotations")
def handle_clear_annotations(data=None):
    slide = None
    if data and "slide" in data:
        slide = data["slide"]
    else:
        slide = presentation_state["current_slide"]

    presentation_state["annotations"].pop(slide, None)
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
    presentation_state["active_survey"] = data
    emit("survey_show", data, room='viewer')

@socketio.on("survey_close")
def handle_survey_close(data=None):
    # Broadcast to all viewers
    presentation_state["active_survey"] = None
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