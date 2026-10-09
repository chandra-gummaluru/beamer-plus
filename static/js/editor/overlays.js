// Edit-mode overlays — the draggable/resizable boxes drawn over each media
// item and widget on the current slide, plus the add-media file picking.
// Circular import note: this module and properties.js call into each other
// (select → update panel; delete → re-render overlays). Both only export
// functions called after load, so the cycle is harmless.
import { ctx, getSlideEl, getOrCreateConfig, getConfigItems, arrKeyForType } from './context.js';
import { updatePropertiesPanel, syncPropertiesPosition, widgetTypeLabel } from './properties.js';
import { getWidgetSchema, isPinnedFull } from './widget-schema.js';

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
    div.className = 'edit-overlay' + (arrKey === 'reveals' ? ' edit-overlay--reveal' : '');
    div.dataset.arrKey = arrKey;
    div.dataset.itemIndex = String(index);
    // Stacked as on stage, so where boxes overlap the front one takes the click.
    const z = parseInt(item.zIndex, 10);
    if (Number.isFinite(z)) div.style.zIndex = String(50 + z);
    positionOverlay(div, item, rect);

    const label = document.createElement('div');
    label.className = 'edit-overlay-label';
    // Same name the slide's item list uses: a widget's own Name, else its type.
    const name = item.path ? item.path.split('/').pop()
               : arrKey === 'widgets' ? (item.title || widgetTypeLabel(item))
               : (item.type || `${type} ${index + 1}`);
    label.textContent = overlayLabel(arrKey, item, name);
    div.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'edit-resize-handle';
    div.appendChild(handle);

    // A widget has no properties panel: clicking one opens its settings
    // dialog, while dragging it (or its handle) still moves or resizes it —
    // without selecting it, so the panel stays on the slide. Media items are
    // selected as before and edited in the panel.
    const isWidget = arrKey === 'widgets';
    const grab = () => selectOverlayEl(div, arrKey, index);
    handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        grab();
        startResize(e, div, handle, arrKey, index, container);
    });
    div.addEventListener('pointerdown', (e) => {
        if (e.target === handle) return;
        grab();
        startMove(e, div, arrKey, index, container);
    });

    // A widget shown full (and every full-slide-only one: notebook,
    // workspace, circuit simulator) is pinned to the whole slide, without the
    // move/resize affordances. A click still opens the widget's settings.
    if (isWidget) {
        getWidgetSchema(item).then(schema => {
            if (div.isConnected) syncWidgetLock(div, item, schema, container);
        });
    }
    return div;
}

/** Pin or free a widget's box for how it is shown now (full or overlay). */
export function syncWidgetLock(div, item, schema, container = getSlideEl()) {
    const pinned = isPinnedFull(item, schema);
    if (pinned) Object.assign(item, { x: 0, y: 0, width: 1, height: 1 });
    div.dataset.locked = pinned ? 'true' : 'false';
    div.classList.toggle('edit-overlay--locked', pinned);
    const handle = div.querySelector('.edit-resize-handle');
    if (handle) handle.hidden = pinned;
    const cr = container?.getBoundingClientRect();
    if (cr) positionOverlay(div, item, cr);
}

// What a box on the slide is called, plus its reveal step if it has one.
export function overlayLabel(arrKey, item, name) {
    const step = parseInt(item?.step, 10);
    if (arrKey === 'reveals') return `Reveal · step ${step > 0 ? step : 1}`;
    return step > 0 ? `${name} · step ${step}` : name;
}

/* ─── reveal boxes ──────────────────────────────────────────── */
// A box that hides what's under it until its step is reached while
// presenting (slides/reveals.js). New boxes take the next step number.
export function addReveal() {
    const cfg = getOrCreateConfig();
    if (!cfg) return;
    if (!cfg.reveals) cfg.reveals = [];
    const used = getConfigItems(cfg).map(e => parseInt(e.item.step, 10) || 0);
    const step = Math.max(0, ...used) + 1;
    cfg.reveals.push({ id: `reveal_${Date.now()}`, x: 0.25, y: 0.4, width: 0.5, height: 0.25, step, style: 'blend', zIndex: 4 });
    const index = cfg.reveals.length - 1;
    cleanupEditOverlays();
    renderEditOverlays();
    const overlay = document.querySelector(`.edit-overlay[data-arr-key="reveals"][data-item-index="${index}"]`);
    if (overlay) selectOverlayEl(overlay, 'reveals', index);
}

/** Move every edit box to its item's place — after the stage changed size. */
export function repositionEditOverlays() {
    const container = getSlideEl();
    const cfg = getOrCreateConfig();
    const rect = container?.getBoundingClientRect();
    if (!cfg || !rect?.width) return;
    document.querySelectorAll('.edit-overlay').forEach(div => {
        const item = cfg[div.dataset.arrKey]?.[parseInt(div.dataset.itemIndex, 10)];
        if (item) positionOverlay(div, item, rect);
    });
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

// `onEnd(moved)` runs on release; `moved` is false for a plain click (the
// pointer never travelled more than a few pixels), which a widget treats as
// "open my settings".
function startMove(e, div, arrKey, index, container, onEnd) {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const dr = div.getBoundingClientRect();
    const offX = e.clientX - dr.left;
    const offY = e.clientY - dr.top;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;

    let targets = null;

    const onMove = (e) => {
        if (div.dataset.locked === 'true') return;   // pinned full-slide widget
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        moved = true;
        const cr = container.getBoundingClientRect();
        const w = div.offsetWidth, h = div.offsetHeight;
        let left = Math.max(0, Math.min(cr.width  - w, e.clientX - cr.left - offX));
        let top  = Math.max(0, Math.min(cr.height - h, e.clientY - cr.top  - offY));
        // Snap to the slide's edges and centre lines and to the other boxes'
        // edges and centres. Alt held: place freely.
        if (e.altKey) clearSnapGuides(container);
        else {
            targets ??= snapTargets(div, container, cr);
            const sx2 = snapAxis(left, w, targets.x), sy2 = snapAxis(top, h, targets.y);
            left = Math.max(0, Math.min(cr.width  - w, left + sx2.d));
            top  = Math.max(0, Math.min(cr.height - h, top  + sy2.d));
            drawSnapGuides(container, sx2.hits, sy2.hits);
        }
        div.style.left = `${left}px`;
        div.style.top  = `${top}px`;
    };
    const onUp = () => {
        clearSnapGuides(container);
        const cr = container.getBoundingClientRect();
        const item = getOrCreateConfig()?.[arrKey]?.[index];
        if (item && moved) {
            item.x = parseFloat(div.style.left) / cr.width;
            item.y = parseFloat(div.style.top)  / cr.height;
        }
        syncPropertiesPosition();
        div.releasePointerCapture(e.pointerId);
        div.removeEventListener('pointermove', onMove);
        div.removeEventListener('pointerup',   onUp);
        onEnd?.(moved);
    };
    div.addEventListener('pointermove', onMove);
    div.addEventListener('pointerup',   onUp);
}

/* ─── snap guides ───────────────────────────────────────────── */
// Lines a moving box's left / centre / right (and top / middle / bottom)
// pull to within SNAP_PX: the slide's edges and centre, and every other
// box's edges and centre. Snapped lines are drawn while dragging.

const SNAP_PX = 6;

function snapTargets(self, container, cr) {
    const x = [{ at: 0 }, { at: cr.width / 2, center: true }, { at: cr.width }];
    const y = [{ at: 0 }, { at: cr.height / 2, center: true }, { at: cr.height }];
    container.querySelectorAll('.edit-overlay').forEach(o => {
        if (o === self || o.dataset.locked === 'true') return;
        const r = o.getBoundingClientRect();
        if (!r.width) return;
        const l = r.left - cr.left, t = r.top - cr.top;
        x.push({ at: l }, { at: l + r.width / 2 }, { at: l + r.width });
        y.push({ at: t }, { at: t + r.height / 2 }, { at: t + r.height });
    });
    return { x, y };
}

// Best shift `d` along one axis, and every target line the box then sits on.
function snapAxis(pos, size, targets) {
    const offs = [0, size / 2, size];
    let best = null;
    for (const t of targets) for (const o of offs) {
        const d = t.at - (pos + o);
        if (Math.abs(d) <= SNAP_PX && (!best || Math.abs(d) < Math.abs(best))) best = d;
    }
    const d = best ?? 0;
    const hits = best == null ? [] : targets.filter(t => offs.some(o => Math.abs(t.at - (pos + d + o)) < 0.5));
    return { d, hits };
}

function drawSnapGuides(container, xs, ys) {
    clearSnapGuides(container);
    const line = (dir, t) => {
        const g = document.createElement('div');
        g.className = `edit-snap-guide edit-snap-guide--${dir}` + (t.center ? ' edit-snap-guide--center' : '');
        g.style[dir === 'v' ? 'left' : 'top'] = `${t.at}px`;
        container.appendChild(g);
    };
    const seen = new Set();
    for (const t of xs) { const k = 'v' + Math.round(t.at); if (!seen.has(k)) { seen.add(k); line('v', t); } }
    for (const t of ys) { const k = 'h' + Math.round(t.at); if (!seen.has(k)) { seen.add(k); line('h', t); } }
}

function clearSnapGuides(container) {
    container.querySelectorAll('.edit-snap-guide').forEach(g => g.remove());
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
