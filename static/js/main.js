import { Timer } from './timer.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Selector } from './selector.js';
import { Toggle } from './toggle.js';
import { Canvas } from './canvas.js';
import { renderWidgets, cleanupWidgets } from './iframe-widget-renderer.js';

const socket = io();
socket.emit('join_presenter');

// Available AI models (loaded from presentation ZIP)
let availableModels = [];

window.addEventListener("DOMContentLoaded", () => {

const timerContainer = document.getElementById("timer-container");
const timer = new Timer(timerContainer);

const toolContainer = document.getElementById('tool-container');

const hand = new Button(toolContainer, {
    label: '<i class="fa-solid fa-hand-pointer"></i>',
    className: 'control_panel_btn'
});

const pen = new Button(toolContainer, {
    label: '<i class="fa-solid fa-pen"></i>',
    className: 'control_panel_btn'
});

const highlighter = new Button(toolContainer, {
    label: '<i class="fa-solid fa-highlighter"></i>',
    className: 'control_panel_btn'
});

const eraser = new Button(toolContainer, {
    label: '<i class="fa-solid fa-eraser"></i>',
    className: 'control_panel_btn'
});

const toolSelector = new Selector([hand, pen, highlighter, eraser], 'control_panel_btn_selected');
toolSelector.select(hand);

const colors = ['#eeeeee', '#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#333333'];
const colorContainer = document.getElementById('color-picker');

const colorBtns = colors.map(color => {
    const btn = new Button(colorContainer, {
        className: 'color-swatch',
    });
    btn.el.style.background = color;
    return btn;
});

const colorSelector = new Selector(colorBtns, 'color-selected');
colorSelector.select(colorBtns[6]);

const navContainer = document.getElementById('nav-container');

const prevBtn = new Button(navContainer, {
    label: '<i class="fa-solid fa-arrow-left"></i>',
    className: 'control_panel_btn'
});

const nextBtn = new Button(navContainer, {
    label: '<i class="fa-solid fa-arrow-right"></i>',
    className: 'control_panel_btn'
});

const brushContainer = document.getElementById('brush-controls');

const brushMinusBtn = new Button(brushContainer, {
    label: '<i class="fa-solid fa-minus"></i>',
    className: 'control_panel_btn'
});

const brushSizeLbl = new Label(brushContainer, {
    id: 'brush_size_scroll',
    className: 'brush_size_scroll',
    initial: '2'
});

const brushPlusBtn = new Button(brushContainer, {
    label: '<i class="fa-solid fa-plus"></i>',
    className: 'control_panel_btn'
});

const otherControlsContainer = document.getElementById('other-controls');

const clearBtn = new Button(otherControlsContainer, {
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-broom"></i>'
});

// Add spacing after clear button
clearBtn.el.style.marginRight = '20px';

const surveyBtn = new Button(otherControlsContainer, {
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-poll"></i>'
});

// Add spacing between survey buttons
surveyBtn.el.style.marginRight = '10px';

const surveyResultsBtn = new Button(otherControlsContainer, {
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-chart-simple"></i>'
});

const displayControls = document.getElementById('display-controls');

const uploadBtn = new Button(displayControls, {
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-upload"></i>',
});

const ann_canvas_container = document.getElementById('ann-canvas');
const annCvs = new Canvas(ann_canvas_container);
const slide_canvas_container = document.getElementById('pdf-canvas');
const pdfCvs = new Canvas(slide_canvas_container, false);

hand.onClick(() => annCvs.setPointerMode('hand'));
pen.onClick(() => annCvs.setPointerMode('draw'));
highlighter.onClick(() => annCvs.setPointerMode('highlight'));
eraser.onClick(() => annCvs.setPointerMode('erase'));

function onToolSelected(selected) {
    if (selected === pen) annCvs.setPointerMode('draw');
    else if (selected === highlighter) annCvs.setPointerMode('highlight');
    else if (selected === eraser) annCvs.setPointerMode('erase');
}

toolSelector.buttons.forEach(item => {
    item.el.addEventListener('click', () => onToolSelected(item));
});

colorBtns.forEach(btn => {
  btn.onClick(() => {
    annCvs.setStrokeColor(getComputedStyle(btn.el).backgroundColor);
  });
});

brushMinusBtn.onClick(() => {
    let val = parseInt(brushSizeLbl.get());
    if (val > 1) val--;
    brushSizeLbl.set(String(val));
    annCvs.setStrokeWidth(val);
});

brushPlusBtn.onClick(() => {
    let val = parseInt(brushSizeLbl.get());
    if (val < 9) val++;
    brushSizeLbl.set(String(val));
    annCvs.setStrokeWidth(val);
});

clearBtn.onClick(() => {
    annCvs.clear();
    socket.emit('clear_annotations');
});

const fileInput = document.getElementById("upload-zip");
uploadBtn.onClick(() => {
    fileInput.click();
});

let zipFile = null;
let slideConfigs = {}; // Store configs per slide
let mediaCache = {}; // Cache media files as we need them
let annotations = {};
let currentSlide = 0;
let totalSlides = 0;

// Load a specific slide's config from the ZIP
async function loadSlideConfig(slideIndex) {
    if (slideConfigs[slideIndex]) {
        return slideConfigs[slideIndex]; // Already loaded
    }
    
    const configFileName = `config/s${slideIndex}.json`;
    const configFile = zipFile.file(configFileName);
    
    if (!configFile) {
        // No config for this slide = no media
        slideConfigs[slideIndex] = null;
        return null;
    }
    
    const configText = await configFile.async("string");
    const config = JSON.parse(configText);
    slideConfigs[slideIndex] = config;
    
    console.log(`Loaded config for slide ${slideIndex}:`, config);
    return config;
}

// Load media file from path (with caching)
async function loadMediaFromPath(path) {
    if (mediaCache[path]) {
        return mediaCache[path]; // Already loaded
    }
    
    const file = zipFile.file(path);
    if (!file) {
        console.error(`Media file not found: ${path}`);
        return null;
    }
    
    const blob = await file.async("blob");
    const url = URL.createObjectURL(blob);
    mediaCache[path] = url;
    
    console.log(`Loaded media: ${path}`);
    return url;
}

// Real-time sync
let annotationSyncTimeout = null;
annCvs.canvas.addEventListener('mouseup', () => syncAnnotations());
annCvs.canvas.addEventListener('touchend', () => syncAnnotations());

function syncAnnotations() {
    clearTimeout(annotationSyncTimeout);
    annotationSyncTimeout = setTimeout(() => {
        const annData = annCvs.canvas.toDataURL("image/png");
        socket.emit('annotation_update', { 
            annotations: annData,
            slideIndex: currentSlide 
        });
    }, 100);
}

// Navigation
prevBtn.onClick(() => goToSlide(currentSlide - 1));
nextBtn.onClick(() => goToSlide(currentSlide + 1));

document.addEventListener('keydown', (e) => {
    if (resultsOverlayVisible) return;
    if (e.key === 'ArrowLeft') goToSlide(currentSlide - 1);
    if (e.key === 'ArrowRight') goToSlide(currentSlide + 1);
});

async function goToSlide(slideIndex) {
    if (slideIndex < 0 || slideIndex >= totalSlides) return;
    
    currentSlide = slideIndex;
    await renderSlide(currentSlide);
    
    const annData = annCvs.canvas.toDataURL("image/png");
    socket.emit('slide_change', {
        slideIndex: currentSlide,
        annotations: annData
    });
}

async function renderSlide(slideIndex) {
    console.log('renderSlide called:', slideIndex);
    
    if (!zipFile) {
        console.log('No ZIP file loaded');
        return;
    }
    
    // Load PDF page
    const pdfFile = zipFile.file("slides.pdf");
    if (!pdfFile) {
        console.error("No slides.pdf found in ZIP");
        return;
    }
    
    const pdfData = await pdfFile.async("arraybuffer");
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const page = await pdfDoc.getPage(slideIndex + 1);
    
    await pdfCvs.renderPDFPage(page);
    
    // Clear previous media elements
    const existingMedia = slide_canvas_container.querySelectorAll('video, audio, model-viewer');
    existingMedia.forEach(el => el.remove());
    
    // Clean up previous widgets
    cleanupWidgets(slide_canvas_container);
    
    // Load slide config
    const slideConfig = await loadSlideConfig(slideIndex);
    
    if (!slideConfig) {
        console.log('No config for this slide');
        return;
    }
    
    console.log('Videos to render:', slideConfig.videos?.length || 0);
    console.log('Models to render:', slideConfig.models?.length || 0);
    console.log('Widgets to render:', slideConfig.widgets?.length || 0);
    
    // Render videos
    if (slideConfig.videos) {
        for (const v of slideConfig.videos) {
            const videoURL = await loadMediaFromPath(v.path);
            if (!videoURL) continue;
            
            const video = document.createElement("video");
            video.src = videoURL;
            video.volume = v.volume || 1.0;
            video.dataset.videoId = v.id;
            
            video.style.position = "absolute";
            video.style.left = `${v.x * pdfCvs.getDisplayWidth()}px`;
            video.style.top = `${v.y * pdfCvs.getDisplayHeight()}px`;
            video.style.width = `${v.width * pdfCvs.getDisplayWidth()}px`;
            video.style.height = `${v.height * pdfCvs.getDisplayHeight()}px`;
            video.style.objectFit = "contain";
            video.style.zIndex = v.zIndex || 5;
            
            if (v.playMode === "once") {
                video.autoplay = true;
                video.loop = false;
            }
            if (v.playMode === "loop") {
                video.autoplay = true;
                video.loop = true;
            }
            if (v.playMode === "manual") {
                video.controls = true;
            }
            
            video.addEventListener('play', () => {
                socket.emit('video_action', {
                    videoId: v.id,
                    slideIndex: currentSlide,
                    action: 'play',
                    currentTime: video.currentTime
                });
            });
            
            video.addEventListener('pause', () => {
                socket.emit('video_action', {
                    videoId: v.id,
                    slideIndex: currentSlide,
                    action: 'pause',
                    currentTime: video.currentTime
                });
            });
            
            slide_canvas_container.appendChild(video);
        }
    }
    
    // Render 3D models
    if (slideConfig.models) {
        for (const m of slideConfig.models) {
            const modelURL = await loadMediaFromPath(m.path);
            if (!modelURL) continue;
            
            const mv = document.createElement("model-viewer");
            mv.src = modelURL;
            mv.alt = m.alt || "3D model";
            mv.dataset.modelId = m.id;
            mv.setAttribute("camera-controls", "");
            mv.setAttribute("shadow-intensity", "1");
            mv.setAttribute("auto-rotate", m.autoRotate ? "true" : "false");
            
            mv.style.position = "absolute";
            mv.style.left = `${m.x * pdfCvs.getDisplayWidth()}px`;
            mv.style.top = `${m.y * pdfCvs.getDisplayHeight()}px`;
            mv.style.width = `${m.width * pdfCvs.getDisplayWidth()}px`;
            mv.style.height = `${m.height * pdfCvs.getDisplayHeight()}px`;
            mv.style.zIndex = m.zIndex || 5;
            
            mv.addEventListener('camera-change', () => {
                const camera = mv.getCameraOrbit();
                const target = mv.getCameraTarget();
                socket.emit('model_interaction', {
                    modelId: m.id,
                    slideIndex: currentSlide,
                    camera: {
                        theta: camera.theta,
                        phi: camera.phi,
                        radius: camera.radius
                    },
                    target: {
                        x: target.x,
                        y: target.y,
                        z: target.z
                    }
                });
            });
            
            slide_canvas_container.appendChild(mv);
        }
    }
    
    // Render audio
    if (slideConfig.audio) {
        for (const a of slideConfig.audio) {
            const audioURL = await loadMediaFromPath(a.path);
            if (!audioURL) continue;
            
            const audio = document.createElement("audio");
            audio.src = audioURL;
            audio.volume = a.volume || 1.0;
            if (a.playMode === "auto") audio.play();
            if (a.playMode === "manual") audio.controls = true;
            
            slide_canvas_container.appendChild(audio);
        }
    }
    
    // Render widgets
    if (slideConfig.widgets) {
        renderWidgets(slideConfig, slide_canvas_container, 
                     () => pdfCvs.getDisplayWidth(), 
                     () => pdfCvs.getDisplayHeight(), 
                     zipFile);
    }
}

// File upload
fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    console.log('File selected:', file.name);
    
    // Upload to server
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch('/api/presentation/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        console.log('Upload response:', data);
        
        if (data.success) {
            // Load available models
            await loadAvailableModels();
            
            console.log(`Presentation uploaded with ${data.models_found} AI models`);
            if (data.models && data.models.length > 0) {
                console.log('Available AI models:', data.models);
            }
        }
    } catch (error) {
        console.error('Error uploading presentation:', error);
        alert('Failed to upload presentation');
        return;
    }
    
    // Load ZIP into memory
    const arrayBuffer = await file.arrayBuffer();
    zipFile = await JSZip.loadAsync(arrayBuffer);
    console.log('ZIP loaded into memory');
    
    // Get PDF page count
    const pdfFile = zipFile.file("slides.pdf");
    if (!pdfFile) {
        console.error("No slides.pdf found in ZIP!");
        alert("No slides.pdf found in presentation!");
        return;
    }
    
    const pdfData = await pdfFile.async("arraybuffer");
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    totalSlides = pdfDoc.numPages;
    
    console.log(`Total slides: ${totalSlides}`);
    
    // Reset state
    currentSlide = 0;
    slideConfigs = {};
    mediaCache = {};
    
    // Render first slide
    await renderSlide(0);
    
    // Notify viewers
    socket.emit('presentation_loaded', {
        totalSlides: totalSlides
    });
});

// Load available AI models from server
async function loadAvailableModels() {
    try {
        const response = await fetch('/api/models');
        const data = await response.json();
        availableModels = data.models || [];
        console.log('Available AI models:', availableModels);
    } catch (error) {
        console.error('Error loading models:', error);
        availableModels = [];
    }
}

// Survey functionality
let currentSurveyResults = null;
let resultsOverlayVisible = false;

surveyBtn.onClick(async () => {
    // Check if models are available
    if (availableModels.length === 0) {
        alert('No AI models available. Please upload a presentation with AI models in the ai/ folder.');
        return;
    }
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <h2 style="margin-bottom: 1.5rem; font-family: 'Open Sans', sans-serif;">Create Survey</h2>
            
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; font-family: 'Open Sans', sans-serif;">Question:</label>
                <input 
                    type="text" 
                    id="survey-question" 
                    placeholder="What do you think about...?"
                    style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; font-family: 'Open Sans', sans-serif; box-sizing: border-box;"
                />
            </div>
            
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; font-family: 'Open Sans', sans-serif;">AI Model:</label>
                <select 
                    id="survey-model"
                    style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; background: white; font-family: 'Open Sans', sans-serif; box-sizing: border-box;"
                >
                    <option value="">Select a model...</option>
                </select>
                <div style="margin-top: 0.5rem; font-size: 0.85rem; color: #666; font-family: 'Open Sans', sans-serif;">
                    Models are loaded from the ai/ folder in your presentation ZIP
                </div>
            </div>
            
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; font-family: 'Open Sans', sans-serif;">Number of Summaries:</label>
                <input 
                    type="number" 
                    id="num-summaries" 
                    min="1" 
                    max="10" 
                    value="3"
                    style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; font-family: 'Open Sans', sans-serif; box-sizing: border-box;"
                />
                <div style="margin-top: 0.5rem; font-size: 0.85rem; color: #666; font-family: 'Open Sans', sans-serif;">
                    Generate 1-10 different summary variations
                </div>
            </div>
            
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button 
                    id="cancel-survey" 
                    class="control_panel_btn"
                    style="background: #666;"
                >
                    Cancel
                </button>
                <button 
                    id="create-survey" 
                    class="control_panel_btn"
                    style="background: #3498db;"
                >
                    Create Survey
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Populate model dropdown
    const modelSelect = document.getElementById('survey-model');
    availableModels.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        // Format model name nicely
        option.textContent = model.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        modelSelect.appendChild(option);
    });
    
    // Set default model if available
    if (availableModels.length > 0) {
        modelSelect.value = availableModels[0];
    }
    
    // Focus on question input
    document.getElementById('survey-question').focus();
    
    // Cancel button
    document.getElementById('cancel-survey').onclick = () => {
        document.body.removeChild(modal);
    };
    
    // Create button
    document.getElementById('create-survey').onclick = async () => {
        const question = document.getElementById('survey-question').value.trim();
        const model = document.getElementById('survey-model').value;
        const numSummaries = parseInt(document.getElementById('num-summaries').value);
        
        if (!question) {
            alert('Please enter a question');
            return;
        }
        
        if (!model) {
            alert('Please select an AI model');
            return;
        }
        
        if (isNaN(numSummaries) || numSummaries < 1 || numSummaries > 10) {
            alert('Number of summaries must be between 1 and 10');
            return;
        }
        
        try {
            const response = await fetch('/api/survey/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    question,
                    model,
                    num_summaries: numSummaries
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                alert(data.error || 'Failed to create survey');
                return;
            }
            
            document.body.removeChild(modal);
            
            // Show the survey to viewers and display QR code
            socket.emit('survey_show', data);
            showSurveyQRCode(data);
            
        } catch (error) {
            console.error('Error creating survey:', error);
            alert('Failed to create survey');
        }
    };
    
    // Close on click outside
    modal.onclick = (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    };
});

function showSurveyQRCode(surveyData) {
    const surveyUrl = `${window.location.origin}${surveyData.url}`;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>Survey Active</h2>
            <p>Scan this QR code or visit the URL to respond:</p>
            <div class="qr-container">
                <div id="qrcode"></div>
            </div>
            <div class="survey-url">
                <input type="text" readonly value="${surveyUrl}" onclick="this.select()">
            </div>
            <div class="response-count">
                Responses: <span id="response-count-pill" class="pill">0</span>
            </div>
            <div class="modal-actions">
                <button id="close-survey" class="control_panel_btn">Close & Analyze</button>
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
    
    socket.on('survey_response', (data) => {
        if (data.survey_id === surveyData.survey_id) {
            document.getElementById('response-count-pill').textContent = data.total;
        }
    });
    
    document.getElementById('close-survey').onclick = () => closeSurveyAndAnalyze(surveyData.survey_id, modal);
}

async function processResponses(surveyId) {
    try {
        const response = await fetch(`/api/survey/${surveyId}/responses`);
        const data = await response.json();
        
        if (data.responses.length === 0) {
            console.log('No responses to analyze');
            currentSurveyResults = {
                summaries: ['No responses collected yet.'],
                model: 'none',
                num_responses: 0
            };
            return;
        }
        
        // Show loading message
        console.log('Analyzing responses with AI model...');
        
        // Call the analyze endpoint
        const analyzeResponse = await fetch(`/api/survey/${surveyId}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!analyzeResponse.ok) {
            const errorData = await analyzeResponse.json();
            throw new Error(errorData.error || 'Analysis failed');
        }
        
        const analysisData = await analyzeResponse.json();
        
        // Store the results
        currentSurveyResults = {
            summaries: analysisData.summaries,
            model: analysisData.model,
            num_responses: analysisData.num_responses
        };
        
        console.log('Analysis complete:', currentSurveyResults);
        
    } catch (error) {
        console.error('Error processing responses:', error);
        // Show error in results
        currentSurveyResults = {
            summaries: [`Error analyzing responses: ${error.message}`],
            model: 'error',
            num_responses: 0
        };
    }
}

async function closeSurvey(surveyId, modal) {
    await fetch(`/api/survey/${surveyId}/close`, { method: 'POST' });
    socket.emit('survey_close', { survey_id: surveyId });
    document.body.removeChild(modal);
}

async function closeSurveyAndAnalyze(surveyId, modal) {
    // First, analyze the responses
    await processResponses(surveyId);
    
    // Then close the survey
    await closeSurvey(surveyId, modal);
}

// Survey Results Overlay Functions
let currentResultIndex = 0;

function disableControlButtons(disable) {
    // Disable/enable all buttons except survey results button
    const allButtons = [
        hand, pen, highlighter, eraser,
        ...colorBtns,
        brushMinusBtn, brushPlusBtn,
        prevBtn, nextBtn,
        clearBtn, surveyBtn,
        uploadBtn
    ];
    
    allButtons.forEach(btn => {
        if (btn && btn.el) {
            btn.el.disabled = disable;
            btn.el.style.opacity = disable ? '0.5' : '1';
            btn.el.style.cursor = disable ? 'not-allowed' : 'pointer';
            btn.el.style.pointerEvents = disable ? 'none' : 'auto';
        }
    });
    
    // Keep survey results button always enabled
    if (surveyResultsBtn && surveyResultsBtn.el) {
        surveyResultsBtn.el.disabled = false;
        surveyResultsBtn.el.style.opacity = '1';
        surveyResultsBtn.el.style.cursor = 'pointer';
        surveyResultsBtn.el.style.pointerEvents = 'auto';
    }
}

function showSurveyResultsOverlay() {
    if (!currentSurveyResults || !currentSurveyResults.summaries || currentSurveyResults.summaries.length === 0) {
        alert('No survey results available. Please create and close a survey first.');
        return;
    }
    
    resultsOverlayVisible = true;
    currentResultIndex = 0;
    
    // Disable all control panel buttons except survey results button
    disableControlButtons(true);
    
    // Get the PDF canvas container to match its position and size
    const pdfContainer = document.getElementById('pdf-canvas');
    const containerRect = pdfContainer.getBoundingClientRect();
    
    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'survey-results-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = `${containerRect.top}px`;
    overlay.style.left = `${containerRect.left}px`;
    overlay.style.width = `${containerRect.width}px`;
    overlay.style.height = `${containerRect.height}px`;
    overlay.style.backgroundColor = '#ffffff';
    overlay.style.zIndex = '1000';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '2rem';
    overlay.style.boxSizing = 'border-box';
    overlay.style.overflow = 'auto';
    
    const numSummaries = currentSurveyResults.summaries.length;
    
    overlay.innerHTML = `
        <div style="max-width: 800px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2rem;">
            <div id="result-content" style="text-align: center; min-height: 300px; display: flex; flex-direction: column; justify-content: center; gap: 1rem; width: 100%;">
                <!-- Content will be inserted here -->
            </div>
            
            <div style="display: flex; gap: 1rem; align-items: center;">
                <button id="prev-result" class="control_panel_btn">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <span id="result-counter" style="font-family: 'Open Sans', sans-serif; color: #666; font-size: 1rem;">
                    1 / ${numSummaries}
                </span>
                <button id="next-result" class="control_panel_btn">
                    <i class="fa-solid fa-arrow-right"></i>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    // Add event listeners
    document.getElementById('prev-result').addEventListener('click', () => {
        if (currentResultIndex > 0) {
            currentResultIndex--;
            updateResultDisplay();
        }
    });
    
    document.getElementById('next-result').addEventListener('click', () => {
        if (currentResultIndex < currentSurveyResults.summaries.length - 1) {
            currentResultIndex++;
            updateResultDisplay();
        }
    });
    
    updateResultDisplay();
}

function hideSurveyResultsOverlay() {
    resultsOverlayVisible = false;
    
    // Re-enable all control panel buttons
    disableControlButtons(false);
    
    const overlay = document.getElementById('survey-results-overlay');
    if (overlay) {
        document.body.removeChild(overlay);
    }
}

function updateResultDisplay() {
    const contentDiv = document.getElementById('result-content');
    const counterSpan = document.getElementById('result-counter');
    const prevBtn = document.getElementById('prev-result');
    const nextBtn = document.getElementById('next-result');
    
    if (!contentDiv || !currentSurveyResults || !currentSurveyResults.summaries) return;
    
    const summary = currentSurveyResults.summaries[currentResultIndex];
    const totalSummaries = currentSurveyResults.summaries.length;
    
    contentDiv.innerHTML = `
        <h2 style="font-family: 'Open Sans', sans-serif; color: #333; font-size: 2rem; margin: 0;">
            Summary ${currentResultIndex + 1}
        </h2>
        <div style="display: flex; gap: 1rem; justify-content: center; margin: 0.5rem 0; flex-wrap: wrap;">
            <div style="display: inline-block; background: #3498db; color: white; padding: 0.5rem 1rem; border-radius: 20px; font-size: 0.9rem; font-family: 'Open Sans', sans-serif;">
                Model: ${currentSurveyResults.model.replace(/_/g, ' ')}
            </div>
            <div style="display: inline-block; background: #666; color: #eee; padding: 0.5rem 1rem; border-radius: 20px; font-size: 0.9rem; font-family: 'Open Sans', sans-serif;">
                ${currentSurveyResults.num_responses} response${currentSurveyResults.num_responses !== 1 ? 's' : ''}
            </div>
        </div>
        <div style="font-family: 'Open Sans', sans-serif; color: #666; font-size: 1.1rem; line-height: 1.8; margin: 1.5rem 0; text-align: left; max-width: 700px; padding: 1.5rem; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #3498db;">
            ${summary}
        </div>
    `;
    
    counterSpan.textContent = `${currentResultIndex + 1} / ${totalSummaries}`;
    
    // Disable/enable buttons
    prevBtn.disabled = currentResultIndex === 0;
    nextBtn.disabled = currentResultIndex === totalSummaries - 1;
    
    prevBtn.style.opacity = prevBtn.disabled ? '0.5' : '1';
    nextBtn.style.opacity = nextBtn.disabled ? '0.5' : '1';
    prevBtn.style.cursor = prevBtn.disabled ? 'not-allowed' : 'pointer';
    nextBtn.style.cursor = nextBtn.disabled ? 'not-allowed' : 'pointer';
}

// Survey results button handler
surveyResultsBtn.onClick(() => {
    if (resultsOverlayVisible) {
        hideSurveyResultsOverlay();
    } else {
        showSurveyResultsOverlay();
    }
});

// ESC key to close results overlay
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && resultsOverlayVisible) {
        hideSurveyResultsOverlay();
    }
});

});