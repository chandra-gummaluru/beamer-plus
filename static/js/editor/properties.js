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
         resolvePanelMode, slideName, setTitleEditable } from './context.js';
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

    const { arrKey, index } = ctx.selectedOverlay;
    const cfg  = getOrCreateConfig();
    const item = cfg?.[arrKey]?.[index];
    if (!item) return;

    setPanelMode('item', itemName(arrKey, item, index), `${slideName()} · ${KIND_LABELS[arrKey]}`);

    const body = document.getElementById('editor-properties-body');
    if (!body) return;
    body.innerHTML = buildPropsHTML(arrKey, item);

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
    const pct = (v) => Math.round(v * 100);
    const sel = (cur, v) => (cur === v ? 'selected' : '');
    const num = (id, label, value, extra = '') => `
        <label class="editor-prop-row"><span class="editor-prop-label">${label}</span>
            <span class="wp-num"><input class="field" type="number" step="1" id="${id}" value="${value}" ${extra}><i>%</i></span></label>`;
    const section = (title, body) => `
        <section class="wf-group"><div class="wf-group-title">${title}</div><div class="wf-group-body">${body}</div></section>`;

    let layout = `
        <div class="wp-geom">
            ${num('prop-x', 'X', pct(item.x ?? 0), 'min="0" max="100"')}
            ${num('prop-y', 'Y', pct(item.y ?? 0), 'min="0" max="100"')}
            ${num('prop-w', 'Width', pct(item.width ?? 0.4), 'min="1" max="100"')}
            ${num('prop-h', 'Height', pct(item.height ?? 0.3), `min="1" max="100"${lockAR ? ' readonly title="Follows the width, keeping its shape"' : ''}`)}
        </div>`;
    if (arrKey === 'reveals') {
        layout += `
            <label class="editor-prop-row"><span class="editor-prop-label">Reveal on Step</span>
                <input class="field" type="number" min="1" max="99" step="1" id="prop-step" value="${parseInt(item.step, 10) || 1}"></label>
            <label class="editor-prop-row"><span class="editor-prop-label">Look While Hidden</span>
                <select class="field" id="prop-revealStyle">
                    <option value="blend" ${sel(item.style ?? 'blend', 'blend')} data-desc="Matches the slide behind it">Blend Into Slide</option>
                    <option value="frosted" ${sel(item.style, 'frosted')} data-desc="A visible panel over the hidden part">Frosted Panel</option>
                </select></label>`;
    } else {
        layout += `
            <label class="editor-prop-row"><span class="editor-prop-label">Appear on Step</span>
                <input class="field" type="number" min="1" max="99" step="1" id="prop-step" placeholder="Always" value="${parseInt(item.step, 10) > 0 ? parseInt(item.step, 10) : ''}"></label>`;
    }
    let html = section('Layout', layout);

    if (arrKey === 'videos') {
        const pm = item.playMode ?? 'click';
        html += section('Playback', `
            <label class="editor-prop-row"><span class="editor-prop-label">Play Mode</span>
                <select class="field" id="prop-playMode">
                    <option value="click" ${sel(pm, 'click')} data-desc="Starts when you click it">Click to Play</option>
                    <option value="auto" ${sel(pm, 'auto')} data-desc="Plays once, muted, when the slide opens">Auto</option>
                    <option value="loop" ${sel(pm, 'loop')} data-desc="Plays over and over, muted">Loop</option>
                    <option value="manual" ${sel(pm, 'manual')} data-desc="Shows the player's own controls">Manual Controls</option>
                    <option value="once" ${sel(pm, 'once')} data-desc="Plays once with sound">Once</option>
                </select></label>
            <label class="editor-prop-row"><span class="editor-prop-label">Volume</span>
                <input class="field" type="number" min="0" max="1" step="0.05" id="prop-volume" value="${item.volume ?? 1}"></label>
            <label class="editor-prop-row"><span class="editor-prop-label">Grow to Full Slide While Playing</span>
                <select class="field" id="prop-expandDelay">${expandDelayOptions(item.expandDelay)}</select></label>`);
    } else if (arrKey === 'audios') {
        const pm = item.playMode ?? 'click';
        html += section('Playback', `
            <label class="editor-prop-row"><span class="editor-prop-label">Play Mode</span>
                <select class="field" id="prop-playMode">
                    <option value="click" ${sel(pm, 'click')}>Click to Play</option>
                    <option value="auto" ${sel(pm, 'auto')}>Auto</option>
                    <option value="loop" ${sel(pm, 'loop')}>Loop</option>
                </select></label>`);
    } else if (arrKey === 'models') {
        html += section('Model', `
            <label class="editor-prop-checkbox-row">
                <span>Auto-Rotate</span>
                <input type="checkbox" class="editor-switch" role="switch" id="prop-autoRotate" ${item.autoRotate ? 'checked' : ''}>
            </label>
            <label class="editor-prop-checkbox-row">
                <span>Play Animation</span>
                <input type="checkbox" class="editor-switch" role="switch" id="prop-animate" ${item.animate !== false ? 'checked' : ''}>
            </label>
            <label class="editor-prop-row"><span class="editor-prop-label">Animation Name</span>
                <input class="field" type="text" id="prop-animName" placeholder="The model's first" value="${escAttr(item.animationName ?? '')}"></label>`);
    }
    return `<div class="wf wf--panel">${html}</div>`;
}

// Expand-on-play delays offered for a video (seconds; '' = never). A delay
// saved by hand that isn't in the list still shows, so opening the panel
// can't silently change it.
const EXPAND_DELAYS = [0, 2, 3, 5, 10];
function expandDelayOptions(current) {
    const cur = current == null || current === '' ? '' : Number(current);
    const vals = EXPAND_DELAYS.includes(cur) || cur === '' ? EXPAND_DELAYS : [...EXPAND_DELAYS, cur].sort((x, y) => x - y);
    const label = (v) => v === 0 ? 'As Soon as It Plays' : `After ${v} s of Playing`;
    return [`<option value="" ${cur === '' ? 'selected' : ''}>Never</option>`,
            ...vals.map(v => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label(v)}</option>`)].join('');
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

function applyPropertiesQuiet() {
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
        const ed = get('prop-expandDelay')?.value ?? '';
        if (ed === '') delete item.expandDelay;
        else item.expandDelay = parseFloat(ed);
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

function deleteItem(arrKey, index) {
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
    setPanelMode('widget', item.title || widgetTypeLabel(item), `${slideName()} · ${widgetTypeLabel(item)}`);
    // Its name is the header: click it and type. Empty falls back to the
    // widget's own label, as a placeholder.
    setTitleEditable(item, {
        placeholder: widgetTypeLabel(item),
        onRename: (value) => {
            const v = value.trim();
            if (v) item.title = v; else delete item.title;
            const name = item.title || widgetTypeLabel(item);
            const label = document.querySelector(`.edit-overlay[data-arr-key="widgets"][data-item-index="${index}"] .edit-overlay-label`);
            if (label) label.textContent = overlayLabel('widgets', item, name);
        },
    });
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

/* ─── deleting what's selected ────────────────────────────────────── */
// The panel's Delete (editor.js) deletes the selected element, if any.

/** What kind of thing is selected ("Widget", "Video"…), or null. */
export function selectedItemKind() {
    const sel = ctx.selectedOverlay;
    return sel ? KIND_LABELS[sel.arrKey] || 'Element' : null;
}

/** Delete the selected element (no-op without one). */
export function deleteSelectedItem() {
    const sel = ctx.selectedOverlay;
    if (sel) deleteItem(sel.arrKey, sel.index);
}

/* ─── the slide's list of what's on it ────────────────────────────── */

const ITEM_ICONS = {
    widgets: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    videos:  '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/>',
    audios:  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    reveals: '<rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 3"/><path d="M9 12h6M13 9l3 3-3 3"/>',
    models:  '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>',
};
const KIND_LABELS = { widgets: 'Widget', videos: 'Video', audios: 'Audio', models: '3D Model', reveals: 'Reveal Box' };
const GRIP = '<svg class="slide-item-grip" width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
const CHEVRON = '<svg class="slide-item-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

/** What a thing on the slide is called in the list and the panel header. */
function itemName(arrKey, item, index) {
    if (arrKey === 'widgets') return item.title || widgetTypeLabel(item);
    if (arrKey === 'reveals') return `Reveal Step ${parseInt(item.step, 10) > 0 ? parseInt(item.step, 10) : 1}`;
    return item.path ? item.path.split('/').pop() : `${KIND_LABELS[arrKey]} ${index + 1}`;
}

/**
 * Rebuild the list of everything on the current slide, front to back, in
 * the slide's panel. Click a row to open its settings; drag it to change
 * what sits in front.
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
    if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'slide-items-empty';
        empty.textContent = 'Nothing here yet. Add a video, a widget or a reveal step from the toolbar above the slide.';
        host.appendChild(empty);
        return;
    }
    // Front to back: the list's order is the slide's stacking order.
    entries.sort((a, b) => layerOf(b) - layerOf(a));

    const list = document.createElement('div');
    list.className = 'slide-items';
    list.setAttribute('role', 'list');
    for (const { arrKey, item, index } of entries) {
        const isWidget = arrKey === 'widgets';
        const step = parseInt(item.step, 10) > 0 ? parseInt(item.step, 10) : 0;
        const name = itemName(arrKey, item, index);
        const kind = (isWidget ? widgetTypeLabel(item) : KIND_LABELS[arrKey])
            + (step && arrKey !== 'reveals' ? ` · Appears on Step ${step}` : '');
        const row = document.createElement('div');
        row.className = 'slide-item';
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.title = `Edit ${name}`;
        row.innerHTML = `
            ${entries.length > 1 ? GRIP : ''}
            <span class="slide-item-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ITEM_ICONS[arrKey]}</svg></span>
            <span class="slide-item-text">
                <span class="slide-item-name"></span>
                <span class="slide-item-kind"></span>
            </span>
            ${CHEVRON}`;
        row.querySelector('.slide-item-name').textContent = name;
        row.querySelector('.slide-item-kind').textContent = kind;
        // Point out which box on the slide this row is.
        const box = () => document.querySelector(`.edit-overlay[data-arr-key="${arrKey}"][data-item-index="${index}"]`);
        row.addEventListener('mouseenter', () => box()?.classList.add('is-hinted'));
        row.addEventListener('mouseleave', () => box()?.classList.remove('is-hinted'));
        const open = () => {
            box()?.classList.remove('is-hinted');
            if (isWidget) { openWidgetSettingsFor(index); return; }
            const b = box();
            if (b) selectOverlayEl(b, arrKey, index);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
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
    renumberLayers(Array.from(list.querySelectorAll('.slide-item')).map(r => r._entry));
    refreshSlideItems();
}

// `ordered` is front to back; the back gets LAYER_BASE, each one forward one more.
function renumberLayers(ordered) {
    const n = ordered.length;
    ordered.forEach(({ item }, i) => { item.zIndex = LAYER_BASE + (n - 1 - i); });
    // Keep the boxes on the slide stacked the same way, so the one in front
    // is the one a click lands on.
    for (const { arrKey, item, index } of ordered) {
        const div = document.querySelector(`.edit-overlay[data-arr-key="${arrKey}"][data-item-index="${index}"]`);
        if (div) div.style.zIndex = String(50 + item.zIndex);
    }
}
