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
let config = null;
let resources = { videos: {}, audio: {}, models: {}, slides: {} };
let annotations = {};
let currentSlide = 0

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
    if (config && currentSlide !== null) {
        renderSlide(currentSlide);
    }
}
window.addEventListener('resize', resizeCanvases);

fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    zipFile = await JSZip.loadAsync(arrayBuffer);

    const configFile = zipFile.file("config.json");
    if (!configFile) {
        console.error("No config.json found in ZIP!");
        return;
    }

    const configText = await configFile.async("string");
    config = JSON.parse(configText);
    console.log("Loaded config:", config);

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
    if (!pdfFile) {
        console.error("slides.pdf not found in ZIP!");
    } else {
        const pdfData = await pdfFile.async("arraybuffer");
        const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const numPages = pdfDoc.numPages;

        for (let i = 1; i <= numPages; i++) {
            const page = await pdfDoc.getPage(i);
            resources.slides[i-1] = page;
        }

        console.log("All resources loaded:", resources);

        // Upload ZIP to server for viewers
        const formData = new FormData();
        formData.append('file', file);
        await fetch('/api/presentation/upload', {
            method: 'POST',
            body: formData
        });

        // Notify viewers to load the presentation
        socket.emit('presentation_loaded', {
            slideCount: config.slides.length
        });

        console.log("About to render slide:", currentSlide);
        await renderSlide(currentSlide);
        console.log("Finished rendering slide");
        
        // Send initial slide index to viewers
        const annImage = annCvs.canvas.toDataURL("image/png");
        socket.emit('slide_change', {
            slideIndex: currentSlide,
            annotations: annImage
        });
    }

});


async function renderSlide(slideIndex) {
    console.log("renderSlide called with index:", slideIndex);
    console.log("PDF slide exists?", !!resources.slides[slideIndex]);
    console.log("Config exists?", !!config);
    
    await pdfCvs.renderPDFPage(resources.slides[slideIndex]);
    console.log("PDF rendered");

    [...slide_canvas_container.querySelectorAll("video")].forEach(v => v.remove());
    [...slide_canvas_container.querySelectorAll("model-viewer")].forEach(m => m.remove());
    [...slide_canvas_container.querySelectorAll("audio")].forEach(a => a.remove());

    console.log("Rendering", config.slides[slideIndex].videos.length, "videos");
    
    // FIXED: Better video handling with sync
    config.slides[slideIndex].videos.forEach(v => {
        const videoURL = resources.videos[v.id];
        const video = document.createElement("video");
        video.src = videoURL;
        video.dataset.videoId = v.id; // Add ID for syncing
        video.style.position = "absolute";
        video.style.left = `${v.x * pdfCvs.getDisplayWidth()}px`;
        video.style.top = `${v.y * pdfCvs.getDisplayHeight()}px`;
        video.style.width = `${v.width * pdfCvs.getDisplayWidth()}px`;
        video.style.height = `${v.height * pdfCvs.getDisplayHeight()}px`;
        video.style.zIndex = v.zIndex;
        video.style.cursor = 'pointer';
        video.style.objectFit = "contain";
        video.style.pointerEvents = 'auto';
        video.volume = v.volume;
        video.muted = false;
        video.playbackRate = v.playbackRate;
    
        // Click handler for ALL videos - broadcast to viewers
        video.addEventListener("click", (e) => {
            e.stopPropagation();
            console.log('Video clicked, video ID:', v.id);
            if (video.paused) {
                video.play().catch(err => console.log('Play failed:', err));
                console.log('Emitting video_action: play');
                socket.emit('video_action', {
                    slideIndex: currentSlide,
                    videoId: v.id,
                    action: 'play',
                    currentTime: video.currentTime
                });
            } else {
                video.pause();
                console.log('Emitting video_action: pause');
                socket.emit('video_action', {
                    slideIndex: currentSlide,
                    videoId: v.id,
                    action: 'pause',
                    currentTime: video.currentTime
                });
            }
        });

        if (v.playMode === "click") {
            video.autoplay = false;
        }

        if (v.playMode === "once") {
            video.autoplay = true;
            video.loop = false;
            // Emit play action when video autoplays
            video.addEventListener('play', () => {
                socket.emit('video_action', {
                    slideIndex: currentSlide,
                    videoId: v.id,
                    action: 'play',
                    currentTime: video.currentTime
                });
            }, { once: true });
        }

        if (v.playMode === "loop") {
            video.autoplay = true;
            video.loop = true;
            // Emit play action when video autoplays
            video.addEventListener('play', () => {
                socket.emit('video_action', {
                    slideIndex: currentSlide,
                    videoId: v.id,
                    action: 'play',
                    currentTime: video.currentTime
                });
            }, { once: true });
        }

        video.controls = false;

        slide_canvas_container.appendChild(video);
    });

    // FIXED: 3D models with interactivity and sync
    config.slides[slideIndex].models.forEach(m => {
        const modelURL = resources.models[m.id];

        const mv = document.createElement("model-viewer");
        mv.src = modelURL;
        mv.alt = m.alt || "3D model";
        mv.dataset.modelId = m.id; // Add ID for syncing
        mv.setAttribute("shadow-intensity", "1");
        mv.setAttribute("camera-controls", "");
        mv.setAttribute("touch-action", "pan-y");
        mv.setAttribute("auto-rotate", "");

        mv.style.position = "absolute";
        mv.style.left = `${m.x * pdfCvs.getDisplayWidth()}px`;
        mv.style.top = `${m.y * pdfCvs.getDisplayHeight()}px`;
        mv.style.width = `${m.width * pdfCvs.getDisplayWidth()}px`;
        mv.style.height = `${m.height * pdfCvs.getDisplayHeight()}px`;
        mv.style.zIndex = m.zIndex;
        mv.style.pointerEvents = 'auto';

        // Sync camera changes to viewers
        mv.addEventListener('camera-change', () => {
            const camera = mv.getCameraOrbit();
            const target = mv.getCameraTarget();
            socket.emit('model_interaction', {
                slideIndex: currentSlide,
                modelId: m.id,
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
    });


    config.slides[slideIndex].audio.forEach(a => {
        const audioURL = resources.audio[a.id];
        const audio = document.createElement("audio");
        audio.src = audioURL;
        audio.volume = a.volume;
        if (a.playMode === "auto") audio.play();
        slide_canvas_container.appendChild(audio);
    });

    if (annotations[slideIndex]) {
        annCvs.ctx.clearRect(0, 0, annCvs.canvas.width, annCvs.canvas.height);
        annCvs.ctx.putImageData(annotations[slideIndex], 0, 0);
    } else {
        annCvs.clear();
    }

    // Render widgets
    cleanupWidgets(slide_canvas_container);
    renderWidgets(
        config.slides[slideIndex],
        slide_canvas_container,
        () => pdfCvs.getDisplayWidth(),
        () => pdfCvs.getDisplayHeight(),
        zipFile  // ← Important: pass the zipFile!
    );
}

prevBtn.onClick(async () => {
    if (currentSlide > 0) {
        annotations[currentSlide] = annCvs.ctx.getImageData(
            0, 0, annCvs.canvas.width, annCvs.canvas.height
        );
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
    if (event.key === 'ArrowLeft') {
        if (currentSlide > 0) {
            // Save current annotations
            annotations[currentSlide] = annCvs.ctx.getImageData(
                0, 0, annCvs.canvas.width, annCvs.canvas.height
            );
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
    if (currentSlide < config.slides.length - 1) {
        annotations[currentSlide] = annCvs.ctx.getImageData(
            0, 0, annCvs.canvas.width, annCvs.canvas.height
        );
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
    if (event.key === 'ArrowRight') {
        if (currentSlide < config.slides.length - 1) {
            // Save current annotations
            annotations[currentSlide] = annCvs.ctx.getImageData(
                0, 0, annCvs.canvas.width, annCvs.canvas.height
            );
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