// Properties panel — position, size and z-index for the selected media
// overlay (video, audio, 3D model), plus the type-specific fields Beamer+
// itself owns: video play mode, audio play mode, model animation. Every
// change is applied to the in-memory config immediately. Also builds the
// slide properties' item list (refreshSlideItems).
//
// A selected widget shows its settings in the same panel (widget-panel.js;
// form from widget-fields.js, fields read from the widget's own
// `widget-schema` block — see widget-schema.js): selected by clicking it on
// the slide, by Edit in the slide's item list, and straight after adding it.
import { ctx, getSlideEl, getOrCreateConfig, escAttr, setPanelMode, setPanelTitle,
         resolvePanelMode } from './context.js';
import { cleanupEditOverlays, renderEditOverlays, positionOverlay, selectOverlayEl, overlayLabel, syncWidgetLock } from './overlays.js';
import { WIDGET_LABELS } from './widget-picker.js';
import { getWidgetSchema } from './widget-schema.js';
import { renderWidgetPanel } from './widget-panel.js';

export function updatePropertiesPanel() {
    const panel = document.getElementById('editor-properties');
    if (!panel) return;
    // Nothing selected — hand the panel back to the slide (or view) section.
    if (!ctx.selectedOverlay) {
        _widgetShown = null;
        setPanelMode(resolvePanelMode()); refreshSlideItems(); return;
    }
    if (ctx.selectedOverlay.arrKey === 'widgets') { showWidgetPanel(ctx.selectedOverlay.index); return; }
    _widgetShown = null;
    setPanelMode('item');

    const { arrKey, index } = ctx.selectedOverlay;
    const cfg  = getOrCreateConfig();
    const item = cfg?.[arrKey]?.[index];
    if (!item) return;

    const typeLabels = { videos: 'Video', audios: 'Audio', models: '3D Model', reveals: 'Reveal' };
    setPanelTitle(`${typeLabels[arrKey] || arrKey} Properties`);

    const body = document.getElementById('editor-properties-body');
    if (!body) return;
    body.innerHTML = buildPropsHTML(arrKey, item);

    // Delete button
    body.querySelector('#prop-delete')?.addEventListener('click', () => deleteItem(arrKey, index));

    // AR lock: W drives H for video/model
    if (arrKey === 'videos' || arrKey === 'models') {
        const ar = (item.width ?? 0.4) / (item.height ?? 0.3);
        document.getElementById('prop-w')?.addEventListener('input', () => {
            const w = parseFloat(document.getElementById('prop-w')?.value ?? '0');
            const hEl = document.getElementById('prop-h');
            if (!isNaN(w) && hEl) hEl.value = Math.round(w / ar);
        });
    }

    // Auto-apply every change immediately. Property assignment (not
    // addEventListener) because #editor-properties-body persists across panel
    // refreshes — addEventListener here would stack a new listener per refresh.
    body.oninput  = () => applyPropertiesQuiet();
    body.onchange = () => applyPropertiesQuiet();
}

function buildPropsHTML(arrKey, item) {
    const lockAR = arrKey === 'videos' || arrKey === 'models';

    let html = `
        <div class="editor-prop-row">
            <div class="editor-prop-label">Position</div>
            <div class="editor-prop-row-2col">
                <div><div class="editor-prop-label">X (%)</div>
                <input class="editor-prop-input" type="number" min="0" max="100" step="1" id="prop-x" value="${Math.round((item.x ?? 0) * 100)}"></div>
                <div><div class="editor-prop-label">Y (%)</div>
                <input class="editor-prop-input" type="number" min="0" max="100" step="1" id="prop-y" value="${Math.round((item.y ?? 0) * 100)}"></div>
            </div>
        </div>
        <div class="editor-prop-row">
            <div class="editor-prop-label">Size</div>
            <div class="editor-prop-row-2col">
                <div><div class="editor-prop-label">W (%)</div>
                <input class="editor-prop-input" type="number" min="1" max="100" step="1" id="prop-w" value="${Math.round((item.width  ?? 0.4) * 100)}"></div>
                <div><div class="editor-prop-label">H (%)</div>
                <input class="editor-prop-input" type="number" min="1" max="100" step="1" id="prop-h" value="${Math.round((item.height ?? 0.3) * 100)}"${lockAR ? ' readonly' : ''}></div>
            </div>
        </div>
    `;

    if (arrKey === 'reveals') {
        html += `
            <div class="editor-prop-row">
                <div class="editor-prop-label">Reveal on step</div>
                <input class="editor-prop-input" type="number" min="1" max="99" step="1" id="prop-step" value="${parseInt(item.step, 10) || 1}">
            </div>
            <div class="editor-prop-row">
                <div class="editor-prop-label">Look while hidden</div>
                <select class="editor-prop-select" id="prop-revealStyle">
                    <option value="blend"   ${(item.style ?? 'blend') === 'blend' ? 'selected' : ''}>Blend into slide</option>
                    <option value="frosted" ${item.style === 'frosted' ? 'selected' : ''}>Frosted panel</option>
                </select>
            </div>
        `;
    } else {
        html += `
            <div class="editor-prop-row">
                <div class="editor-prop-label">Appear on step</div>
                <input class="editor-prop-input" type="number" min="1" max="99" step="1" id="prop-step" placeholder="—" value="${parseInt(item.step, 10) > 0 ? parseInt(item.step, 10) : ''}">
            </div>
        `;
    }

    if (arrKey === 'videos') {
        html += `
            <div class="editor-prop-row">
                <div class="editor-prop-label">Play Mode</div>
                <select class="editor-prop-select" id="prop-playMode">
                    <option value="click"  ${(item.playMode ?? 'click') === 'click'  ? 'selected' : ''}>Click to play</option>
                    <option value="auto"   ${item.playMode === 'auto'   ? 'selected' : ''}>Auto (once, muted)</option>
                    <option value="loop"   ${item.playMode === 'loop'   ? 'selected' : ''}>Loop (muted)</option>
                    <option value="manual" ${item.playMode === 'manual' ? 'selected' : ''}>Manual controls</option>
                    <option value="once"   ${item.playMode === 'once'   ? 'selected' : ''}>Once</option>
                </select>
            </div>
            <div class="editor-prop-row">
                <div class="editor-prop-label">Volume (0–1)</div>
                <input class="editor-prop-input" type="number" min="0" max="1" step="0.05" id="prop-volume" value="${item.volume ?? 1}">
            </div>
        `;
    } else if (arrKey === 'audios') {
        html += `
            <div class="editor-prop-row">
                <div class="editor-prop-label">Play Mode</div>
                <select class="editor-prop-select" id="prop-playMode">
                    <option value="click" ${(item.playMode ?? 'click') === 'click' ? 'selected' : ''}>Click to play</option>
                    <option value="auto"  ${item.playMode === 'auto'  ? 'selected' : ''}>Auto</option>
                    <option value="loop"  ${item.playMode === 'loop'  ? 'selected' : ''}>Loop</option>
                </select>
            </div>
        `;
    } else if (arrKey === 'models') {
        html += `
            <div class="editor-prop-row">
                <label class="editor-prop-checkbox-row">
                    <span>Auto-rotate</span>
                    <input type="checkbox" class="editor-switch" role="switch" id="prop-autoRotate" ${item.autoRotate ? 'checked' : ''}>
                </label>
            </div>
            <div class="editor-prop-row">
                <label class="editor-prop-checkbox-row">
                    <span>Play animation</span>
                    <input type="checkbox" class="editor-switch" role="switch" id="prop-animate" ${item.animate !== false ? 'checked' : ''}>
                </label>
            </div>
            <div class="editor-prop-row">
                <div class="editor-prop-label">Animation name (optional)</div>
                <input class="editor-prop-input" type="text" id="prop-animName" value="${escAttr(item.animationName ?? '')}">
            </div>
        `;
    }

    html += `
        <button class="btn editor-delete-btn" id="prop-delete" title="Remove this item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            Remove
        </button>
    `;

    return html;
}

export function syncPropertiesPosition() {
    const { arrKey, index } = ctx.selectedOverlay || {};
    if (!arrKey) return;
    if (arrKey === 'widgets') { _widgetShown?.panel?.refresh?.(); return; }
    const item = getOrCreateConfig()?.[arrKey]?.[index];
    if (!item) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('prop-x', Math.round((item.x      ?? 0)   * 100));
    set('prop-y', Math.round((item.y      ?? 0)   * 100));
    set('prop-w', Math.round((item.width  ?? 0.4) * 100));
    set('prop-h', Math.round((item.height ?? 0.3) * 100));
}

export function applyPropertiesQuiet() {
    const { arrKey, index, div } = ctx.selectedOverlay || {};
    if (!arrKey) return;
    const cfg  = getOrCreateConfig();
    const item = cfg?.[arrKey]?.[index];
    if (!item) return;

    const get = (id) => document.getElementById(id);
    const num = (id) => parseFloat(get(id)?.value ?? '0');

    item.x      = num('prop-x') / 100;
    item.y      = num('prop-y') / 100;
    item.width  = num('prop-w') / 100;
    item.height = num('prop-h') / 100;
    // Layering is the order of the slide's item list (drag to reorder), not a field.

    const step = parseInt(get('prop-step')?.value ?? '', 10);
    if (arrKey === 'reveals') {
        item.step  = step > 0 ? step : 1;
        item.style = get('prop-revealStyle')?.value || 'blend';
    } else if (step > 0) item.step = step;
    else delete item.step;

    if (arrKey === 'videos') {
        item.playMode = get('prop-playMode')?.value ?? 'click';
        item.volume   = num('prop-volume');
    } else if (arrKey === 'audios') {
        item.playMode = get('prop-playMode')?.value ?? 'click';
    } else if (arrKey === 'models') {
        item.autoRotate    = get('prop-autoRotate')?.checked ?? false;
        item.animate       = get('prop-animate')?.checked ?? true;
        item.animationName = get('prop-animName')?.value || undefined;
    }

    const container = getSlideEl();
    const cr = container?.getBoundingClientRect();
    if (div && cr) positionOverlay(div, item, cr);
    const label = div?.querySelector('.edit-overlay-label');
    if (label) label.textContent = overlayLabel(arrKey, item,
        item.path ? item.path.split('/').pop() : (item.type || arrKey));
}

export function deleteItem(arrKey, index) {
    const cfg = getOrCreateConfig();
    if (!cfg?.[arrKey]) return;
    cfg[arrKey].splice(index, 1);
    if (!cfg[arrKey].length) delete cfg[arrKey];
    if (ctx.selectedOverlay?.arrKey === arrKey && ctx.selectedOverlay?.index === index) ctx.selectedOverlay = null;
    cleanupEditOverlays();
    renderEditOverlays();
    updatePropertiesPanel();
}

export function widgetTypeLabel(item) {
    return WIDGET_LABELS[item.type]
        || (item.type || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        || 'Custom Widget';
}

/* ─── a widget's settings, in the panel ───────────────────────────── */

let _widgetShown = null;   // { item, panel } — what the panel is showing now
let _widgetToken = 0;      // the schema read is async; only the latest wins

/**
 * Select widget #index on the current slide: its box is marked on the slide
 * and the panel shows its settings.
 */
export function openWidgetSettingsFor(index) {
    const div = document.querySelector(`.edit-overlay[data-arr-key="widgets"][data-item-index="${index}"]`);
    if (div) { selectOverlayEl(div, 'widgets', index); return; }
    ctx.selectedOverlay = { div: null, arrKey: 'widgets', index };
    updatePropertiesPanel();
}

async function showWidgetPanel(index) {
    const item = getOrCreateConfig()?.widgets?.[index];
    if (!item) return;
    setPanelMode('widget', item.title || widgetTypeLabel(item));
    // Pressing on the same widget again (to drag it) keeps what's typed.
    if (_widgetShown?.item === item) return;
    const token = ++_widgetToken;
    _widgetShown = { item, panel: null };
    const schema = await getWidgetSchema(item);
    if (token !== _widgetToken) return;
    const host = document.getElementById('editor-widget-body');
    if (!host) return;
    const box = () => document.querySelector(`.edit-overlay[data-arr-key="widgets"][data-item-index="${index}"]`);
    _widgetShown.panel = renderWidgetPanel(host, item, schema || { label: null, fields: [], modes: ['full'] }, {
        // Keep the box on the slide in step with the Layout card.
        onLayout: () => {
            const div = box();
            if (!div) return;
            if (schema) { syncWidgetLock(div, item, schema); return; }
            const cr = getSlideEl()?.getBoundingClientRect();
            if (cr) positionOverlay(div, item, cr);
        },
        onName: () => {
            const name = item.title || widgetTypeLabel(item);
            setPanelTitle(name);
            const label = box()?.querySelector('.edit-overlay-label');
            if (label) label.textContent = overlayLabel('widgets', item, name);
        },
    });
}

/* ─── the slide properties' item list ─────────────────────────────── */

const ITEM_ICONS = {
    widgets: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    videos:  '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    audios:  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    reveals: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/><path d="M8 12h8"/><path d="M13 9l3 3-3 3"/>',
    models:  '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
};
const KIND_LABELS = { widgets: 'Widget', videos: 'Video', audios: 'Audio', models: '3D model', reveals: 'Reveal box' };
const ICON_EDIT  = '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>';
const ICON_TRASH = '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>';

function iconButton(cls, title, paths) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `slide-item-btn ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    return b;
}

/**
 * Rebuild the list of everything on the current slide, in the slide
 * properties section. Each row has Edit — a widget's settings dialog, or a
 * media item's properties — and Delete.
 */
export function refreshSlideItems() {
    const host = document.getElementById('editor-slide-items');
    if (!host) return;
    host.textContent = '';

    const cfg = getOrCreateConfig();
    const entries = [];
    for (const arrKey of ['widgets', 'videos', 'audios', 'models', 'reveals']) {
        (cfg?.[arrKey] || []).forEach((item, index) => entries.push({ arrKey, item, index }));
    }
    if (!entries.length) return;
    // Front to back: the list's order is the slide's stacking order.
    entries.sort((a, b) => layerOf(b) - layerOf(a));

    const head = document.createElement('div');
    head.className = 'slide-items-head';
    head.innerHTML = `<span>On this slide</span>${entries.length > 1 ? '<span class="slide-items-hint">Front to back · drag to reorder</span>' : ''}`;
    host.appendChild(head);

    const list = document.createElement('div');
    list.className = 'slide-items';
    for (const { arrKey, item, index } of entries) {
        const isWidget = arrKey === 'widgets';
        const step = parseInt(item.step, 10) > 0 ? parseInt(item.step, 10) : (arrKey === 'reveals' ? 1 : 0);
        const name = isWidget
            ? (item.title || widgetTypeLabel(item))
            : arrKey === 'reveals' ? `Reveal step ${step}`
            : (item.path ? item.path.split('/').pop() : `${KIND_LABELS[arrKey]} ${index + 1}`);
        const kind = (isWidget && item.title ? widgetTypeLabel(item) : KIND_LABELS[arrKey])
            + (step && arrKey !== 'reveals' ? ` · step ${step}` : '');

        const row = document.createElement('div');
        row.className = 'slide-item';
        row.innerHTML = `
            ${entries.length > 1 ? `<span class="slide-item-grip" aria-hidden="true"><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="11.5" r="1.3"/><circle cx="7.5" cy="11.5" r="1.3"/></svg></span>` : ''}
            <svg class="slide-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ITEM_ICONS[arrKey]}</svg>
            <span class="slide-item-text">
                <span class="slide-item-name"></span>
                <span class="slide-item-kind"></span>
            </span>`;
        row.querySelector('.slide-item-name').textContent = name;
        row.querySelector('.slide-item-kind').textContent = kind;

        const edit = iconButton('slide-item-edit', isWidget ? `Edit ${name}` : `Edit ${name}'s properties`, ICON_EDIT);
        const del  = iconButton('slide-item-delete', `Delete ${name}`, ICON_TRASH);
        row.appendChild(edit);
        row.appendChild(del);

        // Point out which box on the slide this row is.
        const box = () => document.querySelector(`.edit-overlay[data-arr-key="${arrKey}"][data-item-index="${index}"]`);
        row.addEventListener('mouseenter', () => box()?.classList.add('is-hinted'));
        row.addEventListener('mouseleave', () => box()?.classList.remove('is-hinted'));

        edit.addEventListener('click', () => {
            box()?.classList.remove('is-hinted');
            if (isWidget) { openWidgetSettingsFor(index); return; }
            const b = box();
            if (b) selectOverlayEl(b, arrKey, index);
        });
        // Two clicks: the first arms it, since there's no undo.
        del.addEventListener('click', () => {
            if (!del.classList.contains('is-armed')) {
                del.classList.add('is-armed');
                del.title = 'Click again to delete';
                row.classList.add('is-deleting');
                setTimeout(() => {
                    if (!del.isConnected) return;
                    del.classList.remove('is-armed');
                    del.title = `Delete ${name}`;
                    row.classList.remove('is-deleting');
                }, 3000);
                return;
            }
            box()?.classList.remove('is-hinted');
            deleteItem(arrKey, index);
        });
        row._entry = { arrKey, item, index };
        list.appendChild(row);
    }
    host.appendChild(list);
    if (entries.length > 1) wireReorder(list);
}

/* ─── layering by list order ──────────────────────────────────────── */
// What sits in front is whatever is higher in the list. Stacking is each
// item's zIndex, so a reorder renumbers them all: the bottom of the list
// gets LAYER_BASE, each row above it one more. The defaults it replaces
// (reveal 4, media 5, widget 10) were all small, so the range stays well
// below the editor's own boxes and the slide's annotation layers.
const LAYER_BASE = 4;
const DEFAULT_LAYER = { widgets: 10, videos: 5, audios: 5, models: 5, reveals: 4 };
// Equal layers draw in DOM order: reveals, then media, then widgets on top.
const KIND_ORDER = { reveals: 0, videos: 1, audios: 2, models: 3, widgets: 4 };
function layerOf({ arrKey, item, index }) {
    const z = parseInt(item.zIndex, 10);
    const base = Number.isFinite(z) ? z : DEFAULT_LAYER[arrKey];
    return base + KIND_ORDER[arrKey] / 10 + index / 1000;
}

function wireReorder(list) {
    let dragged = null;
    const rows = () => Array.from(list.querySelectorAll('.slide-item'));
    const clearMarks = () => rows().forEach(r => r.classList.remove('drop-before', 'drop-after'));

    for (const row of rows()) {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
            // Not from the Edit / Delete buttons.
            if (e.target.closest?.('.slide-item-btn')) { e.preventDefault(); return; }
            dragged = row;
            row.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', ''); } catch (_) { /* Firefox needs some data */ }
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('is-dragging');
            clearMarks();
            dragged = null;
        });
        row.addEventListener('dragover', (e) => {
            if (!dragged || row === dragged) return;
            e.preventDefault();
            const r = row.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            clearMarks();
            row.classList.add(before ? 'drop-before' : 'drop-after');
        });
        row.addEventListener('drop', (e) => {
            if (!dragged || row === dragged) return;
            e.preventDefault();
            const r = row.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            row.parentNode.insertBefore(dragged, before ? row : row.nextSibling);
            clearMarks();
            applyListOrder(list);
        });
    }
}

function applyListOrder(list) {
    const ordered = Array.from(list.querySelectorAll('.slide-item')).map(r => r._entry);
    const n = ordered.length;
    ordered.forEach(({ item }, i) => { item.zIndex = LAYER_BASE + (n - 1 - i); });
    // Keep the boxes on the slide stacked the same way, so the one in front
    // is the one a click lands on.
    for (const { arrKey, item, index } of ordered) {
        const div = document.querySelector(`.edit-overlay[data-arr-key="${arrKey}"][data-item-index="${index}"]`);
        if (div) div.style.zIndex = String(50 + item.zIndex);
    }
    refreshSlideItems();
}
