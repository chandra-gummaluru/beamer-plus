// View-slide configuration panel — the split view's two slides (click one
// to edit it; Choose Slides picks both again by clicking them in the slide
// list, pane-picker.js) and the divider ratio. Deleting it and whether it's
// shown are the insert toolbar's trash and eye (editor.js).
import { bus } from '../core/events.js';
import { getSlideLabels } from '../slides/structure.js';
import { ctx, escAttr, escHtml, setPanelMode, resolvePanelMode } from './context.js';
import { pickPanes } from './pane-picker.js';
import { splitWidgetsOf, queueSync, loadSplitConfig } from '../slides/split-widgets.js';
import { widgetCatalog, widgetIcon } from './widget-picker.js';
import { openWidgetSettings } from './widget-settings-dialog.js';
import { pushWidgetConfig } from '../core/iframe-widget-renderer.js';

export function showViewConfig(i) {
    const obj = ctx.state?.slideStructure?.[i];
    if (!obj || obj.type !== 'view') return;
    ctx.selectedViewIdx = i;

    const body = document.getElementById('editor-view-body');
    if (!body) return;

    // The view config is the only UI while a view slide is selected — showing the
    // regular slide settings alongside it would cause confusion (e.g. "Hide in
    // presentation" would apply to the left pane slide, not the view).
    setPanelMode('view');
    body.innerHTML = buildViewConfigHTML(obj, i);
    wireViewConfigHandlers(i, obj);
    fillSplitWidgetSection(i, obj);
}

export function hideViewConfig() {
    ctx.selectedViewIdx = null;
    // Hand the panel back to whatever is still selected — normally the slide.
    setPanelMode(resolvePanelMode());
}

// Divider limits and presets. The stage clamps further if a pane would be
// cut off (getSplitRatioBounds in main.js).
const RATIO_MIN = 20, RATIO_MAX = 80;
const RATIO_PRESETS = [
    { v: 33, l: '1 : 2' },
    { v: 40, l: '2 : 3' },
    { v: 50, l: '1 : 1' },
    { v: 60, l: '3 : 2' },
    { v: 67, l: '2 : 1' },
];

function buildViewConfigHTML(obj, viewIdx) {
    const ratio = obj.ratio !== undefined ? obj.ratio : 50;

    return `
        <section class="wf-group" aria-label="Slides">
            <div class="slide-items" role="list">
                ${paneRow('left', obj.left)}
                ${paneRow('right', obj.right)}
            </div>
            <button type="button" class="btn btn--sm editor-secondary-btn" id="view-pick">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="7" height="14" rx="1"/><rect x="14" y="5" width="7" height="14" rx="1"/></svg>
                <span>Choose Slides</span>
            </button>
        </section>
        <div class="editor-prop-row" aria-label="Split">
            <!-- The two panes, drawn to scale: drag the line between them, or
                 pick a preset below. The divider on the slide itself can be
                 dragged too. -->
            <div class="vs-split" id="view-split" data-ratio="${ratio}">
                <div class="vs-pane vs-pane--l"><span id="vs-label-l"></span></div>
                <div class="vs-handle" role="slider" tabindex="0" aria-label="Divider position"
                     aria-valuemin="${RATIO_MIN}" aria-valuemax="${RATIO_MAX}" aria-valuenow="${ratio}"></div>
                <div class="vs-pane vs-pane--r"><span id="vs-label-r"></span></div>
            </div>
            <div class="vs-presets" role="group" aria-label="Split presets">
                ${RATIO_PRESETS.map(p => `
                <button type="button" class="vs-preset" data-ratio="${p.v}" title="${p.v} : ${100 - p.v}">
                    <span class="vs-mini"><i style="flex:${p.v}"></i><i style="flex:${100 - p.v}"></i></span>
                    <span>${p.l}</span>
                </button>`).join('')}
            </div>
        </div>
        <!-- One widget across both slides (slides/split-widgets.js): filled
             in once the view's config is read. -->
        <section class="wf-group" id="view-split-widget" aria-label="Split widget"></section>
    `;
}

// One row per pane: click it to leave the split view and edit that slide on
// its own, with everything on it in the panel.
const PANE_ICON = {
    left:  '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="4" width="8" height="16" rx="2" fill="currentColor" fill-opacity="0.25"/>',
    right: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="13" y="4" width="8" height="16" rx="2" fill="currentColor" fill-opacity="0.25"/>',
};
function paneRow(side, idx) {
    if (idx == null) return `
        <div class="slide-item is-empty" role="listitem">
            <span class="slide-item-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PANE_ICON[side]}</svg></span>
            <span class="slide-item-text">
                <span class="slide-item-name">No Slide</span>
                <span class="slide-item-kind">${side === 'left' ? 'Left Pane' : 'Right Pane'}</span>
            </span>
        </div>`;
    const label = getSlideLabels(ctx.state.slideStructure)[idx] ?? '';
    return `
        <div class="slide-item" role="listitem" tabindex="0" data-pane="${side}" data-index-to="${idx}" title="Edit Slide ${escAttr(label)}">
            <span class="slide-item-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PANE_ICON[side]}</svg></span>
            <span class="slide-item-text">
                <span class="slide-item-name">Slide ${escHtml(label)}</span>
                <span class="slide-item-kind">${side === 'left' ? 'Left Pane' : 'Right Pane'}</span>
            </span>
            <svg class="slide-item-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </div>`;
}

// Close the split and go to one of its slides, in the editor as usual.
async function editPaneSlide(idx) {
    hideViewConfig();
    if (ctx.state.splitView) {
        document.getElementById('split-toggle')?.click();
        await new Promise(r => setTimeout(r, 250));
    }
    bus.emit('slide:goto', idx);
}

function wireViewConfigHandlers(i, obj) {
    const get = id => document.getElementById(id);

    document.querySelectorAll('#editor-view-body .slide-item[data-index-to]').forEach(row => {
        const go = () => editPaneSlide(parseInt(row.dataset.indexTo, 10));
        row.addEventListener('click', go);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    function saveAndRefresh() {
        const ratioVal = get('view-split')?.dataset.ratio ?? '50';
        obj.ratio = parseInt(ratioVal, 10);
        bus.emit('nav:refresh');
    }

    // When either pane changes, re-render the panel so exclusions update.
    // ...and show the new pair on stage (it may fill an Undefined pane).
    // Choose Slides: click the two in the slide list, then show the new pair.
    get('view-pick')?.addEventListener('click', () => {
        pickPanes({ onDone: (left, right) => {
            if (ctx.state.slideStructure[i] !== obj) return;   // the view moved or went
            obj.left = left;
            obj.right = right;
            bus.emit('nav:refresh');
            showViewConfig(i);
            bus.emit('slide:goto', i);
        } });
    });

    wireSplitPicker(get('view-split'), obj, () => {
        saveAndRefresh();
        // Show it on stage too — this view is what's being previewed.
        if (ctx.state?.splitView && ctx.state.currentViewIndex === i) {
            bus.emit('view:ratio-commit', obj.ratio);
        }
    });

}

// The split picker: two panes drawn to scale with a draggable line between
// them (arrow keys nudge it), and presets underneath. `commit` runs when a
// change lands — on release, a preset click, or a key — not on every pixel
// of a drag, since applying it re-renders both slides.
let _unsubDragged = null;   // one listener, for the panel showing now
function wireSplitPicker(box, obj, commit) {
    if (!box) return;
    const handle  = box.querySelector('.vs-handle');
    const presets = box.parentElement.querySelectorAll('.vs-preset');
    const labelL  = box.querySelector('#vs-label-l');
    const labelR  = box.querySelector('#vs-label-r');

    function show(r) {
        box.dataset.ratio = String(r);
        box.style.setProperty('--vs-ratio', `${r}%`);
        handle.setAttribute('aria-valuenow', String(r));
        labelL.textContent = `${r}%`;
        labelR.textContent = `${100 - r}%`;
        presets.forEach(p => p.classList.toggle('is-active', Math.abs(Number(p.dataset.ratio) - r) <= 1));
    }
    const clampR = (r) => Math.max(RATIO_MIN, Math.min(RATIO_MAX, Math.round(r)));
    const set = (r) => { show(clampR(r)); commit(); };

    show(clampR(obj.ratio ?? 50));
    // The stage's own divider was dragged: follow it.
    _unsubDragged?.();
    _unsubDragged = bus.on('view:ratio-dragged', (r) => { if (box.isConnected) show(clampR(r)); });

    const fromPointer = (e) => {
        const r = box.getBoundingClientRect();
        return ((e.clientX - r.left) / r.width) * 100;
    };
    box.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        box.setPointerCapture(e.pointerId);
        box.classList.add('is-dragging');
        show(clampR(fromPointer(e)));
        const move = (ev) => show(clampR(fromPointer(ev)));
        const up = () => {
            box.classList.remove('is-dragging');
            box.removeEventListener('pointermove', move);
            box.removeEventListener('pointerup', up);
            box.removeEventListener('pointercancel', up);
            commit();
        };
        box.addEventListener('pointermove', move);
        box.addEventListener('pointerup', up);
        box.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 10 : 1;
        const cur = Number(box.dataset.ratio);
        if (e.key === 'ArrowLeft')  { e.preventDefault(); e.stopPropagation(); set(cur - step); }
        if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); set(cur + step); }
    });
    presets.forEach(p => p.addEventListener('click', () => set(Number(p.dataset.ratio))));
}


/* ─── the split widget ───────────────────────────────────────────
   A view can carry one widget that spans both of its slides — the Python
   workspace's code on the left slide and a pane of it on the right. It is
   kept in the view's own config and works only while the split is on
   screen; each slide alone shows its half as it was left. The widget's
   schema names its halves ("split": { left: [...], right: [...] }); the
   first of each is where it starts. Audience Response: the question left,
   the answers and the QR banner right. */
const PANE_NAMES = { editor: 'Editor', shell: 'Shell', memory: 'Memory', debug: 'Debugger',
                     question: 'Question', answers: 'Answers & QR' };
const SETTINGS_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const TRASH_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';

let _fillToken = 0;
async function fillSplitWidgetSection(i, obj) {
    const token = ++_fillToken;
    const host = document.getElementById('view-split-widget');
    if (!host) return;
    // An older deck's view may have no id yet; the config needs one.
    if (!obj.viewId) obj.viewId = `v${Date.now()}`;
    await loadSplitConfig(obj.viewId);
    const catalog = (await widgetCatalog()).filter(w => w.split);
    if (token !== _fillToken || !host.isConnected) return;

    const w = splitWidgetsOf(obj)[0] || null;
    const title = '<div class="wf-group-title">Split Widget</div>';
    if (!w) {
        host.innerHTML = `${title}
            <p class="slide-items-empty">One widget across both slides: half on the left slide, half on the right. It works while the split is on screen; each slide alone shows its half as it was left.</p>
            <div class="view-split-add" role="list">
                ${catalog.map(c => `
                <button type="button" class="btn btn--sm editor-secondary-btn" data-add-split="${escAttr(c.type)}">
                    <span class="view-split-add-icon">${widgetIcon(c.type)}</span>
                    <span>Add ${escHtml(c.label)}</span>
                </button>`).join('') || '<p class="slide-items-empty">No widget can be split yet.</p>'}
            </div>`;
        host.querySelectorAll('[data-add-split]').forEach(b =>
            b.addEventListener('click', () => addSplitWidget(i, obj, b.dataset.addSplit,
                catalog.find(c => c.type === b.dataset.addSplit)?.split)));
        return;
    }

    const entry = catalog.find(c => c.type === w.type);
    const label = w.title || entry?.label || w.type;
    const spec = entry?.split || { left: ['editor'], right: ['shell', 'memory', 'debug'] };
    const leftName = PANE_NAMES[w.split?.left || spec.left?.[0]] || w.split?.left || 'Editor';
    const right = w.split?.right || spec.right?.[0];
    host.innerHTML = `${title}
        <div class="slide-items" role="list">
            <div class="slide-item view-split-item" role="listitem">
                <span class="slide-item-icon">${widgetIcon(w.type)}</span>
                <span class="slide-item-text">
                    <span class="slide-item-name">${escHtml(label)}</span>
                    <span class="slide-item-kind">${escHtml(leftName)} left · ${escHtml(PANE_NAMES[right] || right)} right</span>
                </span>
                <button type="button" class="btn btn--ghost btn--icon btn--sm" id="view-split-settings" title="Settings" aria-label="Settings">${SETTINGS_ICON}</button>
                <button type="button" class="btn btn--ghost btn--icon btn--sm btn--danger" id="view-split-delete" title="Delete" aria-label="Delete">${TRASH_ICON}</button>
            </div>
        </div>
        ${(spec.right || []).length > 1 ? `
        <div class="editor-prop-row">
            <span class="editor-prop-label">Right Slide Starts On</span>
            <div class="wf-seg" role="group" id="view-split-right">
                ${spec.right.map(p => `<button type="button" class="wf-seg-btn${p === right ? ' is-active' : ''}" data-v="${escAttr(p)}" aria-pressed="${p === right}">${escHtml(PANE_NAMES[p] || p)}</button>`).join('')}
            </div>
        </div>` : ''}`;

    host.querySelector('#view-split-settings')?.addEventListener('click', () => openWidgetSettings(w.id));
    const del = host.querySelector('#view-split-delete');
    del?.addEventListener('click', () => {
        // Armed first, like the panel's own Delete: a second click deletes.
        if (!del.classList.contains('is-armed')) {
            del.classList.add('is-armed');
            del.title = 'Click Again to Delete';
            clearTimeout(del._t);
            del._t = setTimeout(() => { del.classList.remove('is-armed'); del.title = 'Delete'; }, 3000);
            return;
        }
        removeSplitWidget(obj, w);
        fillSplitWidgetSection(i, obj);
    });
    host.querySelectorAll('#view-split-right [data-v]').forEach(b => b.addEventListener('click', () => {
        w.split = { ...(w.split || {}), right: b.dataset.v };
        // The running widget switches over too (it takes settings live).
        pushWidgetConfig(w.id, w);
        fillSplitWidgetSection(i, obj);
    }));
}

function addSplitWidget(i, obj, type, spec) {
    const s = ctx.state;
    const key = obj.viewId;
    if (!s.slideConfigs[key]) s.slideConfigs[key] = {};
    const cfg = s.slideConfigs[key];
    if (!Array.isArray(cfg.widgets)) cfg.widgets = [];
    // One per split view: it fills both slides.
    if (cfg.widgets.some(w => w?.split)) return;
    cfg.widgets.push({
        id: `widget_${Date.now()}`,
        type,
        src: '',
        builtin: true,
        x: 0, y: 0, width: 1, height: 1,
        zIndex: 10,
        split: { left: spec?.left?.[0] || 'editor', right: spec?.right?.[0] || 'shell' },
    });
    queueSync();
    fillSplitWidgetSection(i, obj);
    // Show the pair on stage, if it isn't already.
    if (!(s.splitView && s.currentViewIndex === i)) bus.emit('slide:goto', i);
}

function removeSplitWidget(obj, w) {
    const cfg = ctx.state.slideConfigs[obj.viewId];
    if (!cfg?.widgets) return;
    cfg.widgets = cfg.widgets.filter(x => x !== w);
    // Both halves go: they are one widget, and its iframe goes with it.
    bus.emit('split-widgets:changed');
}
