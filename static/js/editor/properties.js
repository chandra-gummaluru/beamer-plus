// Properties panel — position, size and z-index for the selected overlay,
// plus the type-specific fields Beamer+ itself owns: video play mode, audio
// play mode, model animation. Every change is applied to the in-memory
// config immediately.
//
// A widget's own fields are shown here too, built from the field list the
// widget declares in its `widget-schema` block (see editor/widget-schema.js).
// They are read straight out of the widget's HTML rather than from a live
// iframe, so they are there the moment a widget is added — before it has ever
// been rendered.
//
// A widget is configured in its settings dialog (widget-settings-modal.js,
// form built by widget-fields.js) — a narrow sidebar is no place for a
// question, an answer list and a code template. The dialog opens from the
// slide's "On this slide" list (refreshSlideItems), from the "Edit settings"
// button shown here when a widget is selected on the slide, by
// double-clicking the widget, and straight after a widget is added. The
// sidebar keeps what goes with the box on the slide: its layout, and Remove.
import { ctx, getSlideEl, getOrCreateConfig, escAttr, escHtml, setPanelMode, setPanelTitle,
         resolvePanelMode } from './context.js';
import { cleanupEditOverlays, renderEditOverlays, positionOverlay } from './overlays.js';
import { WIDGET_LABELS } from './widget-picker.js';
import { getWidgetSchema } from './widget-schema.js';
import { openWidgetSettings, isWidgetSettingsOpen } from './widget-settings-modal.js';
import { selectOverlayEl } from './overlays.js';

// Whether the widget "Layout" section was left open — kept across rebuilds.
let _layoutOpen = true;
// Bumped on every panel build so a schema that resolves late can tell whether
// it is still the selection the user is looking at.
let _widgetFieldsToken = 0;

export function updatePropertiesPanel() {
    const panel = document.getElementById('editor-properties');
    if (!panel) return;
    // Nothing selected — hand the panel back to the slide (or view) section.
    if (!ctx.selectedOverlay) { setPanelMode(resolvePanelMode()); refreshSlideItems(); return; }
    setPanelMode('item');

    const { arrKey, index } = ctx.selectedOverlay;
    const cfg  = getOrCreateConfig();
    const item = cfg?.[arrKey]?.[index];
    if (!item) return;

    const typeLabels = { videos: 'Video', audios: 'Audio', models: '3D Model', widgets: 'Widget' };
    setPanelTitle(`${typeLabels[arrKey] || arrKey} Properties`);

    const body = document.getElementById('editor-properties-body');
    if (!body) return;
    body.innerHTML = buildPropsHTML(arrKey, item);
    body.querySelector('#prop-layout')?.addEventListener('toggle', (e) => { _layoutOpen = e.target.open; });

    // Whether a widget has settings to edit needs its HTML, so the summary
    // arrives a tick later, into the placeholder buildPropsHTML left for it.
    const fieldsToken = ++_widgetFieldsToken;
    if (arrKey === 'widgets') fillWidgetSummary(item, index, fieldsToken);

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

    let html = '';

    // ── Widget type badge (top of panel) ──────────────────────────────────
    if (arrKey === 'widgets') {
        const typeLabel = widgetTypeLabel(item);
        html += `
            <div class="editor-prop-row editor-prop-row--type-header">
                <div class="editor-prop-label">Widget type</div>
                <div class="editor-prop-type-badge">${escHtml(typeLabel)}</div>
            </div>
        `;
        html += `<div class="editor-prop-divider"></div>`;
    }

    const geometry = `
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
            <div class="editor-prop-label">Size${lockAR ? '<span class="editor-prop-label-note">locked ratio</span>' : ''}</div>
            <div class="editor-prop-row-2col">
                <div><div class="editor-prop-label">W (%)</div>
                <input class="editor-prop-input" type="number" min="1" max="100" step="1" id="prop-w" value="${Math.round((item.width  ?? 0.4) * 100)}"></div>
                <div><div class="editor-prop-label">H (%)</div>
                <input class="editor-prop-input" type="number" min="1" max="100" step="1" id="prop-h" value="${Math.round((item.height ?? 0.3) * 100)}"${lockAR ? ' readonly' : ''}></div>
            </div>
        </div>
        <div class="editor-prop-row">
            <div class="editor-prop-label">Z-Index</div>
            <input class="editor-prop-input" type="number" min="1" max="999" step="1" id="prop-z" value="${item.zIndex ?? 5}">
        </div>
    `;

    if (arrKey === 'widgets') {
        // The way into its settings (filled in by fillWidgetSummary once the
        // schema is read), then its geometry.
        html += `<div id="widget-summary"></div>`;
        html += `
            <details class="editor-prop-details" id="prop-layout"${_layoutOpen ? ' open' : ''}>
                <summary class="editor-prop-details-summary">Layout</summary>
                <div class="editor-prop-details-body">${geometry}</div>
            </details>
        `;
    } else {
        html += geometry;
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
                    <input type="checkbox" id="prop-autoRotate" ${item.autoRotate ? 'checked' : ''}>
                    Auto-rotate
                </label>
            </div>
            <div class="editor-prop-row">
                <label class="editor-prop-checkbox-row">
                    <input type="checkbox" id="prop-animate" ${item.animate !== false ? 'checked' : ''}>
                    Play animation
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
    item.zIndex = parseInt(get('prop-z')?.value ?? '5', 10);

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

/* ─── the selected widget: a way into its settings ────────────────── */

async function fillWidgetSummary(item, index, token) {
    const schema = await getWidgetSchema(item);
    if (token !== _widgetFieldsToken) return;
    const host = document.getElementById('widget-summary');
    if (!host) return;
    host.textContent = '';
    if (!schema || !schema.fields.length) {
        host.appendChild(hintRow('This widget has no settings of its own.'));
        return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn editor-open-settings';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>Edit settings';
    btn.addEventListener('click', () => openWidgetSettingsFor(index));
    host.appendChild(btn);
    host.appendChild(hintRow('Or double-click the widget on the slide.'));
}

function hintRow(text) {
    const el = document.createElement('div');
    el.className = 'editor-prop-hint';
    el.textContent = text;
    return el;
}

export function widgetTypeLabel(item) {
    return WIDGET_LABELS[item.type]
        || (item.type || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        || 'Custom Widget';
}

/* ─── the widget settings dialog ──────────────────────────────────── */

/**
 * Open the settings dialog for widget #index on the current slide.
 *
 * From the slide's item list (`fromList`) the dialog is all that opens: the
 * panel stays on the slide's properties, and the widget's box is only marked
 * on the slide while it's being edited. From the slide itself (Edit settings,
 * double-click, a newly added widget) the widget is selected, so closing the
 * dialog leaves you on its sidebar view with the box ready to drag.
 */
export async function openWidgetSettingsFor(index, { fromList = false } = {}) {
    if (isWidgetSettingsOpen()) return;
    const item = getOrCreateConfig()?.widgets?.[index];
    if (!item) return;
    const schema = await getWidgetSchema(item);

    const overlay = document.querySelector(`.edit-overlay[data-arr-key="widgets"][data-item-index="${index}"]`);
    if (fromList) overlay?.classList.add('is-editing');
    else if (overlay && ctx.selectedOverlay?.div !== overlay) selectOverlayEl(overlay, 'widgets', index);

    openWidgetSettings(item, schema || { label: null, fields: [] }, {
        title: item.title || schema?.label || widgetTypeLabel(item),
        // Keep the box on the slide in step with the dialog's Layout card.
        onLayout: () => {
            const div = document.querySelector(`.edit-overlay[data-arr-key="widgets"][data-item-index="${index}"]`);
            const cr = getSlideEl()?.getBoundingClientRect();
            if (div && cr) positionOverlay(div, item, cr);
        },
        onRemove: () => deleteItem('widgets', index),
        onClose: (removed) => {
            document.querySelectorAll('.edit-overlay.is-editing').forEach(el => el.classList.remove('is-editing'));
            if (!ctx.state?.editMode || removed) return;
            const label = document.querySelector(`.edit-overlay[data-arr-key="widgets"][data-item-index="${index}"] .edit-overlay-label`);
            if (label) label.textContent = item.title || widgetTypeLabel(item);
            if (!fromList) updatePropertiesPanel();
            refreshSlideItems();                  // names may have changed
        },
    });
}

/* ─── the slide properties' item list ─────────────────────────────── */

const ITEM_ICONS = {
    widgets: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    videos:  '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    audios:  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    models:  '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
};
const KIND_LABELS = { widgets: 'Widget', videos: 'Video', audios: 'Audio', models: '3D model' };
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
    for (const arrKey of ['widgets', 'videos', 'audios', 'models']) {
        (cfg?.[arrKey] || []).forEach((item, index) => entries.push({ arrKey, item, index }));
    }
    if (!entries.length) {
        host.appendChild(hintRow('Nothing on this slide yet — add a widget or media with the buttons below.'));
        return;
    }

    const list = document.createElement('div');
    list.className = 'slide-items';
    for (const { arrKey, item, index } of entries) {
        const isWidget = arrKey === 'widgets';
        const name = isWidget
            ? (item.title || widgetTypeLabel(item))
            : (item.path ? item.path.split('/').pop() : `${KIND_LABELS[arrKey]} ${index + 1}`);
        const kind = isWidget && item.title ? widgetTypeLabel(item) : KIND_LABELS[arrKey];

        const row = document.createElement('div');
        row.className = 'slide-item';
        row.innerHTML = `
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
            if (isWidget) { openWidgetSettingsFor(index, { fromList: true }); return; }
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
        list.appendChild(row);
    }
    host.appendChild(list);
}
