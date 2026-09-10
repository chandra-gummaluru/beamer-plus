// Properties panel — position, size and z-index for the selected overlay,
// plus the type-specific fields Beamer+ itself owns: video play mode, audio
// play mode, model animation. Every change is applied to the in-memory
// config immediately.
//
// Widgets deliberately get none of the latter. A widget declares and renders
// its own settings, behind the gear on its edit overlay (see
// editor/widget-settings.js), so all this panel shows for a widget is where
// it sits on the slide.
import { ctx, getSlideEl, getOrCreateConfig, escAttr, escHtml, setPanelMode, resolvePanelMode } from './context.js';
import { cleanupEditOverlays, renderEditOverlays, positionOverlay } from './overlays.js';
import { WIDGET_LABELS } from './widget-picker.js';
import { widgetHasSettings } from './widget-settings.js';

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
    const titleEl = document.getElementById('editor-properties-title');
    if (titleEl) titleEl.textContent = `${typeLabels[arrKey] || arrKey} Properties`;

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
        // Point at where the rest of this widget's configuration now lives.
        if (widgetHasSettings(item.id)) {
            html += `
                <div class="editor-prop-hint">
                    This widget's own settings live on the widget — use the gear on the slide.
                </div>
            `;
        }
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
    // Widgets: nothing beyond geometry — their own settings are written back
    // by the widget itself, and must not be touched from here.

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
