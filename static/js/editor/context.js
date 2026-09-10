// Shared editor context — the presenter-state handle, current selections,
// and small helpers used by every editor module.

export const ctx = {
    state: null,            // shared presenter state (set by initEditor)
    selectedOverlay: null,  // { div, arrKey, index } or null
    selectedViewIdx: null,  // structure index of the view slide being configured, or null
};

export function getSlideEl() { return document.getElementById('pdf-canvas'); }

/* ─── panel mode ────────────────────────────────────────────────
   The editor panel shows one section at a time:
     'slide' — the current slide's own properties (the default)
     'item'  — the selected overlay's properties
     'view'  — the split-view configuration for a view slide
   CSS keys off #editor-panel-body[data-mode], so switching modes is
   a single attribute write; nothing sets inline display styles. */

export function setPanelMode(mode) {
    const body = document.getElementById('editor-panel-body');
    if (body) body.dataset.mode = mode;
}

// The mode implied by the current selection, used whenever a section
// dismisses itself and control returns to whatever is still selected.
export function resolvePanelMode() {
    if (ctx.selectedViewIdx !== null)  return 'view';
    if (ctx.selectedOverlay)           return 'item';
    return 'slide';
}

export function getCurrentPdfIndex() {
    const obj = ctx.state.slideStructure[ctx.state.currentSlide];
    return obj?.type === 'pdf' ? obj.pdfIndex : null;
}

export function getOrCreateConfig() {
    const obj = ctx.state.slideStructure[ctx.state.currentSlide];
    if (!obj) return null;
    // PDF slides use their stable pdfIndex; blank slides use their stable blankId.
    const key = obj.type === 'pdf' ? obj.pdfIndex
              : obj.type === 'blank' ? obj.blankId
              : null;
    if (key === null || key === undefined) return null;
    if (!ctx.state.slideConfigs[key]) ctx.state.slideConfigs[key] = {};
    return ctx.state.slideConfigs[key];
}

/* ─── widget keys the layout system owns ────────────────────────
   A widget may write any of its own settings back into its config item,
   but never these: they are Beamer+'s to set, and a widget that could
   rewrite its own src or geometry could move or re-point itself. */
export const WIDGET_RESERVED = new Set([
    'id', 'type', 'x', 'y', 'width', 'height', 'zIndex',
    'builtin', 'src', 'interactive',
    'notebookContent', 'role', 'socketUrl',
    'sessionId', 'serverUrl', 'publicBaseUrl',
]);

export function arrKeyForType(type) {
    return type === 'video' ? 'videos' : type === 'audio' ? 'audios' : type === 'model' ? 'models' : 'widgets';
}

export function getConfigItems(cfg) {
    return [
        ...(cfg.videos  || []).map((v, i) => ({ type: 'video',  arrKey: 'videos',  item: v, index: i })),
        ...(cfg.audios  || []).map((a, i) => ({ type: 'audio',  arrKey: 'audios',  item: a, index: i })),
        ...(cfg.models  || []).map((m, i) => ({ type: 'model',  arrKey: 'models',  item: m, index: i })),
        ...(cfg.widgets || []).map((w, i) => ({ type: 'widget', arrKey: 'widgets', item: w, index: i })),
    ];
}

/* ─── HTML escaping for panel markup ────────────────────────── */

export function escAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Safe element-id fragment for a custom field key (avoids CSS.escape dependency)
export function fieldId(key) {
    return 'prop-custom-' + key.replace(/[^a-zA-Z0-9_-]/g, '_');
}
