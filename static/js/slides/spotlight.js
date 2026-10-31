// Spotlight tool — dims the slide except a circle following the pointer.
// Also owns widget pointer-events while the spotlight is active (widgets must
// not swallow pointer moves, or the spotlight would freeze over them).
import { bus } from '../core/events.js';

let _state = null;

// Last non-spotlight tool, restored when the user clicks to leave spotlight.
let _prevTool = 'hand';
bus.on('tool:change', (tool) => {
    if (tool !== 'spotlight') _prevTool = tool;
});

export function setWidgetInteractivityForSpotlight(spotlightActive) {
    const widgets = document.querySelectorAll('.widget-iframe');
    widgets.forEach((iframe) => {
        // A parked widget (off screen, opacity 0) stays out of the pointer's
        // way: it is still laid over the stage — a split widget's frame
        // covers it whole — and taking clicks would block the slide showing.
        if (spotlightActive || iframe.style.opacity === '0') {
            iframe.style.pointerEvents = 'none';
            return;
        }
        const interactive = iframe.dataset.widgetInteractive !== 'false';
        iframe.style.pointerEvents = interactive ? 'auto' : 'none';
    });
}

export function initSpotlight(state) {
    _state = state;
    ensureSpotlightOverlay('left');
    ensureSpotlightOverlay('right');

    document.addEventListener('pointermove', (event) => {
        if (_state.annotationTool !== 'spotlight') return;
        const pane = getSpotlightPaneFromPoint(event.clientX, event.clientY);
        if (!pane) {
            hideSpotlight(true);
            return;
        }

        const paneName = pane.id === 'pdf-container-2' ? 'right' : 'left';
        const rect = pane.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        _state.spotlight = {
            visible: true,
            pane: paneName,
            x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        };

        renderSpotlight();
    }, true);

    document.addEventListener('pointerleave', () => {
        if (_state.annotationTool === 'spotlight') hideSpotlight(true);
    });

    document.addEventListener('click', (event) => {
        if (_state.annotationTool !== 'spotlight') return;
        // Restore the previous tool
        const prev = _prevTool || 'hand';
        const btn = document.querySelector(`#tool-container .tool-btn[data-tool="${prev}"]`);
        document.querySelectorAll('#tool-container .tool-btn').forEach(b => b.classList.remove('btn_selected'));
        if (btn) btn.classList.add('btn_selected');
        bus.emit('tool:change', prev);
    }, true);
}

function getSpotlightPaneFromPoint(clientX, clientY) {
    const rightCanvas = document.getElementById('pdf-canvas-2');
    if (_state.splitView && rightCanvas) {
        const rightRect = rightCanvas.getBoundingClientRect();
        if (
            rightRect.width > 0 &&
            rightRect.height > 0 &&
            clientX >= rightRect.left && clientX <= rightRect.right &&
            clientY >= rightRect.top && clientY <= rightRect.bottom
        ) {
            return document.getElementById('pdf-container-2');
        }
    }

    const leftCanvas = document.getElementById('pdf-canvas');
    if (leftCanvas) {
        const leftRect = leftCanvas.getBoundingClientRect();
        if (
            leftRect.width > 0 &&
            leftRect.height > 0 &&
            clientX >= leftRect.left && clientX <= leftRect.right &&
            clientY >= leftRect.top && clientY <= leftRect.bottom
        ) {
            return document.getElementById('pdf-container');
        }
    }

    return null;
}

function ensureSpotlightOverlay(pane) {
    const container = document.getElementById(pane === 'right' ? 'pdf-container-2' : 'pdf-container');
    if (!container) return null;
    let overlay = container.querySelector('.spotlight-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'spotlight-overlay';
        container.appendChild(overlay);
    }
    _state.spotlightOverlays[pane] = overlay;
    return overlay;
}

export function renderSpotlight() {
    const left = ensureSpotlightOverlay('left');
    const right = ensureSpotlightOverlay('right');
    [left, right].forEach(overlay => overlay?.classList.remove('visible'));
    if (!_state.spotlight?.visible) return;
    const overlay = _state.spotlightOverlays[_state.spotlight.pane];
    if (!overlay) return;
    overlay.style.setProperty('--spotlight-x', `${_state.spotlight.x * 100}%`);
    overlay.style.setProperty('--spotlight-y', `${_state.spotlight.y * 100}%`);
    overlay.classList.add('visible');
}

export function hideSpotlight(force = false) {
    if (!_state.spotlight.visible && !force) return;
    _state.spotlight = { ..._state.spotlight, visible: false };
    renderSpotlight();
}
