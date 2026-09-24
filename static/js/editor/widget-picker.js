// "Add Widget" picker — lists every widget in the server's widgets/ folder,
// groups them into categories, and adds the chosen widget (or a custom
// uploaded .html file) to the current slide.
//
// A widget's name and category come from its own schema block, read by the
// server (/api/widgets/catalog):
//   <script id="widget-schema" type="application/json"> … </script>
// so a new file in widgets/ appears here with no change to this module. The
// only thing kept here is the icon, with a generic one for anything unlisted.
import { ctx, getOrCreateConfig, escHtml } from './context.js';
import { renderEditOverlays, cleanupEditOverlays } from './overlays.js';
import { openWidgetSettingsFor } from './properties.js';

const WIDGET_ICONS = {
    'audience-response':`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    'binary-arithmetic':`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><path d="M3 15h18"/><path d="M6.5 19v-1M17.5 19v-1"/><path d="M12 5.5v2M11 6.5h2"/></svg>`,
    browser:            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    calculator:         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="16" x2="12" y2="16"/></svg>`,
    camera:             `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
    'function-plotter': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    'karnaugh-map':     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><rect x="4.6" y="4.6" width="8.8" height="8.8" rx="4"/></svg>`,
    ipynb_widget:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    map:                `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
    'python-ide':       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="13" x2="22" y2="13"/><line x1="6" y1="7" x2="13" y2="7"/><polyline points="6 16 8 17.5 6 19"/></svg>`,
    'python-visualizer':`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="7" height="6" rx="1"/><rect x="15" y="4" width="7" height="6" rx="1"/><rect x="15" y="14" width="7" height="6" rx="1"/><path d="M9 7h6M9 7l6 10"/></svg>`,
    'python-workspace': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="12" y1="12" x2="22" y2="12"/><polyline points="5 8 7 9.5 5 11"/></svg>`,
    'python-shell':     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><polyline points="6 9 9 12 6 15"/><polyline points="11 9 14 12 11 15"/><line x1="16" y1="15" x2="19" y2="15"/></svg>`,
    shell:              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><polyline points="4 9 8 13 4 17"/><line x1="10" y1="17" x2="20" y2="17"/></svg>`,
    pdf:                `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="17" x2="13" y2="17"/><line x1="8" y1="13" x2="16" y2="13"/></svg>`,
    timer:              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    youtube:            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="currentColor" stroke="none"/></svg>`,
    __default__:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    __custom__:         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
};

// type → display name. Filled from the catalog the first time the picker
// opens; the properties panel reads it for the widget-type badge.
export const WIDGET_LABELS = {};

// Preferred tab order. A category a widget declares that isn't listed here
// still gets a tab, just before "Other".
const WIDGET_CATEGORY_ORDER = [
    'Mathematics',
    'Computer Science',
    'Biology',
    'Engineering',
    'Audience Response',
    'Tools',
    'Other',
];

function _defaultLabel(type) {
    return type.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Older servers only have /api/widgets (bare file names); fall back to that.
async function _loadCatalog() {
    try {
        const res = await fetch('/api/widgets/catalog');
        if (res.ok) return await res.json();
    } catch (_) { /* fall through */ }
    try {
        const res = await fetch('/api/widgets');
        if (res.ok) {
            return (await res.json()).map(file => {
                const type = file.replace(/\.html$/i, '');
                return { file, type, label: _defaultLabel(type), category: 'Other' };
            });
        }
    } catch (e) {
        console.warn('Could not load widget list:', e);
    }
    return [];
}

// Fill the names early, so the properties badge has them before the picker
// has ever been opened.
_loadCatalog().then(list => { for (const w of list) WIDGET_LABELS[w.type] = w.label; });

/* ─── picker modal ──────────────────────────────────────────── */

export async function addWidget() {
    // Toggle: second click closes the modal
    if (document.getElementById('widget-modal-overlay')) {
        document.getElementById('widget-modal-overlay').remove();
        return;
    }

    const widgets = await _loadCatalog();
    for (const w of widgets) WIDGET_LABELS[w.type] = w.label;
    _showWidgetModal(widgets);
}

function _showWidgetModal(widgets) {
    document.getElementById('widget-modal-overlay')?.remove();

    // Determine which categories actually have widgets (so we don't show empty tabs).
    const usedCats = new Set(widgets.map(w => w.category || 'Other'));
    const extraCats = [...usedCats]
        .filter(c => !WIDGET_CATEGORY_ORDER.includes(c))
        .sort();
    const order = [...WIDGET_CATEGORY_ORDER.slice(0, -1), ...extraCats, 'Other'];
    const visibleCats = order.filter(c => usedCats.has(c));

    const overlay = document.createElement('div');
    overlay.id = 'widget-modal-overlay';
    overlay.className = 'widget-modal-overlay';
    overlay.innerHTML = `
        <div class="widget-modal" id="widget-modal">
            <div class="widget-modal-header">
                <h2 class="widget-modal-title">Add Widget</h2>
                <button class="btn widget-modal-close" id="widget-modal-close" title="Close">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <div class="widget-modal-cats" id="widget-modal-cats">
                <button class="widget-cat-btn is-active" data-cat="all">All</button>
                ${visibleCats.map(c => `<button class="widget-cat-btn" data-cat="${escHtml(c)}">${escHtml(c)}</button>`).join('')}
            </div>
            <div class="widget-modal-search-row">
                <input class="editor-prop-input widget-modal-search" type="search"
                       id="widget-modal-search" placeholder="Search widgets…" autocomplete="off">
            </div>
            <div class="widget-modal-grid" id="widget-modal-grid"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const grid   = document.getElementById('widget-modal-grid');
    const search = document.getElementById('widget-modal-search');
    let activeCat = 'all';

    const refresh = () => _populateWidgetGrid(grid, widgets, search?.value ?? '', activeCat);
    refresh();

    document.getElementById('widget-modal-cats')?.addEventListener('click', e => {
        const btn = e.target.closest('.widget-cat-btn');
        if (!btn) return;
        activeCat = btn.dataset.cat;
        document.querySelectorAll('#widget-modal-cats .widget-cat-btn').forEach(b =>
            b.classList.toggle('is-active', b === btn));
        refresh();
    });

    search?.addEventListener('input', refresh);

    const close = () => overlay.remove();
    document.getElementById('widget-modal-close')?.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    setTimeout(() => search?.focus(), 40);
}

function _populateWidgetGrid(grid, widgets, filter, category = 'all') {
    grid.innerHTML = '';
    const q = filter.trim().toLowerCase();

    // Custom upload card — shown in All and Other only (no category)
    const showCustom = (category === 'all' || category === 'Other')
        && (!q || 'custom upload html file'.includes(q));
    if (showCustom) {
        grid.appendChild(_makeWidgetCard('__custom__', 'Custom', WIDGET_ICONS.__custom__, true));
    }

    widgets.forEach(({ type, label, category: cat = 'Other' }) => {
        if (category !== 'all' && cat !== category) return;
        const q2 = `${label} ${type} ${cat}`.toLowerCase();
        if (q && !q2.includes(q)) return;
        grid.appendChild(_makeWidgetCard(type, label, WIDGET_ICONS[type] || WIDGET_ICONS.__default__));
    });
}

function _makeWidgetCard(type, label, iconSvg, isCustom = false) {
    const card = document.createElement('button');
    card.className = 'widget-card' + (isCustom ? ' widget-card--custom' : '');
    card.innerHTML = `<div class="widget-card-icon">${iconSvg}</div><div class="widget-card-label">${escHtml(label)}</div>`;
    card.addEventListener('click', () => {
        document.getElementById('widget-modal-overlay')?.remove();
        if (type === '__custom__') _pickCustomWidget();
        else _doAddWidget(type);
    });
    return card;
}

/* ─── adding widgets to the slide config ────────────────────── */

function _pickCustomWidget() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const type = file.name.replace(/\.html$/i, '');
        // Blob URL for immediate preview; file stored for ZIP inclusion on save
        const blobUrl = URL.createObjectURL(file);
        ctx.state.editorNewFiles[`widgets/${file.name}`] = await file.arrayBuffer();

        const cfg = getOrCreateConfig();
        if (!cfg) return;
        if (!cfg.widgets) cfg.widgets = [];
        cfg.widgets.push({
            id: `widget_${Date.now()}`,
            type,
            src: blobUrl,
            x: 0, y: 0,
            width: 1, height: 1,
            zIndex: 10,
        });
        const newIndex = cfg.widgets.length - 1;
        cleanupEditOverlays();
        renderEditOverlays();
        // A new widget always needs setting up — go straight to its settings.
        openWidgetSettingsFor(newIndex);
    });
    input.click();
}

function _doAddWidget(type) {
    const cfg = getOrCreateConfig();
    if (!cfg) return;
    if (!cfg.widgets) cfg.widgets = [];
    cfg.widgets.push({
        id: `widget_${Date.now()}`,
        type,
        src: '',
        // Full-slide by default — a widget is normally the slide's content,
        // not an overlay on top of it, and it's easier to shrink than to grow.
        x: 0, y: 0,
        width: 1, height: 1,
        zIndex: 10,
        builtin: true,
    });
    const newIndex = cfg.widgets.length - 1;
    cleanupEditOverlays();
    renderEditOverlays();
    openWidgetSettingsFor(newIndex);
}
