import { Timer } from './timer.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Selector } from './selector.js';
import { Toggle } from './Toggle.js';
import { Canvas } from './canvas.js';


const timerContainer = document.getElementById("timer-container");
const timer = new Timer(timerContainer);

const toolContainer = document.getElementById('tool-container');

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

const toolSelector = new Selector([pen, highlighter, eraser], 'control_panel_btn_selected');


const colors = ['#eeeeee', '#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#333333'];
const colorContainer = document.getElementById('color-picker');

// Create buttons for each color
const buttons = colors.map(color => {
    const btn = new Button(colorContainer, {
        className: 'color-swatch',
    });
    btn.el.style.background = color;
    return btn;
});

// Use Selector to manage selection
const colorSelector = new Selector(buttons, 'color-selected');

// Optionally, select default color
colorSelector.select(buttons[0]);

// Get current color:
console.log(colorSelector.getSelected().el.style.background);

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
    initial: '5'
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



/* ----------------------
   Tool Buttons
---------------------- */
pen.onClick(() => annCvs.setPointerMode('draw'));
highlighter.onClick(() => annCvs.setPointerMode('highlight'));
eraser.onClick(() => annCvs.setPointerMode('eraser'));

function onToolSelected(selected) {
    console.log("Selected tool:", selected);

    if (selected === pen) annCvs.setPointerMode('draw');
    else if (selected === highlighter) annCvs.setPointerMode('highlight');
    else if (selected === eraser) annCvs.setPointerMode('eraser');
}

toolSelector.items.forEach(item => {
    item.el.addEventListener('click', () => onToolSelected(item));
});

/* ----------------------
   Color Swatches
---------------------- */
/*
colorSelector.onSelect(btn => {
    annCvs.setColor(btn.el.style.background);
    console.log('Selected color:', btn.el.style.background);
});
*/

/* ----------------------
   Navigation Buttons
---------------------- */
prevBtn.onClick(() => updateSlide(-1));
nextBtn.onClick(() => updateSlide(1));

/* ----------------------
   Brush Controls
---------------------- */
brushMinusBtn.onClick(() => {
    let val = parseInt(brushSizeLbl.get());
    if (val > 1) val--;
    brushSizeLbl.set(String(val));
    annCvs.setBrushSize(val);
});

brushPlusBtn.onClick(() => {
    let val = parseInt(brushSizeLbl.get());
    if (val < 9) val++;
    brushSizeLbl.set(String(val));
    annCvs.setBrushSize(val);
    console.log("test");
});

/* ----------------------
   Clear Button
---------------------- */
clearBtn.onClick(() => annCvs.clear());

/* ----------------------
   Display Toggle
---------------------- */
/*
displayTog.onToggle(async state => {
    const display = document.getElementById('lan-url');
    displayTog.el.disabled = true;

    const url = state ? '/enable_lan' : '/disable_lan';
    try {
        await fetch(url, { method: 'POST' });

        if (state) {
            const res = await fetch('/local_ip');
            const { ip } = await res.json();
            display.innerHTML = `<a href="http://${ip}:5000/viewer" style="color:white">${ip}:5000/viewer</a>`;
        } else {
            display.textContent = '';
        }
    } catch (err) {
        console.error('Toggle LAN failed', err);
    } finally {
        displayTog.el.disabled = false;
    }
});
*/

