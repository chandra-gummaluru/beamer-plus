from flask import Flask, abort, render_template, send_from_directory, jsonify, request, redirect, url_for
from flask_socketio import SocketIO, emit
import socket
import os, zipfile
import logging

app = Flask(__name__, static_folder='static', template_folder='')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet') 

@app.route('/')
def index():
    return render_template('index.html')

@app.route("/viewer")
def viewer():
    return render_template("viewer.html")

# Presenter changed slide → broadcast
@socketio.on("slide_event")
def handle_slide_changed(slide_index):
    emit("slide_event", slide_index, broadcast=True, include_self=False)


# Presenter drew or erased → broadcast
@socketio.on("ann_event")
def handle_annotation_event(event):
    emit("ann_event", event, broadcast=True, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001, debug=True)