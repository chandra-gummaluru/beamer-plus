// Properties panel — position, size and z-index for the selected overlay,
// plus the type-specific fields Beamer+ itself owns: video play mode, audio
// play mode, model animation. Every change is applied to the in-memory
// config immediately.
//
// A widget's own fields are shown here too, built from the field list the
// widget declares in its `widget-schema` block (see editor/widget-schema.js).
// They are read straight out of the widget's HTML rather than from a live
// iframe, so they are there the moment a widget is added — before it has ever
// been rendered. This panel is the only place a widget is configured from.
import { ctx, getSlideEl, getOrCreateConfig, escAttr, escHtml, setPanelMode, setPanelTitle,
         resolvePanelMode, WIDGET_RESERVED } from './context.js';
import { cleanupEditOverlays, renderEditOverlays, positionOverlay } from './overlays.js';
import { WIDGET_LABELS } from './widget-picker.js';
import { saveWidgetAsset } from './widget-settings.js';
import { getWidgetSchema } from './widget-schema.js';
import { sessionUrl } from '../app/session.js';

// Controls for the selected widget's declared fields, as { key, node, read() }.
// Rebuilt whenever the panel is, and read back by applyPropertiesQuiet().
let _widgetRows = [];
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

    // A widget's own fields need its HTML, so they arrive a tick later and are
    // appended into the placeholder buildPropsHTML left for them.
    _widgetRows = [];
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
    body.oninput  = () => { applyPropertiesQuiet(); syncFieldVisibility(); };
    body.onchange = () => { applyPropertiesQuiet(); syncFieldVisibility(); };
}

function buildPropsHTML(arrKey, item) {
    const lockAR = arrKey === 'videos' || arrKey === 'models';

    let html = '';

    // ── Widget type badge (top of panel) ──────────────────────────────────
    if (arrKey === 'widgets') {
        const typeLabel = WIDGET_LABELS[item.type]
            || (item.type || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            || 'Custom Widget';
        html += `
            <div class="editor-prop-row editor-prop-row--type-header">
                <div class="editor-prop-label">Widget type</div>
                <div class="editor-prop-type-badge">${escHtml(typeLabel)}</div>
            </div>
        `;
        html += `<div class="editor-prop-divider"></div>`;
    }

    html += `
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

    // Filled by fillWidgetFields() once the widget's schema has been read.
    if (arrKey === 'widgets') html += `<div id="widget-fields"></div>`;

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
        applyWidgetFields(item);
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

// Read the selected widget's schema and append a control per declared field.
// Async because the schema comes from the widget's HTML (server or ZIP); the
// token guards against a slow read landing in a panel the user has since
// pointed at something else.
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

    const divider = document.createElement('div');
    divider.className = 'editor-prop-divider';
    host.appendChild(divider);

    const heading = document.createElement('div');
    heading.className = 'editor-prop-section';
    heading.textContent = `${schema.label || 'Widget'} settings`;
    host.appendChild(heading);

    for (const field of schema.fields) {
        const row = buildFieldRow(field, item);
        row.field = field;
        _widgetRows.push(row);
        host.appendChild(row.node);
    }
    syncFieldVisibility();
}

// A field may declare `showIf: { otherKey: value | [values] }` — it only
// applies while another field holds one of those values (an answer list means
// nothing to an open-ended poll). Hidden rather than removed, so its value is
// kept and switching back restores what the presenter typed.
function syncFieldVisibility() {
    const values = {};
    for (const r of _widgetRows) {
        const res = r.read();
        values[r.key] = res.remove ? r.field?.default : res.value;
    }
    for (const r of _widgetRows) {
        r.node.style.display = fieldVisible(r.field, values) ? '' : 'none';
    }
}

function fieldVisible(field, values) {
    const cond = field?.showIf;
    if (!cond || typeof cond !== 'object') return true;
    return Object.keys(cond).every(k => {
        const want = Array.isArray(cond[k]) ? cond[k] : [cond[k]];
        return want.some(w => String(w) === String(values[k]));
    });
}

function hintRow(text) {
    const el = document.createElement('div');
    el.className = 'editor-prop-hint';
    el.textContent = text;
    return el;
}

// What a control should show: what the presenter set, else the schema's default.
function fieldValue(item, field) {
    const v = item[field.key];
    return v !== undefined ? v : field.default;
}

// Label only — a field says what it is and nothing more. Explanatory blurbs
// under a control read as clutter in a panel this narrow; anything a presenter
// genuinely needs to know belongs in the label or the placeholder.
function fieldLabel(field) {
    const lab = document.createElement('div');
    lab.className = 'editor-prop-label';
    lab.textContent = field.label || field.key;
    return lab;
}

// One control per declared field. Deliberately mirrors the widget settings
// kit's field types and its read() semantics — notably that clearing a field
// drops the key so the widget's own default applies again — so a widget
// behaves identically whichever surface configured it.
function buildFieldRow(field, item) {
    const eff = fieldValue(item, field);
    const row = document.createElement('div');
    row.className = 'editor-prop-row';
    let input;

    if (field.type === 'checkbox') {
        const lab = document.createElement('label');
        lab.className = 'editor-prop-checkbox-row';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = eff === true;
        lab.appendChild(input);
        lab.appendChild(document.createTextNode(field.label || field.key));
        row.appendChild(lab);

    } else if (field.type === 'select') {
        row.appendChild(fieldLabel(field));
        input = document.createElement('select');
        input.className = 'editor-prop-select';
        for (const o of field.options || []) {
            const isObj = o && typeof o === 'object';
            const value = isObj ? o.v : o;
            const label = isObj ? (o.l !== undefined ? o.l : o.v) : o;
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            // Compared as strings: a deck may hold 1.4 where the schema
            // declares "1.4", and a strict compare would lose the selection.
            if (String(eff) === String(value)) opt.selected = true;
            input.appendChild(opt);
        }
        row.appendChild(input);

    } else if (field.type === 'ai-model') {
        row.appendChild(fieldLabel(field));
        input = document.createElement('select');
        input.className = 'editor-prop-select';
        fillModelOptions(input, eff);
        row.appendChild(input);

    } else if (field.type === 'textarea' || field.type === 'textarea-lines') {
        row.appendChild(fieldLabel(field));
        input = document.createElement('textarea');
        input.className = 'editor-prop-input editor-prop-area';
        input.rows = field.rows || (field.type === 'textarea-lines' ? 4 : 3);
        input.spellcheck = false;
        if (field.placeholder) input.placeholder = field.placeholder;
        input.value = Array.isArray(eff) ? eff.join('\n') : (eff == null ? '' : String(eff));
        row.appendChild(input);

    } else if (field.type === 'file') {
        row.appendChild(fieldLabel(field));
        const fileRow = document.createElement('div');
        fileRow.className = 'editor-prop-file';
        input = document.createElement('input');
        input.className = 'editor-prop-input';
        input.type = 'text';
        input.readOnly = true;
        input.placeholder = 'No file selected';
        input.value = eff == null ? '' : String(eff);
        input.title = input.value;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn editor-prop-file-btn';
        btn.textContent = 'Upload';
        btn.addEventListener('click', () => pickWidgetAsset(field, item, input, btn));
        fileRow.appendChild(input);
        fileRow.appendChild(btn);
        row.appendChild(fileRow);

    } else {
        row.appendChild(fieldLabel(field));
        input = document.createElement('input');
        input.className = 'editor-prop-input';
        input.type = field.type === 'password' ? 'password'
                   : (field.type === 'number' || field.type === 'number-nullable') ? 'number'
                   : 'text';
        if (field.min  !== undefined) input.min  = field.min;
        if (field.max  !== undefined) input.max  = field.max;
        if (field.step !== undefined) input.step = field.step;
        if (field.placeholder) input.placeholder = field.placeholder;
        input.value = eff == null ? '' : String(eff);
        row.appendChild(input);
    }

    // No per-control listener: #editor-properties-body already auto-applies on
    // input/change, and these rows sit inside it.
    return {
        key: field.key,
        node: row,
        read() {
            if (field.type === 'checkbox') return { value: input.checked };
            if (field.type === 'number' || field.type === 'number-nullable') {
                const raw = input.value.trim();
                if (raw === '') return { remove: true };
                const n = parseFloat(raw);
                return isNaN(n) ? { remove: true } : { value: n };
            }
            if (field.type === 'textarea-lines') {
                const lines = input.value.split('\n').map(s => s.trim()).filter(Boolean);
                return lines.length ? { value: lines } : { remove: true };
            }
            return input.value === '' ? { remove: true } : { value: input.value };
        },
    };
}

// The AI models the server can actually reach. main.js loads them at start-up;
// fall back to asking if that hasn't landed (or failed).
async function fillModelOptions(select, current) {
    const render = (models) => {
        select.textContent = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '— no model —';
        select.appendChild(none);
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (current === m) opt.selected = true;
            select.appendChild(opt);
        }
        // Keep a model the deck names but this server doesn't offer, so simply
        // opening the panel doesn't silently clear the presenter's choice.
        if (current && !models.includes(current)) {
            const opt = document.createElement('option');
            opt.value = current;
            opt.textContent = `${current} (unavailable)`;
            opt.selected = true;
            select.appendChild(opt);
        }
    };

    const known = ctx.state?.availableModels;
    if (Array.isArray(known) && known.length) { render(known); return; }

    const placeholder = document.createElement('option');
    placeholder.value = current == null ? '' : String(current);
    placeholder.textContent = current ? String(current) : '— loading… —';
    select.appendChild(placeholder);
    try {
        const data = await (await fetch(sessionUrl('/api/models'))).json();
        const models = data?.models || [];
        if (ctx.state) ctx.state.availableModels = models;
        render(models);
    } catch (_) {
        placeholder.textContent = '— unavailable —';
    }
}

// A file field's bytes go into the deck (and up to the server so the widget can
// read them before any save); the widget's config records only the path.
function pickWidgetAsset(field, item, input, btn) {
    const picker = document.createElement('input');
    picker.type = 'file';
    if (field.accept) picker.accept = field.accept;
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        if (!file) return;
        btn.disabled = true;
        btn.textContent = 'Uploading…';
        try {
            const buffer = await file.arrayBuffer();
            const path = await saveWidgetAsset(item, {
                key: field.key, name: file.name, folder: field.folder || 'files', buffer,
            });
            if (path) { input.value = path; input.title = path; }
        } catch (err) {
            // The file is still recorded and will be written into the deck on
            // save — it is only the live preview that can't be served. Say so,
            // rather than leaving a silent failure to resurface later as a
            // missing file inside the widget.
            console.warn('[editor] widget file upload failed:', err);
            window.BeamerModal?.show({
                kind: 'error',
                title: 'Upload failed',
                message: `${err.message}\n\nThe file is still part of the presentation and will be included when you save, but the widget can't preview it until the upload succeeds.`,
            });
        } finally {
            btn.disabled = false;
            btn.textContent = 'Upload';
        }
    });
    picker.click();
}

// Write every declared field back onto the widget's config item. A cleared
// field is deleted rather than stored empty, so the widget falls back to its
// own default exactly as it would through its in-widget panel.
function applyWidgetFields(item) {
    for (const row of _widgetRows) {
        if (WIDGET_RESERVED.has(row.key)) continue;   // a widget can't move itself
        const res = row.read();
        if (res.remove) delete item[row.key];
        else item[row.key] = res.value;
    }
}
