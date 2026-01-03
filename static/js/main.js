import { Timer } from './timer.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Selector } from './selector.js';
import { Toggle } from './toggle.js';
import { Canvas } from './canvas.js';
import { renderWidgets, cleanupWidgets } from './iframe-widget-renderer.js';
import { Modal } from './beamer_modal.js';
import { setControlsEnabledAfterUpload, disableControlButtons } from './beamer_ui.js';

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
    className: 'btn'
});

const pen = new Button(toolContainer, {
    label: '<i class="fa-solid fa-pen"></i>',
    className: 'btn'
});

const highlighter = new Button(toolContainer, {
    label: '<i class="fa-solid fa-highlighter"></i>',
    className: 'btn'
});

const eraser = new Button(toolContainer, {
    label: '<i class="fa-solid fa-eraser"></i>',
    className: 'btn'
});

const toolSelector = new Selector([hand, pen, highlighter, eraser], 'btn_selected');
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
    className: 'btn'
});

const nextBtn = new Button(navContainer, {
    label: '<i class="fa-solid fa-arrow-right"></i>',
    className: 'btn'
});

const brushContainer = document.getElementById('brush-controls');

const brushMinusBtn = new Button(brushContainer, {
    label: '<i class="fa-solid fa-minus"></i>',
    className: 'btn'
});

const brushSizeLbl = new Label(brushContainer, {
    id: 'brush_size_scroll',
    className: 'brush_size_scroll',
    initial: '2'
});

const brushPlusBtn = new Button(brushContainer, {
    label: '<i class="fa-solid fa-plus"></i>',
    className: 'btn'
});

const otherControlsContainer = document.getElementById('other-controls');

const clearBtn = new Button(otherControlsContainer, {
    className: 'btn',
    label: '<i class="fa-solid fa-broom"></i>'
});

clearBtn.el.style.marginRight = '20px';

const surveyBtn = new Button(otherControlsContainer, {
    className: 'btn',
    label: '<i class="fa-solid fa-clipboard-list"></i>'
});

surveyBtn.el.style.marginRight = '10px';

const surveyResultsBtn = new Button(otherControlsContainer, {
    className: 'btn',
    label: '<i class="fa-solid fa-chart-simple"></i>'
});

// Initially disable results button
surveyResultsBtn.el.disabled = true;
surveyResultsBtn.el.style.opacity = '0.5';
surveyResultsBtn.el.style.cursor = 'not-allowed';

const displayControls = document.getElementById('display-controls');

const uploadBtn = new Button(displayControls, {
    className: 'btn',
    label: '<i class="fa-solid fa-upload"></i>',
});

// Keep list of controls for enabling/disabling (upload button remains enabled)
const __beamer_controls = [
    hand, pen, highlighter, eraser,
    ...colorBtns,
    brushMinusBtn, brushPlusBtn,
    prevBtn, nextBtn,
    clearBtn, surveyBtn
];

// Disable at startup
setControlsEnabledAfterUpload(false, __beamer_controls);

// Full set used for temporary disabling (includes upload button)
const __beamer_all_buttons = [...__beamer_controls, uploadBtn];

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
    // Clear current slide annotations locally and notify server
    annotations[currentSlide] = null;
    socket.emit('clear_annotations');
});

const fileInput = document.getElementById("upload-zip");
uploadBtn.onClick(() => {
    fileInput.click();
});

let zipFile = null;
let slideConfigs = {};
let mediaCache = {};
let annotations = {};
let currentSlide = 0;
let totalSlides = 0;

async function loadSlideConfig(slideIndex) {
    if (slideConfigs[slideIndex]) {
        return slideConfigs[slideIndex];
    }
    
    const configFileName = `config/s${slideIndex}.json`;
    const configFile = zipFile.file(configFileName);
    
    if (!configFile) {
        slideConfigs[slideIndex] = null;
        return null;
    }
    
    const configText = await configFile.async("string");
    const config = JSON.parse(configText);
    slideConfigs[slideIndex] = config;
    
    console.log(`Loaded config for slide ${slideIndex}:`, config);
    return config;
}

async function loadMediaFromPath(path) {
    if (mediaCache[path]) {
        return mediaCache[path];
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

let annotationSyncTimeout = null;
annCvs.canvas.addEventListener('mouseup', () => syncAnnotations());
annCvs.canvas.addEventListener('touchend', () => syncAnnotations());

function syncAnnotations() {
    clearTimeout(annotationSyncTimeout);
    annotationSyncTimeout = setTimeout(() => {
        const annData = annCvs.canvas.toDataURL("image/png");
        // Save annotations locally per-slide and emit to server
        annotations[currentSlide] = annData;
        socket.emit('annotation_update', {
            annotations: annData,
            slideIndex: currentSlide
        });
    }, 100);
}

prevBtn.onClick(() => goToSlide(currentSlide - 1));
nextBtn.onClick(() => goToSlide(currentSlide + 1));

document.addEventListener('keydown', (e) => {
    if (surveyOverlayVisible || resultsOverlayVisible) return;
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
    
    const pdfFile = zipFile.file("slides.pdf");
    if (!pdfFile) {
        console.error("No slides.pdf found in ZIP");
        return;
    }
    
    const pdfData = await pdfFile.async("arraybuffer");
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const page = await pdfDoc.getPage(slideIndex + 1);
    
    await pdfCvs.renderPDFPage(page);

    // Load per-slide annotations (clear then draw saved image if present)
    try {
        annCvs.clear();
        if (annotations[slideIndex]) {
            await annCvs.loadAnnotations(annotations[slideIndex]);
        }
    } catch (e) {
        console.warn('Error loading annotations for slide', slideIndex, e);
    }
    
    const existingMedia = slide_canvas_container.querySelectorAll('video, audio, model-viewer');
    existingMedia.forEach(el => el.remove());
    
    cleanupWidgets(slide_canvas_container);
    
    const slideConfig = await loadSlideConfig(slideIndex);
    
    if (!slideConfig) {
        console.log('No config for this slide');
        return;
    }
    
    console.log('Videos to render:', slideConfig.videos?.length || 0);
    console.log('Models to render:', slideConfig.models?.length || 0);
    console.log('Widgets to render:', slideConfig.widgets?.length || 0);
    
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

            // Allow clicking the video to toggle play/pause
            video.addEventListener('click', (ev) => {
                // Only toggle when in hand mode (clicks should pass through otherwise)
                try {
                    if (video.paused) video.play();
                    else video.pause();
                } catch (e) {
                    console.error('Error toggling video playback:', e);
                }
                ev.stopPropagation();
            });
            
            slide_canvas_container.appendChild(video);
        }
    }
    
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
    
    if (slideConfig.widgets) {
        renderWidgets(slideConfig, slide_canvas_container, 
                     () => pdfCvs.getDisplayWidth(), 
                     () => pdfCvs.getDisplayHeight(), 
                     zipFile);
    }
}

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    console.log('File selected:', file.name);

    const uploadModal = Modal.loading('Uploading Presentation', 'Please wait while your presentation is uploaded...');

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
            await loadAvailableModels();

            console.log(`Presentation uploaded with ${data.models_found} Summarizer Script`);
            if (data.models && data.models.length > 0) {
                console.log('Available AI models:', data.models);
            }
        }
    } catch (error) {
        console.error('Error uploading presentation:', error);
        uploadModal.close();
        Modal.error('Upload Failed', 'Failed to upload presentation. Please try again.');
        return;
    }
    
    const arrayBuffer = await file.arrayBuffer();
    zipFile = await JSZip.loadAsync(arrayBuffer);
    console.log('ZIP loaded into memory');
    
    const pdfFile = zipFile.file("slides.pdf");
    if (!pdfFile) {
        console.error("The uploaded package is not a valid Beamer+ presentation (no slides.pdf found).");
        uploadModal.close();
        Modal.error('Invalid Presentation', 'The uploaded package is not a valid Beamer+ presentation.');
        return;
    }
    
    const pdfData = await pdfFile.async("arraybuffer");
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    totalSlides = pdfDoc.numPages;
    
    console.log(`Total slides: ${totalSlides}`);
    
    currentSlide = 0;
    slideConfigs = {};
    mediaCache = {};
    
    await renderSlide(0);
    
    socket.emit('presentation_loaded', {
        totalSlides: totalSlides
    });
    // Enable controls now that a presentation is loaded
    uploadModal.close();
    setControlsEnabledAfterUpload(true, __beamer_controls);
});

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
let currentSurveyData = null;
let resultsOverlayVisible = false;
let surveyOverlayVisible = false;

// Survey Button - Opens creation modal
surveyBtn.onClick(() => {
    if (availableModels.length === 0) {
        Modal.warning('No Presentation Loaded', 'Please upload a presentation.');
        return;
    }
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <h2 style="margin-bottom: 1.5rem; font-family: 'Computer Modern Sans', sans-serif; color: #333;">Survey</h2>
            
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; font-family: 'Computer Modern Sans', sans-serif; color: #555;">Question (optional):</label>
                <input 
                    type="text" 
                    id="survey-question"
                    placeholder="What do you think about...?"
                    style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; font-family: 'Computer Modern Sans', sans-serif; box-sizing: border-box;"
                />
                <div style="margin-top: 0.5rem; font-size: 0.85rem; color: #666; font-family: 'Computer Modern Sans', sans-serif;">
                    Leave blank for generic survey
                </div>
            </div>
            
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; font-family: 'Computer Modern Sans', sans-serif; color: #555;">Summarizer Script:</label>
                <select 
                    id="survey-model"
                    style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; background: white; font-family: 'Computer Modern Sans', sans-serif; box-sizing: border-box;"
                >
                </select>
                <div style="margin-top: 0.5rem; font-size: 0.85rem; color: #666; font-family: 'Computer Modern Sans', sans-serif;">
                    This script will be used to summarize survey responses
                </div>
            </div>
            
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; font-family: 'Computer Modern Sans', sans-serif; color: #555;">Number of Summaries:</label>
                <input 
                    type="number" 
                    id="survey-num-summaries" 
                    min="1" 
                    max="10" 
                    value="3"
                    style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; font-family: 'Computer Modern Sans', sans-serif; box-sizing: border-box;"
                />
                <div style="margin-top: 0.5rem; font-size: 0.85rem; color: #666; font-family: 'Computer Modern Sans', sans-serif;">
                    Generate 1-10 different summary variations
                </div>
            </div>
            
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button 
                    id="cancel-survey-modal" 
                    class="btn"
                    style="font-family: 'Computer Modern Sans', sans-serif;"
                >
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <button 
                    id="create-survey-btn" 
                    class="btn"
                    style=" font-family: 'Computer Modern Sans', sans-serif;"
                >
                    <i class="fa-solid fa-share-from-square"></i>
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
        option.textContent = model.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        modelSelect.appendChild(option);
    });
    
    if (availableModels.length > 0) {
        modelSelect.value = availableModels[0];
    }
    
    document.getElementById('survey-question').focus();
    
    document.getElementById('cancel-survey-modal').onclick = () => {
        document.body.removeChild(modal);
    };
    
    document.getElementById('create-survey-btn').onclick = async () => {
        const question = document.getElementById('survey-question').value.trim() || 'Survey';
        const model = document.getElementById('survey-model').value;
        const numSummaries = parseInt(document.getElementById('survey-num-summaries').value);
        
        if (!model) {
            Modal.warning('No Model Selected', 'Please select an AI model.');
            return;
        }
        
        if (isNaN(numSummaries) || numSummaries < 1 || numSummaries > 10) {
            Modal.warning('Invalid Number', 'Number of summaries must be between 1 and 10.');
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
                Modal.error('Survey Creation Failed', data.error || 'Failed to create survey');
                return;
            }
            
            document.body.removeChild(modal);
            
            currentSurveyData = {
                ...data,
                model,
                num_summaries: numSummaries,
                question
            };
            
            // Reset results when creating new survey
            currentSurveyResults = null;
            
            // Disable results button until we have results
            surveyResultsBtn.el.disabled = true;
            surveyResultsBtn.el.style.opacity = '0.5';
            surveyResultsBtn.el.style.cursor = 'not-allowed';
            
            socket.emit('survey_show', data);
            showSurveyOverlay();
            
        } catch (error) {
            console.error('Error creating survey:', error);
            Modal.error('Survey Creation Failed', 'Failed to create survey. Please try again.');
        }
    };
    
    modal.onclick = (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    };
});

function updateSurveyOverlayPosition() {
    const overlay = document.getElementById('survey-overlay');
    if (!overlay) return;
    
    const pdfContainer = document.getElementById('pdf-canvas');
    const containerRect = pdfContainer.getBoundingClientRect();
    
    overlay.style.top = `${containerRect.top}px`;
    overlay.style.left = `${containerRect.left}px`;
    overlay.style.width = `${containerRect.width}px`;
    overlay.style.height = `${containerRect.height}px`;
}

function showSurveyOverlay() {
    if (!currentSurveyData) return;
    
    surveyOverlayVisible = true;
    disableControlButtons(true, __beamer_all_buttons, surveyResultsBtn);
    
    const pdfContainer = document.getElementById('pdf-canvas');
    const containerRect = pdfContainer.getBoundingClientRect();
    
    const surveyUrl = `${window.location.origin}${currentSurveyData.url}`;
    
    const overlay = document.createElement('div');
    overlay.id = 'survey-overlay';
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
    overlay.style.fontFamily = "'Computer Modern Sans', sans-serif";
    
    overlay.innerHTML = `
        <div style="max-width: 600px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2rem;">
            <h2 style="font-family: 'Computer Modern Sans', sans-serif; color: #333; font-size: 2rem; margin: 0; text-align: center; font-weight: 300;">
                ${currentSurveyData.question || 'Survey'}
                <br>
                <span style="font-size: 0.9rem; color: #666; font-weight: normal;">(scan the QR code below or navigate to the URL to respond)</span>
            </h2>
            
            <div style="background: #f8f9fa; padding: 2rem; border-radius: 8px; display: flex; flex-direction: column; align-items: center; gap: 1.5rem; width: 100%;">
                <div id="qrcode" style="padding: 1rem; background: white; border-radius: 4px;"></div>
                
                <div style="width: 100%;">
                    <input 
                        type="text" 
                        readonly 
                        value="${surveyUrl}" 
                        onclick="this.select()"
                        style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-family: 'Computer Modern Sans', sans-serif; text-align: center; background: white; font-size: 0.9rem; box-sizing: border-box;"
                    />
                </div>
            </div>
            
            <div style="font-family: 'Computer Modern Sans', sans-serif; color: #666; font-size: 1rem; border: 2px solid #e0e0e0; padding: 0.75rem 1.5rem; background: white;">
                <span style="font-weight: 500; color: #333;">Responses:</span> <span id="response-count" style="font-weight: 600; color: #333;">0</span>
            </div>
            

        </div>
    `;
    
    document.body.appendChild(overlay);
    
    new QRCode(document.getElementById("qrcode"), {
        text: surveyUrl,
        width: 200,
        height: 200,
        colorDark: "#333333",
        colorLight: "#ffffff"
    });
    
    socket.on('survey_response', (data) => {
        if (data.survey_id === currentSurveyData.survey_id) {
            document.getElementById('response-count').textContent = data.total;
        }
    });
}

function hideSurveyOverlay() {
    surveyOverlayVisible = false;
    disableControlButtons(false, __beamer_all_buttons, surveyResultsBtn);
    
    const overlay = document.getElementById('survey-overlay');
    if (overlay) {
        document.body.removeChild(overlay);
    }
}

// Results Button - Toggle between show/hide results
surveyResultsBtn.onClick(async () => {
    // If results are already showing, just hide them
    if (resultsOverlayVisible) {
        hideSurveyResultsOverlay();
        return;
    }
    
    // Check if we have a survey
    if (!currentSurveyData) {
        Modal.info('No Survey', 'Please create a survey first.');
        return;
    }
    
    // If we already have results, just show them
    if (currentSurveyResults) {
        showSurveyResultsOverlay();
        return;
    }
    
    // Close the survey if it's still open
    if (surveyOverlayVisible) {
        await fetch(`/api/survey/${currentSurveyData.survey_id}/close`, { method: 'POST' });
        socket.emit('survey_close', { survey_id: currentSurveyData.survey_id });
        hideSurveyOverlay();
    }
    
    // Show loading modal
    const loadingModal = Modal.loading('Generating Summaries', 'Please wait while the responses are analyzed...');
    
    try {
        const response = await fetch(`/api/survey/${currentSurveyData.survey_id}/responses`);
        const data = await response.json();
        
        if (data.responses.length === 0) {
            loadingModal.close();
            // No responses — survey already closed above; do nothing further.
            return;
        }
        
        const analyzeResponse = await fetch(`/api/survey/${currentSurveyData.survey_id}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!analyzeResponse.ok) {
            const errorData = await analyzeResponse.json();
            throw new Error(errorData.error || 'Analysis failed');
        }
        
        const analysisData = await analyzeResponse.json();
        
        currentSurveyResults = {
            summaries: analysisData.summaries,
            model: analysisData.model,
            num_responses: analysisData.num_responses
        };
        
        console.log('Analysis complete:', currentSurveyResults);
        
        // Close loading modal
        loadingModal.close();
        
        // Enable the results button for future clicks
        surveyResultsBtn.el.disabled = false;
        surveyResultsBtn.el.style.opacity = '1';
        surveyResultsBtn.el.style.cursor = 'pointer';
        
        // Show results overlay
        showSurveyResultsOverlay();
        
    } catch (error) {
        console.error('Error processing responses:', error);
        loadingModal.close();
        Modal.error('Analysis Failed', "There was an error summarizing the responses.");
    }
});

let currentResultIndex = 0;

// Use UI helper `disableControlButtons` from beamer_ui.js

function updateSurveyResultsOverlayPosition() {
    const overlay = document.getElementById('survey-results-overlay');
    if (!overlay) return;
    
    const pdfContainer = document.getElementById('pdf-canvas');
    const containerRect = pdfContainer.getBoundingClientRect();
    
    overlay.style.top = `${containerRect.top}px`;
    overlay.style.left = `${containerRect.left}px`;
    overlay.style.width = `${containerRect.width}px`;
    overlay.style.height = `${containerRect.height}px`;
}

function showSurveyResultsOverlay() {
    if (!currentSurveyResults || !currentSurveyResults.summaries || currentSurveyResults.summaries.length === 0) {
        Modal.info('No Results', 'No survey results available.');
        return;
    }
    
    // Set this BEFORE disabling buttons to prevent flash
    resultsOverlayVisible = true;
    currentResultIndex = 0;
    
    disableControlButtons(true, __beamer_all_buttons, surveyResultsBtn);
    
    const pdfContainer = document.getElementById('pdf-canvas');
    const containerRect = pdfContainer.getBoundingClientRect();
    
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
    overlay.style.fontFamily = "'Computer Modern Sans', sans-serif";
    
    const numSummaries = currentSurveyResults.summaries.length;
    
    overlay.innerHTML = `
        <div style="max-width: 800px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2rem;">
            <div id="result-content" style="text-align: center; min-height: 300px; display: flex; flex-direction: column; justify-content: center; gap: 1rem; width: 100%;">
                <!-- Content will be inserted here -->
            </div>
            
            <div style="display: flex; gap: 1rem; align-items: center;">
                <button id="prev-result" class="btn">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <span id="result-counter" style="font-family: 'Computer Modern Sans', sans-serif; color: #666; font-size: 1rem;">
                    1 / ${numSummaries}
                </span>
                <button id="next-result" class="btn">
                    <i class="fa-solid fa-arrow-right"></i>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
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
    
    disableControlButtons(false, __beamer_all_buttons, surveyResultsBtn);
    
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
    
    const summaryData = currentSurveyResults.summaries[currentResultIndex];
    const totalSummaries = currentSurveyResults.summaries.length;
    
    contentDiv.innerHTML = `
        <h2 style="font-family: 'Computer Modern Sans', sans-serif; color: #333; font-size: 2rem; margin: 0; font-weight: 300;">
            ${currentSurveyData.question || 'Survey Response Summaries'}
            <br>
            <span style="font-size: 0.9rem; color: #666; font-weight: normal;">(based on ${summaryData.num_respondents} response${summaryData.num_respondents !== 1 ? 's' : ''})</span>
        </h2>
        <div style="font-family: 'Computer Modern Sans', sans-serif; color: #333; font-size: 1.1rem; line-height: 1.8; margin: 1.5rem 0; text-align: center; max-width: 700px; padding: 2rem; background: #f8f9fa; border: 2px solid #666; border-radius: 4px;">
            ${summaryData.summary}
        </div>
    `;
    
    counterSpan.textContent = `${currentResultIndex + 1} / ${totalSummaries}`;
    
    prevBtn.disabled = currentResultIndex === 0;
    nextBtn.disabled = currentResultIndex === totalSummaries - 1;
    
    prevBtn.style.opacity = prevBtn.disabled ? '0.5' : '1';
    nextBtn.style.opacity = nextBtn.disabled ? '0.5' : '1';
    prevBtn.style.cursor = prevBtn.disabled ? 'not-allowed' : 'pointer';
    nextBtn.style.cursor = nextBtn.disabled ? 'not-allowed' : 'pointer';
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && resultsOverlayVisible) {
        hideSurveyResultsOverlay();
    }
});

// Add resize listener to update overlay positions
window.addEventListener('resize', () => {
    if (surveyOverlayVisible) {
        updateSurveyOverlayPosition();
    }
    if (resultsOverlayVisible) {
        updateSurveyResultsOverlayPosition();
    }
    
    // Resize annotation canvas to maintain proper mouse coordinate mapping
    if (annCvs) {
        annCvs.resize();
    }
});

});