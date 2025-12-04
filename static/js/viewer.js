// static/viewer.js
import { Canvas } from './canvas.js';


const socket = io();

// Canvas wrappers
const pdfContainer = document.getElementById("pdf-canvas");
const annContainer = document.getElementById("ann-canvas");

const pdfCvs = new Canvas(pdfContainer, false);  // no drawing in viewer
const annCvs = new Canvas(annContainer, false);  // no drawing in viewer


// --- Slide update ---
socket.on('slide_event', ({ slide  }) => {
    const pdfImg = new Image();
    pdfImg.onload = () => {
        const ctx = pdfCvs.canvas.getContext('2d');
        ctx.clearRect(0, 0, pdfCvs.canvas.width, pdfCvs.canvas.height);
        ctx.drawImage(pdfImg, 0, 0, pdfCvs.canvas.width, pdfCvs.canvas.height);
    };
    pdfImg.src = slide;

    const ctxAnn = annCvs.canvas.getContext('2d');
    ctxAnn.clearRect(0, 0, annCvs.canvas.width, annCvs.canvas.height);
});

socket.on('ann_event', ({ ann }) => {
    const annImg = new Image();
    annImg.onload = () => {
        const ctx = annCvs.canvas.getContext('2d');
        ctx.clearRect(0, 0, annCvs.canvas.width, annCvs.canvas.height);
        ctx.drawImage(annImg, 0, 0, annCvs.canvas.width, annCvs.canvas.height);
    };
    annImg.src = ann;
});


function resizeCanvasTo4by3(canvas) {
    const container = canvas.parentElement;
    const maxHeight = container.clientHeight;
    const maxWidth = container.clientWidth;

    maxHeight = '500px';

    // Calculate 4:3 dimensions that fit
    let height = maxHeight;
    let width = (4 / 3) * height;

    if (width > maxWidth) {
        width = maxWidth;
        height = (3 / 4) * width;
    }

    // Set canvas drawing buffer
    canvas.width = width;
    canvas.height = height;

    // Center the canvas inside container
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.left = `${(maxWidth - width) / 2}px`;
    canvas.style.top = `${(maxHeight - height) / 2}px`;
}

// Apply to both canvases
resizeCanvasTo4by3(pdfCvs.canvas);
resizeCanvasTo4by3(annCvs.canvas);

// Recalculate on window resize
window.addEventListener('resize', () => {
    resizeCanvasTo4by3(pdfCvs.canvas);
    resizeCanvasTo4by3(annCvs.canvas);
});

