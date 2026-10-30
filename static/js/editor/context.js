// Shared editor context — the presenter-state handle, current selections,
// and small helpers used by every editor module.
import { configKeyOf, getSlideLabels } from '../slides/structure.js';
import { bus } from '../core/events.js';

export const ctx = {
    state: null,            // shared presenter state (set by initEditor)
    selectedOverlay: null,  // { div, arrKey, index } or null
    selectedViewIdx: null,  // structure index of the view slide being configured, or null
};

export function getSlideEl() { return document.getElementById('pdf-canvas'); }

/* ─── panel mode ────────────────────────────────────────────────
   The editor panel is open the whole time edit mode is, and shows one
   section at a time; its header names what that is:
     'slide'  — nothing selected: the current slide itself (shown or not,
                its paper, everything on it)
     'item'   — the selected video, audio, 3D model or reveal box
     'widget' — the selected widget (editor/widget-panel.js)
     'view'   — the split-view configuration for a view slide
   CSS keys off #editor-panel[data-mode], so switching modes is a single
   attribute write; nothing sets inline display styles. */

const PANEL_TITLES = {
    slide:  'Slide',
    item:   'Properties',       // replaced with the item's own name by properties.js
    widget: 'Widget',           // replaced with the widget's name
    view:   'Split View',
};

/**
 * @param {string} mode
 * @param {string} [title]   the header's big line
 * @param {string} [kicker]  the small line above it ("Slide 10 · Video")
 */
export function setPanelMode(mode, title, kicker = '') {
    const panel = document.getElementById('editor-panel');
    if (panel) panel.dataset.mode = mode;
    // A widget's name is edited in the header (widget mode, properties.js),
    // and so is a slide's: its title, shown on its thumbnail. Every other
    // mode makes the header read-only again.
    if (mode !== 'widget') setTitleEditable(null);
    // The slide names itself — "Slide 10", over what it is — unless it has
    // a title, which then leads and the number moves to the line above.
    if (mode === 'slide' && title === undefined) {
        const obj = ctx.state?.slideStructure?.[ctx.state.currentSlide];
        if (obj && obj.type !== 'view') {
            title = obj.title || slideName();
            kicker = obj.title ? `${slideName()} · ${slideKind()}` : slideKind();
            setTitleEditable(obj, {
                placeholder: slideName(),
                onRename: name => {
                    const v = name.replace(/\s+/g, ' ').trim();
                    if (v) obj.title = v; else delete obj.title;
                    const k = document.getElementById('editor-panel-kicker');
                    if (k) { k.textContent = v ? `${slideName()} · ${slideKind()}` : slideKind(); k.hidden = false; }
                    bus.emit('nav:refresh');
                },
            });
        } else { title = slideName(); kicker = slideKind(); }
    }
    setPanelTitle(title ?? PANEL_TITLES[mode] ?? 'Edit Presentation', kicker);
    // The panel's footer follows what the panel shows (editor.js).
    bus.emit('editor:panel-mode', mode);
}

/**
 * Make the header's name editable for `item` (a widget's config item), or
 * read-only again with null. `onRename(name)` runs on every keystroke.
 */
export function setTitleEditable(item, { placeholder = '', onRename } = {}) {
    const el = document.getElementById('editor-panel-title');
    if (!el) return;
    const on = !!item;
    el.readOnly = !on;
    el.tabIndex = on ? 0 : -1;
    el.placeholder = on ? placeholder : '';
    el.classList.toggle('is-editable', on);
    el.title = on ? 'Click to rename' : el.value;
    el.oninput = on ? () => onRename?.(el.value) : null;
    if (on && document.activeElement !== el) el.value = item.title || '';
}

/** "Slide 10" — the current slide, by its navigator label. */
export function slideName(i = ctx.state?.currentSlide) {
    const label = ctx.state?.slideStructure ? getSlideLabels(ctx.state.slideStructure)[i] : null;
    return label ? `Slide ${label}` : 'Slide';
}

/** What the current slide is: a PDF page, a copy of one, a blank page. */
function slideKind(i = ctx.state?.currentSlide) {
    const obj = ctx.state?.slideStructure?.[i];
    if (!obj) return '';
    if (obj.type === 'blank') return 'Blank Slide';
    if (obj.type === 'view')  return 'Split View';
    const page = (obj.pdfIndex ?? 0) + 1;
    return obj.cfgId ? `Copy of PDF Page ${page}` : `PDF Page ${page}`;
}

export function setPanelTitle(title, kicker) {
    const el = document.getElementById('editor-panel-title');
    // Leave a name being typed alone.
    if (el && document.activeElement !== el) { el.value = title; el.title = title; }
    if (kicker === undefined) return;
    const k = document.getElementById('editor-panel-kicker');
    if (k) { k.textContent = kicker; k.hidden = !kicker; }
}

// The mode implied by the current selection, used whenever a section
// dismisses itself and control returns to whatever is still selected.
export function resolvePanelMode() {
    if (ctx.selectedViewIdx !== null)  return 'view';
    if (ctx.selectedOverlay)           return ctx.selectedOverlay.arrKey === 'widgets' ? 'widget' : 'item';
    return 'slide';
}

export function getOrCreateConfig() {
    const obj = ctx.state.slideStructure[ctx.state.currentSlide];
    // A view slide's config is its split widgets', edited in the view panel
    // (view-config.js), never as items on a slide.
    if (!obj || obj.type === 'view') return null;
    // PDF slides use their stable pdfIndex (a duplicated page its own cfgId);
    // blank slides use their stable blankId.
    const key = configKeyOf(obj);
    if (key === null || key === undefined) return null;
    if (!ctx.state.slideConfigs[key]) ctx.state.slideConfigs[key] = {};
    return ctx.state.slideConfigs[key];
}

/* ─── widget keys the layout system owns ────────────────────────
   A widget may write any of its own settings back into its config item,
   but never these: they are Beamer+'s to set, and a widget that could
   rewrite its own src or geometry could move or re-point itself. */
export const WIDGET_RESERVED = new Set([
    'id', 'type', 'x', 'y', 'width', 'height', 'zIndex', 'step', 'display',
    'builtin', 'src', 'interactive', 'split',
    'notebookContent', 'role', 'socketUrl',
    'sessionId', 'serverUrl', 'publicBaseUrl',
]);

export function arrKeyForType(type) {
    return type === 'video' ? 'videos' : type === 'audio' ? 'audios' : type === 'model' ? 'models'
         : type === 'reveal' ? 'reveals' : 'widgets';
}

export function getConfigItems(cfg) {
    return [
        ...(cfg.videos  || []).map((v, i) => ({ type: 'video',  arrKey: 'videos',  item: v, index: i })),
        ...(cfg.audios  || []).map((a, i) => ({ type: 'audio',  arrKey: 'audios',  item: a, index: i })),
        ...(cfg.models  || []).map((m, i) => ({ type: 'model',  arrKey: 'models',  item: m, index: i })),
        ...(cfg.widgets || []).map((w, i) => ({ type: 'widget', arrKey: 'widgets', item: w, index: i })),
        ...(cfg.reveals || []).map((r, i) => ({ type: 'reveal', arrKey: 'reveals', item: r, index: i })),
    ];
}

/* ─── HTML escaping for panel markup ────────────────────────── */

export function escAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

