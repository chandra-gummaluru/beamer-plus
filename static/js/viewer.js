// static/viewer.js
import { Timer } from './timer.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Selector } from './selector.js';
import { Toggle } from './Toggle.js';
import { Canvas } from './canvas.js';


// ------------------------------
// 1. Connect to the socket
// ------------------------------
const socket = io();

// Canvas wrappers (same class you already use)
const pdfContainer = document.getElementById("pdf-canvas");
const annContainer = document.getElementById("ann-canvas");

const pdfCvs = new Canvas(pdfContainer, false);  // no drawing
const annCvs = new Canvas(annContainer, false);  // no drawing

// Disable pointer events completely so viewer cannot edit
annContainer.style.pointerEvents = "none";

let pdfDoc = null;


// ------------------------------
// 2. Receive PDF on first load
// ------------------------------
// Your presenter page must send the PDF buffer once
socket.on("load_pdf", async (arrayBuffer) => {
    const loadingTask = pdfjsLib.getDocument(arrayBuffer);
    pdfDoc = await loadingTask.promise;
});

// ------------------------------
// 3. Sync slide navigation
// ------------------------------
socket.on("slide_changed", async (slideIndex) => {
    if (!pdfDoc) return;

    const page = await pdfDoc.getPage(slideIndex + 1);

    // 1. Get actual PDF page size (unscaled)
    const unscaled = page.getViewport({ scale: 1 });

    // 2. Fit height to viewer
    const containerHeight = pdfContainer.clientHeight;
    const scale = containerHeight / unscaled.height;

    const viewport = page.getViewport({ scale });

    // 3. Resize canvases to match PDF
    pdfCvs.resize(viewport.width, viewport.height);
    annCvs.resize(viewport.width, viewport.height);

    // 4. Render PDF
    await page.render({
        canvasContext: pdfCvs.ctx,
        viewport
    }).promise;

    // 5. Reset annotation layer
    annCvs.clear();
});


// ------------------------------
// 4. Sync annotations in real time
// ------------------------------
socket.on("annotation_event", (data) => {
    // `data` should be the same object the presenter page sends:
    // { slide: number, strokes: [...] } OR { type: 'erase', ... } etc.

    annCvs.apply_remote_event(data);
});
