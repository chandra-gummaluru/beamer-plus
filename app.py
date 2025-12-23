from flask import Flask, abort, render_template, send_from_directory, jsonify, request, redirect, url_for
from flask_socketio import SocketIO, emit
import socket
import os, zipfile
import logging
from llama_cpp import Llama
from models.llm import summarize, respond_to_user_query

app = Flask(__name__, static_folder='static', template_folder='')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet', ping_timeout=120) 

@app.route('/')
def index():
    return render_template('index.html')  # the regular home-page
    # return render_template('test_llm.html')  # the test-llm page


@app.route("/viewer")
def viewer():
    return render_template("viewer.html")

# Presenter changed slide → broadcast
@socketio.on("slide_event")
def handle_slide_changed(slide_index):
    emit("slide_event", slide_index, broadcast=True, include_self=False)


# Test that the LLM is working:
@app.route('/ask', methods=['POST'])
def ask():
    data = request.json
    user_query = data.get("message", "")

    
    answer = respond_to_user_query(user_query)
    return jsonify({"response": answer})


# Presenter drew or erased → broadcast
@socketio.on("ann_event")
def handle_annotation_event(event):
    emit("ann_event", event, broadcast=True, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001, debug=True)