// Edit-mode overlays — the draggable/resizable boxes drawn over each media
// item and widget on the current slide, plus the add-media file picking.
// Circular import note: this module and properties.js call into each other
// (select → update panel; delete → re-render overlays). Both only export
// functions called after load, so the cycle is harmless.
import { ctx, getSlideEl, getOrCreateConfig, getConfigItems, arrKeyForType } from './context.js';
import { updatePropertiesPanel, syncPropertiesPosition } from './properties.js';
import { openWidgetSettings, widgetHasSettings } from './widget-settings.js';

let _pendingMediaType = null;

/* ─── render ────────────────────────────────────────────────── */

export function renderEditOverlays() {
    const container = getSlideEl();
    if (!container) return;
    const cfg = getOrCreateConfig();
    if (!cfg) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;
    getConfigItems(cfg).forEach(({ type, arrKey, item, index }) =>
        container.appendChild(buildOverlay(type, arrKey, item, index, container, rect)));
}

function buildOverlay(type, arrKey, item, index, container, rect) {
    const div = document.createElement('div');
    div.className = 'edit-overlay';
    div.dataset.arrKey = arrKey;
    div.dataset.itemIndex = String(index);
    positionOverlay(div, item, rect);

    const label = document.createElement('div');
    label.className = 'edit-overlay-label';
    const name = item.path ? item.path.split('/').pop() : (item.type || `${type} ${index + 1}`);
    label.textContent = name;
    div.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'edit-resize-handle';
    div.appendChild(handle);

    if (arrKey === 'widgets') div.appendChild(buildOverlayGear(div, arrKey, index, item));

    handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        selectOverlayEl(div, arrKey, index);
        startResize(e, div, handle, arrKey, index, container);
    });
    div.addEventListener('pointerdown', (e) => {
        if (e.target === handle) return;
        selectOverlayEl(div, arrKey, index);
        startMove(e, div, arrKey, index, container);
    });
    return div;
}

const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

// A widget's settings belong to the widget — the overlay carries only the
// affordance. Clicking it asks the widget to show its own panel. Hidden until
// the widget announces it has one (see widget-settings.js), so widgets with
// nothing to configure don't sprout a dead button.
function buildOverlayGear(div, arrKey, index, item) {
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'edit-overlay-gear';
    gear.title = 'Widget settings';
    gear.dataset.widgetId = String(item.id ?? '');
    gear.innerHTML = GEAR_SVG;
    gear.hidden = !widgetHasSettings(item.id);
    // Keep the press off the overlay's drag handler.
    gear.addEventListener('pointerdown', e => e.stopPropagation());
    gear.addEventListener('click', e => {
        e.stopPropagation();
        selectOverlayEl(div, arrKey, index);
        openWidgetSettings(item.id);
    });
    return gear;
}

export function positionOverlay(div, item, rect) {
    Object.assign(div.style, {
        left:   `${(item.x      ?? 0.1) * rect.width}px`,
        top:    `${(item.y      ?? 0.1) * rect.height}px`,
        width:  `${(item.width  ?? 0.4) * rect.width}px`,
        height: `${(item.height ?? 0.3) * rect.height}px`,
    });
}

export function selectOverlayEl(div, arrKey, index) {
    document.querySelectorAll('.edit-overlay.selected').forEach(el => el.classList.remove('selected'));
    div.classList.add('selected');
    ctx.selectedOverlay = { div, arrKey, index };
    updatePropertiesPanel();
}

// Clear the selection and return the panel to the slide's own properties.
export function deselectOverlay() {
    if (!ctx.selectedOverlay) return;
    document.querySelectorAll('.edit-overlay.selected').forEach(el => el.classList.remove('selected'));
    ctx.selectedOverlay = null;
    updatePropertiesPanel();
}

export function cleanupEditOverlays() {
    document.querySelectorAll('.edit-overlay').forEach(el => el.remove());
}

/* ─── drag-to-move ──────────────────────────────────────────── */

function startMove(e, div, arrKey, index, container) {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const dr = div.getBoundingClientRect();
    const offX = e.clientX - dr.left;
    const offY = e.clientY - dr.top;

    const onMove = (e) => {
        const cr = container.getBoundingClientRect();
        div.style.left = `${Math.max(0, Math.min(cr.width  - div.offsetWidth,  e.clientX - cr.left - offX))}px`;
        div.style.top  = `${Math.max(0, Math.min(cr.height - div.offsetHeight, e.clientY - cr.top  - offY))}px`;
    };
    const onUp = () => {
        const cr = container.getBoundingClientRect();
        const item = getOrCreateConfig()?.[arrKey]?.[index];
        if (item) {
            item.x = parseFloat(div.style.left) / cr.width;
            item.y = parseFloat(div.style.top)  / cr.height;
        }
        syncPropertiesPosition();
        div.releasePointerCapture(e.pointerId);
        div.removeEventListener('pointermove', onMove);
        div.removeEventListener('pointerup',   onUp);
    };
    div.addEventListener('pointermove', onMove);
    div.addEventListener('pointerup',   onUp);
}

/* ─── resize — aspect ratio locked for video/model ──────────── */

function startResize(e, div, handle, arrKey, index, container) {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const startW = div.offsetWidth, startH = div.offsetHeight;
    const lockAR = arrKey === 'videos' || arrKey === 'models';
    const ar     = startW / startH;

    const onMove = (e) => {
        const newW = Math.max(40, startW + (e.clientX - startX));
        const newH = lockAR ? newW / ar : Math.max(30, startH + (e.clientY - startY));
        div.style.width  = `${newW}px`;
        div.style.height = `${newH}px`;
    };
    const onUp = () => {
        const cr = container.getBoundingClientRect();
        const item = getOrCreateConfig()?.[arrKey]?.[index];
        if (item) {
            item.width  = div.offsetWidth  / cr.width;
            item.height = div.offsetHeight / cr.height;
        }
        syncPropertiesPosition();
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup',   onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
}

/* ─── add media (video / audio / 3D model) ──────────────────── */

export function pickMediaFile(type, accept) {
    _pendingMediaType = type;
    const fi = document.getElementById('edit-media-input');
    if (!fi) return;
    fi.accept = accept;
    fi.value  = '';
    fi.click();
}

export async function onMediaFileSelected(fileInput) {
    const file = fileInput.files?.[0];
    if (!file || !_pendingMediaType) return;
    const type = _pendingMediaType;
    _pendingMediaType = null;

    const folder = type === 'model' ? 'models' : type;
    const path   = `${folder}/${file.name}`;
    ctx.state.editorNewFiles[path] = await file.arrayBuffer();
    ctx.state.mediaCache[path]     = URL.createObjectURL(file);

    const arrKey = arrKeyForType(type);
    const cfg    = getOrCreateConfig();
    if (!cfg) return;
    if (!cfg[arrKey]) cfg[arrKey] = [];

    const newItem = { path, x: 0.25, y: 0.25, width: 0.5, height: 0.5, zIndex: 5 };
    if (type === 'video') { newItem.playMode = 'click'; newItem.volume = 1; }
    if (type === 'audio') { newItem.playMode = 'click'; }

    cfg[arrKey].push(newItem);
    const newIndex = cfg[arrKey].length - 1;

    cleanupEditOverlays();
    renderEditOverlays();

    const overlay = document.querySelector(`.edit-overlay[data-arr-key="${arrKey}"][data-item-index="${newIndex}"]`);
    if (overlay) selectOverlayEl(overlay, arrKey, newIndex);
}
