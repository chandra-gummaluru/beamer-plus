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

# Receive PDF from presenter and broadcast to all viewers
@socketio.on("load_pdf")
def handle_load_pdf(data):
    # data = ArrayBuffer from client (bytes)
    emit("load_pdf", data, broadcast=True, include_self=False)


# Presenter changed slide → broadcast
@socketio.on("slide_changed")
def handle_slide_changed(slide_index):
    emit("slide_changed", slide_index, broadcast=True, include_self=False)


# Presenter drew or erased → broadcast
@socketio.on("annotation_event")
def handle_annotation_event(event):
    emit("annotation_event", event, broadcast=True, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)