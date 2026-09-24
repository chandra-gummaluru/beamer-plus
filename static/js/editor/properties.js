// Properties panel — position, size and z-index for the selected overlay,
// plus the type-specific fields Beamer+ itself owns: video play mode, audio
// play mode, model animation. Every change is applied to the in-memory
// config immediately.
//
// A widget's own fields are shown here too, built from the field list the
// widget declares in its `widget-schema` block (see editor/widget-schema.js).
// They are read straight out of the widget's HTML rather than from a live
// iframe, so they are there the moment a widget is added — before it has ever
// been rendered. The form itself is built by widget-fields.js; the expand
// button in the panel header opens the same form in a larger dialog
// (widget-settings-modal.js) for widgets with a lot to configure.
//
// For a widget its settings come first and its geometry sits in a collapsed
// "Layout" section: position and size are usually set by dragging the box on
// the slide, and they used to push every actual setting below the fold.
import { ctx, getSlideEl, getOrCreateConfig, escAttr, escHtml, setPanelMode, setPanelTitle,
         resolvePanelMode } from './context.js';
import { cleanupEditOverlays, renderEditOverlays, positionOverlay } from './overlays.js';
import { WIDGET_LABELS } from './widget-picker.js';
import { getWidgetSchema } from './widget-schema.js';
import { buildWidgetForm } from './widget-fields.js';
import { openWidgetSettings } from './widget-settings-modal.js';

// The selected widget's settings form (see widget-fields.js), or null.
// Rebuilt whenever the panel is, and read back by applyPropertiesQuiet().
let _widgetForm = null;
// Whether the widget "Layout" section was left open — kept across rebuilds.
let _layoutOpen = false;
let _expandWired = false;
// Bumped on every panel build so a schema that resolves late can tell whether
// it is still the selection the user is looking at.
let _widgetFieldsToken = 0;

export function updatePropertiesPanel() {
    const panel = document.getElementById('editor-properties');
    if (!panel) return;
    // Nothing selected — hand the panel back to the slide (or view) section.
    if (!ctx.selectedOverlay) { setPanelMode(resolvePanelMode()); return; }
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

    // A widget's own fields need its HTML, so they arrive a tick later and are
    // appended into the placeholder buildPropsHTML left for them.
    _widgetForm = null;
    wireExpandButton();
    panel.closest('#editor-panel')?.removeAttribute('data-widget-settings');
    const fieldsToken = ++_widgetFieldsToken;
    if (arrKey === 'widgets') fillWidgetFields(item, fieldsToken);

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
    body.oninput  = () => { applyPropertiesQuiet(); _widgetForm?.syncVisibility(); };
    body.onchange = () => { applyPropertiesQuiet(); _widgetForm?.syncVisibility(); };
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
        // Settings (filled in by fillWidgetFields once the schema is read),
        // then the geometry, folded away.
        html += `<div id="widget-fields"></div>`;
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
    } else if (arrKey === 'widgets') {
        // The widget's own declared fields, alongside its geometry.
        _widgetForm?.apply(item);
    }

    const container = getSlideEl();
    const cr = container?.getBoundingClientRect();
    if (div && cr) positionOverlay(div, item, cr);
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

/* ─── a widget's own declared fields ──────────────────────────────── */

// Read the selected widget's schema and build its settings form into the
// placeholder. Async because the schema comes from the widget's HTML (server
// or ZIP); the token guards against a slow read landing in a panel the user
// has since pointed at something else.
async function fillWidgetFields(item, token) {
    const schema = await getWidgetSchema(item);
    if (token !== _widgetFieldsToken) return;
    const host = document.getElementById('widget-fields');
    if (!host) return;
    host.textContent = '';

    // `customSettings` is not honoured here: whatever a widget declares as
    // fields is edited in this panel, so every widget is configured the same way.
    if (!schema || !schema.fields.length) {
        host.appendChild(hintRow('This widget has no settings of its own.'));
        return;
    }

    _widgetForm = buildWidgetForm(schema, item, 'panel');
    host.appendChild(_widgetForm.node);
    document.getElementById('editor-panel')?.setAttribute('data-widget-settings', '1');
}

function hintRow(text) {
    const el = document.createElement('div');
    el.className = 'editor-prop-hint';
    el.textContent = text;
    return el;
}

function widgetTypeLabel(item) {
    return WIDGET_LABELS[item.type]
        || (item.type || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        || 'Custom Widget';
}

/* ─── expanded settings dialog ────────────────────────────────────── */

// The header's expand button (only shown while a widget with settings is
// selected — see editor.css) opens the same form in a large dialog. It edits
// the same config item live; closing it rebuilds this panel to match.
function wireExpandButton() {
    if (_expandWired) return;
    const btn = document.getElementById('editor-props-expand');
    if (!btn) return;
    _expandWired = true;
    btn.addEventListener('click', openExpandedSettings);
}

export async function openExpandedSettings() {
    const sel = ctx.selectedOverlay;
    if (sel?.arrKey !== 'widgets') return;
    const item = getOrCreateConfig()?.widgets?.[sel.index];
    if (!item) return;
    const schema = await getWidgetSchema(item);
    if (!schema?.fields?.length) return;
    openWidgetSettings(item, schema, {
        title: item.title || schema.label || widgetTypeLabel(item),
        onClose: () => { if (ctx.state?.editMode) updatePropertiesPanel(); },
    });
}
