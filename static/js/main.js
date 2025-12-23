import { Timer } from './timer.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Selector } from './selector.js';
import { Toggle } from './toggle.js';
import { Canvas } from './canvas.js';

const socket = io();

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

// Create buttons for each color
const colorBtns = colors.map(color => {
    const btn = new Button(colorContainer, {
        className: 'color-swatch',
    });
    btn.el.style.background = color;
    return btn;
});

// Use Selector to manage selection
const colorSelector = new Selector(colorBtns, 'color-selected');

// Optionally, select default color
colorSelector.select(colorBtns[6]);

/* Navigation */

const navContainer = document.getElementById('nav-container');

const prevBtn = new Button(navContainer, {
    label: '<i class="fa-solid fa-arrow-left"></i>',
    className: 'control_panel_btn'
});

const nextBtn = new Button(navContainer, {
    label: '<i class="fa-solid fa-arrow-right"></i>',
    className: 'control_panel_btn'
});


/* Brush Controls */

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

/* Other Controls */
const otherControlsContainer = document.getElementById('brush-controls');

const clearBtn = new Button(otherControlsContainer, {
    id: 'clear-annotations',
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-broom"></i>'
});


/* Display Controls */
const displayControls = document.getElementById('display-controls');

const infoBtn = new Button(displayControls, {
    id: 'info-btn',
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-info"></i>',
});

const uploadBtn = new Button(displayControls, {
    id: 'upload-btn',
    className: 'control_panel_btn',
    label: '<i class="fa-solid fa-upload"></i>',
});

const displayTog = new Toggle(displayControls, {
    id: 'show-lan-url',
    className: 'control_panel_btn',
    iconClass: 'fa-solid fa-eye',
    initialState: false
});


const ann_canvas_container = document.getElementById('ann-canvas');
const annCvs = new Canvas(ann_canvas_container);
const slide_canvas_container = document.getElementById('pdf-canvas');
const pdfCvs = new Canvas(slide_canvas_container, false);


/* ----------------------
   Tool Buttons
---------------------- */
hand.onClick(() => annCvs.setPointerMode('hand'));
pen.onClick(() => annCvs.setPointerMode('draw'));
highlighter.onClick(() => annCvs.setPointerMode('highlight'));
eraser.onClick(() => annCvs.setPointerMode('erase'));

function onToolSelected(selected) {
    console.log("Selected tool:", selected);

    if (selected === pen) annCvs.setPointerMode('draw');
    else if (selected === highlighter) annCvs.setPointerMode('highlight');
    else if (selected === eraser) annCvs.setPointerMode('erase');
}

toolSelector.buttons.forEach(item => {
    item.el.addEventListener('click', () => onToolSelected(item));
});

/* ----------------------
   Color Swatches
---------------------- */
colorBtns.forEach(btn => {
  btn.onClick(() => {
    annCvs.setStrokeColor(getComputedStyle(btn.el).backgroundColor);
  });
});

/* ----------------------
   Navigation Buttons
---------------------- */

/* ----------------------
   Brush Controls
---------------------- */
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

/* ----------------------
   Clear Button
---------------------- */
clearBtn.onClick(() => annCvs.clear());

/* ----------------------
   Display Toggle
---------------------- */

/* ----------------------
   Upload Button
---------------------- */
const fileInput = document.getElementById("upload-zip");
uploadBtn.onClick(() => {
    fileInput.click();
});


let zipFile = null;
let config = null;
let resources = { videos: {}, audio: {}, models: {}, slides: {} };
let annotations = {};
let currentSlide = 0

fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    zipFile = await JSZip.loadAsync(arrayBuffer);

    // --- Load config.json ---
    const configFile = zipFile.file("config.json");
    if (!configFile) {
        console.error("No config.json found in ZIP!");
        return;
    }

    const configText = await configFile.async("string");
    config = JSON.parse(configText);
    console.log("Loaded config:", config);

    // --- Preload all resources into memory ---
    // Videos
    for (const [id, path] of Object.entries(config.resources.videos)) {
        const blob = await zipFile.file(path).async("blob");
        resources.videos[id] = URL.createObjectURL(blob);
    }

    // Audio
    for (const [id, path] of Object.entries(config.resources.audio)) {
        const blob = await zipFile.file(path).async("blob");
        resources.audio[id] = URL.createObjectURL(blob);
    }

    // Models
    for (const [id, path] of Object.entries(config.resources.models)) {
        const blob = await zipFile.file(path).async("blob");
        resources.models[id] = URL.createObjectURL(blob);
    }

    // Slides
    const pdfFile = zipFile.file("slides.pdf");
    if (!pdfFile) {
        console.error("slides.pdf not found in ZIP!");
    } else {
        const pdfData = await pdfFile.async("arraybuffer");
        const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const numPages = pdfDoc.numPages;

        for (let i = 1; i <= numPages; i++) {  // PDF.js pages are 1-based
            const page = await pdfDoc.getPage(i);
            resources.slides[i-1] = page;
        }

        console.log("All resources loaded:", resources);

        await renderSlide(currentSlide);
        const pdfImage = pdfCvs.canvas.toDataURL("image/png");
        socket.emit('slide_event', {
            slide: pdfImage
        });
    }

});


async function renderSlide(slideIndex) {
    // --- Render PDF page on pdfCanvas ---
    await pdfCvs.renderPDFPage(resources.slides[slideIndex]);

    // --- Add video elements ---
    [...slide_canvas_container.querySelectorAll("video")].forEach(v => v.remove());
    [...slide_canvas_container.querySelectorAll("model-viewer")].forEach(m => m.remove());
    [...slide_canvas_container.querySelectorAll("audio")].forEach(a => a.remove());

    config.slides[slideIndex].videos.forEach(v => {
        const videoURL = resources.videos[v.id];
        const video = document.createElement("video");
        video.src = videoURL;
        video.style.position = "absolute";
        video.style.left = `${v.x * pdfCvs.canvas.width}px`;
        video.style.top = `${v.y * pdfCvs.canvas.height}px`;
        video.style.width = `${v.width * pdfCvs.canvas.width}px`;
        video.style.height = `${v.height * pdfCvs.canvas.height}px`;
        video.style.zIndex = v.zIndex;
        video.volume = v.volume;
        video.muted = true;
        video.playbackRate = v.playbackRate;
        video.addEventListener("click", () => video.play());
        if (v.playMode === "once") {
            video.autoplay = true;
        }

        if (v.playMode === "loop") {
            video.autoplay = true;
            video.loop = true;
        }
        video.controls = false;

        // attach to pdfCanvas container
        slide_canvas_container.appendChild(video);
    });

    // --- Add model elements ---
    config.slides[slideIndex].models.forEach(m => {
        const modelURL = resources.models[m.id];

        const mv = document.createElement("model-viewer");
        mv.src = modelURL;
        mv.alt = m.alt || "3D model";
        mv.setAttribute("shadow-intensity", "1");
        mv.setAttribute("camera-controls", "");

        // absolute positioning
        mv.style.position = "absolute";
        mv.style.left = `${m.x * pdfCvs.canvas.width}px`;
        mv.style.top = `${m.y * pdfCvs.canvas.height}px`;
        mv.style.width = `${m.width * pdfCvs.canvas.width}px`;
        mv.style.height = `${m.height * pdfCvs.canvas.height}px`;
        mv.style.zIndex = m.zIndex;

        // attach to container
        slide_canvas_container.appendChild(mv);
    });


    // --- Add audio elements ---
    config.slides[slideIndex].audio.forEach(a => {
        const audioURL = resources.audio[a.id];
        const audio = document.createElement("audio");
        audio.src = audioURL;
        audio.volume = a.volume;
        if (a.playMode === "auto") audio.play();
        slide_canvas_container.appendChild(audio);
    });

    if (annotations[slideIndex]) {
        annCvs.add_annotations(annotations[slideIndex]);
    } else {
        annCvs.clear();
    }
}

prevBtn.onClick(async () => {
    if (currentSlide > 0) {

        annotations[currentSlide] = annCvs.get_annotations();
        currentSlide--;
        await renderSlide(currentSlide);
        const pdfImage = pdfCvs.canvas.toDataURL("image/png");
        socket.emit('slide_event', {
            slide: pdfImage
        });
    }
});

nextBtn.onClick(async () => {
    if (currentSlide < config.slides.length - 1) {
        annotations[currentSlide] = annCvs.get_annotations();
        currentSlide++;
        await renderSlide(currentSlide);

        const pdfImage = pdfCvs.canvas.toDataURL("image/png");
        socket.emit('slide_event', {
            slide: pdfImage
        });
    }
});

});
