// static/viewer.js
import { Canvas } from './canvas.js';

const socket = io();
socket.emit('join_viewer');

// Canvas wrappers
const pdfContainer = document.getElementById("pdf-canvas");
const annContainer = document.getElementById("ann-canvas");

const pdfCvs = new Canvas(pdfContainer, false);
const annCvs = new Canvas(annContainer, false);

let zipFile = null;
let config = null;
let resources = { videos: {}, audio: {}, models: {}, slides: {} };
let currentSlide = 0;

// Debug logging
socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
});

socket.on('joined', (data) => {
    console.log('Joined room:', data);
    
    // Try to load existing presentation on connect
    loadPresentationIfExists();
});

async function loadPresentationIfExists() {
    console.log('Checking for existing presentation...');
    try {
        const response = await fetch('/api/presentation/current');
        if (response.ok) {
            console.log('Found existing presentation, loading...');
            await loadPresentation();
        } else {
            console.log('No presentation loaded yet');
        }
    } catch (error) {
        console.log('No presentation available yet');
    }
}

async function loadPresentation() {
    console.log('Loading presentation...');
    
    try {
        // Fetch the ZIP file from server
        console.log('Fetching ZIP from server...');
        const response = await fetch('/api/presentation/current');
        console.log('Fetch response:', response.ok, response.status);
        if (!response.ok) {
            console.error('Failed to fetch presentation:', response.status);
            return;
        }
        
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        zipFile = await JSZip.loadAsync(arrayBuffer);

        const configFile = zipFile.file("config.json");
        if (!configFile) {
            console.error("No config.json found in ZIP!");
            return;
        }

        const configText = await configFile.async("string");
        config = JSON.parse(configText);
        console.log("Viewer loaded config:", config);

        // Load all resources
        for (const [id, path] of Object.entries(config.resources.videos)) {
            const blob = await zipFile.file(path).async("blob");
            resources.videos[id] = URL.createObjectURL(blob);
        }

        for (const [id, path] of Object.entries(config.resources.audio)) {
            const blob = await zipFile.file(path).async("blob");
            resources.audio[id] = URL.createObjectURL(blob);
        }

        for (const [id, path] of Object.entries(config.resources.models)) {
            const blob = await zipFile.file(path).async("blob");
            resources.models[id] = URL.createObjectURL(blob);
        }

        const pdfFile = zipFile.file("slides.pdf");
        if (pdfFile) {
            const pdfData = await pdfFile.async("arraybuffer");
            const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
            const numPages = pdfDoc.numPages;

            for (let i = 1; i <= numPages; i++) {
                const page = await pdfDoc.getPage(i);
                resources.slides[i-1] = page;
            }
        }

        console.log("Viewer resources loaded");
    } catch (error) {
        console.error('Error loading presentation:', error);
    }
}

// Load presentation when notified
socket.on('presentation_loaded', async (data) => {
    console.log('Received presentation_loaded event:', data);
    await loadPresentation();
});

// Slide change
socket.on('slide_change', async (data) => {
    console.log('Received slide_change:', data);
    
    if (!config) {
        console.log('Config not loaded yet, waiting...');
        return;
    }
    
    currentSlide = data.slideIndex;
    await renderSlide(currentSlide);
    
    // Update annotations if provided
    if (data.annotations) {
        const annImg = new Image();
        annImg.onload = () => {
            const ctx = annCvs.canvas.getContext('2d');
            ctx.clearRect(0, 0, annCvs.canvas.width, annCvs.canvas.height);
            ctx.drawImage(annImg, 0, 0, annCvs.canvas.width, annCvs.canvas.height);
        };
        annImg.src = data.annotations;
    }
});

// Annotation updates
socket.on('annotation_update', (data) => {
    if (data.slideIndex !== currentSlide) return;
    
    const ann = data.annotations;
    const annImg = new Image();
    annImg.onload = () => {
        const ctx = annCvs.canvas.getContext('2d');
        ctx.clearRect(0, 0, annCvs.canvas.width, annCvs.canvas.height);
        ctx.drawImage(annImg, 0, 0, annCvs.canvas.width, annCvs.canvas.height);
    };
    annImg.src = ann;
});

socket.on('clear_annotations', () => {
    const ctx = annCvs.canvas.getContext('2d');
    ctx.clearRect(0, 0, annCvs.canvas.width, annCvs.canvas.height);
});

// Video synchronization
socket.on('video_action', (data) => {
    console.log('Received video_action:', data);
    console.log('Current slide:', currentSlide);
    
    if (data.slideIndex !== currentSlide) {
        console.log('Video action for different slide, ignoring');
        return;
    }
    
    const video = pdfContainer.querySelector(`video[data-video-id="${data.videoId}"]`);
    console.log('Found video element?', !!video);
    
    if (video) {
        video.currentTime = data.currentTime;
        if (data.action === 'play') {
            console.log('Playing video');
            video.play().catch(err => console.log('Play failed:', err));
        } else if (data.action === 'pause') {
            console.log('Pausing video');
            video.pause();
        }
    } else {
        console.log('Video element not found for ID:', data.videoId);
    }
});

// 3D model synchronization
socket.on('model_interaction', (data) => {
    if (data.slideIndex !== currentSlide) return;
    
    const model = pdfContainer.querySelector(`model-viewer[data-model-id="${data.modelId}"]`);
    if (model) {
        model.cameraOrbit = `${data.camera.theta}rad ${data.camera.phi}rad ${data.camera.radius}m`;
        model.cameraTarget = `${data.target.x}m ${data.target.y}m ${data.target.z}m`;
    }
});

// Survey modals
socket.on('survey_show', (data) => {
    showViewerSurveyModal(data);
});

socket.on('survey_close', () => {
    const modal = document.querySelector('.modal-overlay');
    if (modal) {
        document.body.removeChild(modal);
    }
});

async function renderSlide(slideIndex) {
    console.log('Viewer renderSlide called:', slideIndex);
    
    if (!resources.slides[slideIndex]) {
        console.log('Slide not loaded yet');
        return;
    }
    
    console.log('Rendering PDF page...');
    await pdfCvs.renderPDFPage(resources.slides[slideIndex]);
    console.log('PDF rendered');

    // Clear previous media elements
    const existingMedia = pdfContainer.querySelectorAll('video, audio, model-viewer');
    existingMedia.forEach(el => el.remove());
    
    console.log('Videos to render:', config.slides[slideIndex].videos.length);
    console.log('Models to render:', config.slides[slideIndex].models.length);

    // Render videos
    config.slides[slideIndex].videos.forEach(v => {
        const videoURL = resources.videos[v.id];
        const video = document.createElement("video");
        video.src = videoURL;
        video.volume = v.volume;
        video.dataset.videoId = v.id;

        video.style.position = "absolute";
        video.style.left = `${v.x * pdfCvs.getDisplayWidth()}px`;
        video.style.top = `${v.y * pdfCvs.getDisplayHeight()}px`;
        video.style.width = `${v.width * pdfCvs.getDisplayWidth()}px`;
        video.style.height = `${v.height * pdfCvs.getDisplayHeight()}px`;
        video.style.objectFit = "contain";
        video.style.zIndex = v.zIndex;
        video.style.pointerEvents = 'none'; // Viewers can't interact

        if (v.playMode === "once") {
            video.autoplay = true;
            video.loop = false;
        }

        if (v.playMode === "loop") {
            video.autoplay = true;
            video.loop = true;
        }

        video.controls = false;
        pdfContainer.appendChild(video);
    });

    // Render 3D models
    config.slides[slideIndex].models.forEach(m => {
        const modelURL = resources.models[m.id];

        const mv = document.createElement("model-viewer");
        mv.src = modelURL;
        mv.alt = m.alt || "3D model";
        mv.dataset.modelId = m.id;
        mv.setAttribute("shadow-intensity", "1");

        mv.style.position = "absolute";
        mv.style.left = `${m.x * pdfCvs.getDisplayWidth()}px`;
        mv.style.top = `${m.y * pdfCvs.getDisplayHeight()}px`;
        mv.style.width = `${m.width * pdfCvs.getDisplayWidth()}px`;
        mv.style.height = `${m.height * pdfCvs.getDisplayHeight()}px`;
        mv.style.zIndex = m.zIndex;
        mv.style.pointerEvents = 'none'; // Viewers can't interact

        pdfContainer.appendChild(mv);
    });

    // Audio
    config.slides[slideIndex].audio.forEach(a => {
        const audioURL = resources.audio[a.id];
        const audio = document.createElement("audio");
        audio.src = audioURL;
        audio.volume = a.volume;
        if (a.playMode === "auto") audio.play();
        pdfContainer.appendChild(audio);
    });
}

function showViewerSurveyModal(surveyData) {
    const existingModal = document.querySelector('.modal-overlay');
    if (existingModal) {
        document.body.removeChild(existingModal);
    }
    
    const surveyUrl = `${window.location.origin}${surveyData.url}`;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>Survey</h2>
            <div class="qr-container">
                <div id="qrcode"></div>
            </div>
            <div class="survey-url">
                <input type="text" readonly value="${surveyUrl}" onclick="this.select()">
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    new QRCode(document.getElementById("qrcode"), {
        text: surveyUrl,
        width: 200,
        height: 200,
        colorDark: "#333333",
        colorLight: "#ffffff"
    });
}