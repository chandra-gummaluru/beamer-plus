import { Timer } from './timer.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Selector } from './selector.js';
import { Toggle } from './toggle.js';
import { Canvas } from './canvas.js';
import { renderWidgets, cleanupWidgets } from './iframe-widget-renderer.js';

const socket = io();
socket.emit('join_presenter');

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

// ADDED: Responsive resize
function resizeCanvases() {
    if (totalSlides > 0 && currentSlide !== null) {
        renderSlide(currentSlide);
    }
}
window.addEventListener('resize', resizeCanvases);

fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    zipFile = await JSZip.loadAsync(arrayBuffer);

    // Clear previous data
    slideConfigs = {};
    mediaCache = {};
    annotations = {};
    currentSlide = 0;

    const pdfFile = zipFile.file("slides.pdf");
    if (!pdfFile) {
        console.error("slides.pdf not found in ZIP!");
        return;
    }

    const pdfData = await pdfFile.async("arraybuffer");
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    totalSlides = pdfDoc.numPages;
    
    console.log(`Loaded presentation with ${totalSlides} slides`);

    // Store PDF for rendering
    window.pdfDoc = pdfDoc;

    renderSlide(0);
    
    // Notify viewers
    socket.emit('presentation_loaded', { totalSlides });
});


async function renderSlide(slideIndex) {
    const page = await window.pdfDoc.getPage(slideIndex + 1);

    const container = document.getElementById('pdf-canvas');
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
        containerWidth / viewport.width,
        containerHeight / viewport.height
    );

    const scaledViewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    // Store old canvas size for scaling annotations
    const oldWidth = annCvs.canvas.width;
    const oldHeight = annCvs.canvas.height;
    
    // Save current annotations if they exist (before resizing)
    let currentAnnotations = null;
    if (oldWidth > 0 && oldHeight > 0) {
        currentAnnotations = annCvs.canvas.toDataURL("image/png");
    }

    // Set canvas internal resolution (accounting for DPR for sharp rendering)
    pdfCvs.canvas.width = scaledViewport.width * dpr;
    pdfCvs.canvas.height = scaledViewport.height * dpr;
    
    // Get fresh context and scale for DPR
    pdfCvs.ctx = pdfCvs.canvas.getContext('2d');
    pdfCvs.ctx.scale(dpr, dpr);

    annCvs.canvas.width = scaledViewport.width * dpr;
    annCvs.canvas.height = scaledViewport.height * dpr;
    
    // Get fresh context and scale for DPR
    annCvs.ctx = annCvs.canvas.getContext('2d');
    annCvs.ctx.scale(dpr, dpr);

    const renderContext = {
        canvasContext: pdfCvs.ctx,
        viewport: scaledViewport
    };

    await page.render(renderContext).promise;

    // Load saved annotations and scale them to new size
    const annotationToLoad = currentAnnotations || annotations[slideIndex];
    if (annotationToLoad) {
        const img = new Image();
        img.onload = () => {
            annCvs.ctx.clearRect(0, 0, scaledViewport.width, scaledViewport.height);
            annCvs.ctx.drawImage(img, 0, 0, scaledViewport.width, scaledViewport.height);
        };
        img.src = annotationToLoad;
    } else {
        annCvs.clear();
    }

    // Load and render slide-specific config
    const slideConfig = await loadSlideConfig(slideIndex);
    await renderSlideMedia(slideConfig, scaledViewport);
}

async function renderSlideMedia(config, viewport) {
    // Clean up previous media
    cleanupSlideMedia();

    if (!config) {
        return; // No media for this slide
    }

    const container = document.getElementById('pdf-canvas');

    // Render videos
    if (config.videos) {
        for (const videoConfig of config.videos) {
            const url = await loadMediaFromPath(videoConfig.path);
            if (!url) continue;

            const video = document.createElement('video');
            video.src = url;
            video.style.position = 'absolute';
            video.style.left = `${videoConfig.x * viewport.width}px`;
            video.style.top = `${videoConfig.y * viewport.height}px`;
            video.style.width = `${videoConfig.width * viewport.width}px`;
            video.style.height = `${videoConfig.height * viewport.height}px`;
            video.style.zIndex = videoConfig.zIndex || 5;
            video.volume = videoConfig.volume || 1.0;
            video.playbackRate = videoConfig.playbackRate || 1.0;

            if (videoConfig.playMode === 'auto' || videoConfig.playMode === 'once') {
                video.play();
            } else if (videoConfig.playMode === 'loop') {
                video.loop = true;
                video.play();
            } else if (videoConfig.playMode === 'click') {
                video.addEventListener('click', () => {
                    if (video.paused) video.play();
                    else video.pause();
                });
            }

            container.appendChild(video);
        }
    }

    // Render audio
    if (config.audio) {
        for (const audioConfig of config.audio) {
            const url = await loadMediaFromPath(audioConfig.path);
            if (!url) continue;

            const audio = new Audio(url);
            audio.volume = audioConfig.volume || 1.0;

            if (audioConfig.playMode === 'auto') {
                audio.play();
            }

            container.appendChild(audio);
        }
    }

    // Render 3D models
    if (config.models) {
        for (const modelConfig of config.models) {
            const url = await loadMediaFromPath(modelConfig.path);
            if (!url) continue;

            const modelViewer = document.createElement('model-viewer');
            modelViewer.src = url;
            modelViewer.style.position = 'absolute';
            modelViewer.style.left = `${modelConfig.x * viewport.width}px`;
            modelViewer.style.top = `${modelConfig.y * viewport.height}px`;
            modelViewer.style.width = `${modelConfig.width * viewport.width}px`;
            modelViewer.style.height = `${modelConfig.height * viewport.height}px`;
            modelViewer.style.zIndex = modelConfig.zIndex || 20;
            modelViewer.setAttribute('camera-controls', '');
            modelViewer.setAttribute('auto-rotate', '');

            container.appendChild(modelViewer);
        }
    }

    // Render widgets
    if (config.widgets) {
        renderWidgets(
            config,
            container,
            () => viewport.width,
            () => viewport.height,
            zipFile
        );
    }
}

function cleanupSlideMedia() {
    const container = document.getElementById('pdf-canvas');
    
    // Remove all video elements
    container.querySelectorAll('video').forEach(el => {
        el.pause();
        el.remove();
    });
    
    // Remove all audio elements
    container.querySelectorAll('audio').forEach(el => {
        el.pause();
        el.remove();
    });
    
    // Remove all model-viewer elements
    container.querySelectorAll('model-viewer').forEach(el => el.remove());
    
    // Clean up widgets
    cleanupWidgets(container);
}

prevBtn.onClick(async () => {
    if (currentSlide > 0) {
        annotations[currentSlide] = annCvs.canvas.toDataURL("image/png");
        currentSlide--;
        await renderSlide(currentSlide);
        const annImage = annCvs.canvas.toDataURL("image/png");
        socket.emit('slide_change', {
            slideIndex: currentSlide,
            annotations: annImage
        });
    }
});

document.addEventListener('keydown', async (event) => {
    if (resultsOverlayVisible) return; // Don't navigate if overlay is visible
    
    if (event.key === 'ArrowLeft') {
        if (currentSlide > 0) {
            // Save current annotations
            annotations[currentSlide] = annCvs.canvas.toDataURL("image/png");
            currentSlide--;
            await renderSlide(currentSlide);

            // Emit slide change with annotations
            const annImage = annCvs.canvas.toDataURL("image/png");
            socket.emit('slide_change', {
                slideIndex: currentSlide,
                annotations: annImage
            });
        }
    }
});

nextBtn.onClick(async () => {
    if (currentSlide < totalSlides - 1) {
        annotations[currentSlide] = annCvs.canvas.toDataURL("image/png");
        currentSlide++;
        await renderSlide(currentSlide);

        const annImage = annCvs.canvas.toDataURL("image/png");
        socket.emit('slide_change', {
            slideIndex: currentSlide,
            annotations: annImage
        });
    }
});

document.addEventListener('keydown', async (event) => {
    if (resultsOverlayVisible) return; // Don't navigate if overlay is visible
    
    if (event.key === 'ArrowRight') {
        if (currentSlide < totalSlides - 1) {
            // Save current annotations
            annotations[currentSlide] = annCvs.canvas.toDataURL("image/png");
            currentSlide++;
            await renderSlide(currentSlide);

            // Emit slide change with annotations
            const annImage = annCvs.canvas.toDataURL("image/png");
            socket.emit('slide_change', {
                slideIndex: currentSlide,
                annotations: annImage
            });
        }
    }
});

// ADDED: Survey without prompt
let currentSurvey = null;
let currentSurveyResults = null;
let resultsOverlayVisible = false;

surveyBtn.onClick(async () => {
    try {
        const response = await fetch('/api/survey/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: 'Share your thoughts' })
        });
        const data = await response.json();
        currentSurvey = data;
        currentSurveyResults = null; // Reset results when new survey starts
        currentResultIndex = 0; // Reset index when new survey starts
        
        // Broadcast survey to viewers
        socket.emit('survey_show', {
            survey_id: data.survey_id,
            url: data.url
        });
        
        showSurveyModal(data);
    } catch (error) {
        console.error('Error creating survey:', error);
    }
});

// Survey results button handler
surveyResultsBtn.onClick(() => {
    if (!currentSurveyResults) {
        // Generate sample results (will be replaced with real AI results later)
        currentSurveyResults = getSampleSurveyResults();
    }
    
    if (resultsOverlayVisible) {
        hideSurveyResultsOverlay();
    } else {
        showSurveyResultsOverlay();
    }
});

function getSampleSurveyResults() {
    // Temporary hardcoded sample summaries
    return {
        themes: [
            {
                title: "Engagement and Interactivity",
                summary: "Students highly value interactive elements like polls and real-time Q&A. They appreciate when professors use technology to make lectures more engaging rather than passive listening experiences.",
                count: 12
            },
            {
                title: "Visual Learning Preferences",
                summary: "Many respondents emphasized the importance of visual aids, diagrams, and videos. They find that multimedia content helps them understand complex concepts better than text-heavy slides alone.",
                count: 8
            },
            {
                title: "Pace and Time Management",
                summary: "Several students mentioned that the presentation pace should allow time for questions and reflection. They prefer when presenters pause periodically rather than rushing through all content.",
                count: 7
            }
        ]
    };
}

function showSurveyModal(surveyData) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    
    const surveyUrl = `${window.location.origin}${surveyData.url}`;
    
    modal.innerHTML = `
        <div class="modal-content">
            <div class="qr-container">
                <div id="qrcode"></div>
            </div>
            <div class="survey-url">
                <input type="text" readonly value="${surveyUrl}" onclick="this.select()">
            </div>
            <div class="response-section">
                <div class="response-header">
                    <span>Responses</span>
                    <div id="response-count-pill" style="display: inline-block; background: #666; color: #eee; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.9rem; margin-left: 0.5rem;">0</div>
                </div>
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
            // Use sample data if no responses
            currentSurveyResults = getSampleSurveyResults();
            return;
        }
        
        // Show loading in console
        console.log('Analyzing responses...');
        
        const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1000,
                messages: [{role: 'user', content: `Analyze these survey responses and group them into 3-5 main themes. For each theme, provide a title and brief summary.\n\nResponses:\n${data.responses.map((r, i) => `${i+1}. ${r.text}`).join('\n')}\n\nFormat your response as JSON like this:\n{\n  "themes": [\n    {"title": "Theme Name", "summary": "Brief summary", "count": 5},\n    ...\n  ]\n}`}]
            })
        });
        const aiData = await apiResponse.json();
        const aiText = aiData.content[0].text;
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const summary = JSON.parse(jsonMatch[0]);
            currentSurveyResults = summary; // Store in currentSurveyResults
            console.log('Analysis complete');
        } else {
            console.log('Could not parse AI response');
            currentSurveyResults = getSampleSurveyResults();
        }
    } catch (error) {
        console.error('Error processing responses:', error);
        // Use sample data on error
        currentSurveyResults = getSampleSurveyResults();
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
    resultsOverlayVisible = true;
    
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
    
    overlay.innerHTML = `
        <div style="max-width: 800px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2rem;">
            <div id="result-content" style="text-align: center; min-height: 300px; display: flex; flex-direction: column; justify-content: center; gap: 1rem;">
                <!-- Content will be inserted here -->
            </div>
            
            <div style="display: flex; gap: 1rem; align-items: center;">
                <button id="prev-result" class="control_panel_btn">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <span id="result-counter" style="font-family: 'Open Sans', sans-serif; color: #666; font-size: 1rem;">
                    1 / 3
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
        if (currentResultIndex < currentSurveyResults.themes.length - 1) {
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
    
    if (!contentDiv || !currentSurveyResults) return;
    
    const theme = currentSurveyResults.themes[currentResultIndex];
    
    contentDiv.innerHTML = `
        <h2 style="font-family: 'Open Sans', sans-serif; color: #333; font-size: 2rem; margin: 0;">
            ${theme.title}
        </h2>
        <div style="display: inline-block; background: #666; color: #eee; padding: 0.5rem 1rem; border-radius: 20px; font-size: 0.9rem; margin: 0.5rem 0;">
            ${theme.count} response${theme.count !== 1 ? 's' : ''}
        </div>
        <p style="font-family: 'Open Sans', sans-serif; color: #666; font-size: 1.2rem; line-height: 1.8; margin: 1.5rem 0;">
            ${theme.summary}
        </p>
    `;
    
    counterSpan.textContent = `${currentResultIndex + 1} / ${currentSurveyResults.themes.length}`;
    
    // Disable/enable buttons
    prevBtn.disabled = currentResultIndex === 0;
    nextBtn.disabled = currentResultIndex === currentSurveyResults.themes.length - 1;
    
    prevBtn.style.opacity = prevBtn.disabled ? '0.5' : '1';
    nextBtn.style.opacity = nextBtn.disabled ? '0.5' : '1';
    prevBtn.style.cursor = prevBtn.disabled ? 'not-allowed' : 'pointer';
    nextBtn.style.cursor = nextBtn.disabled ? 'not-allowed' : 'pointer';
}

});