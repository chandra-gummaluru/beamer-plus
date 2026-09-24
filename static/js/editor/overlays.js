// Edit-mode overlays — the draggable/resizable boxes drawn over each media
// item and widget on the current slide, plus the add-media file picking.
// Circular import note: this module and properties.js call into each other
// (select → update panel; delete → re-render overlays). Both only export
// functions called after load, so the cycle is harmless.
import { ctx, getSlideEl, getOrCreateConfig, getConfigItems, arrKeyForType } from './context.js';
import { updatePropertiesPanel, syncPropertiesPosition, openWidgetSettingsFor, widgetTypeLabel } from './properties.js';

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
    // Same name the slide's item list uses: a widget's own Name, else its type.
    const name = item.path ? item.path.split('/').pop()
               : arrKey === 'widgets' ? (item.title || widgetTypeLabel(item))
               : (item.type || `${type} ${index + 1}`);
    label.textContent = name;
    div.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'edit-resize-handle';
    div.appendChild(handle);

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
    // A widget is configured in its settings dialog; a double-click is the
    // shortest way there from the slide.
    if (arrKey === 'widgets') {
        div.addEventListener('dblclick', (e) => {
            if (e.target === handle) return;
            openWidgetSettingsFor(index);
        });
    }
    return div;
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
