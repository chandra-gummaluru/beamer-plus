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

