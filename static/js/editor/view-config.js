// View-slide configuration panel — pick the two pane slides and the divider
// ratio for a saved split view, or delete the view slide.
import { bus } from '../core/events.js';
import { getSlideLabels, removeSlideAt } from '../slides/structure.js';
import { ctx, escAttr, escHtml, setPanelMode, resolvePanelMode } from './context.js';

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
    // null: the pane's slide was deleted — shown as unselected.
    const leftVal  = obj.left  ?? '';
    const rightVal = obj.right ?? '';
    const ratio    = obj.ratio !== undefined ? obj.ratio : 50;

    // Each dropdown excludes the view slide itself and the OTHER pane's choice.
    const leftExclude  = [viewIdx, ...(rightVal !== '' ? [Number(rightVal)] : [])];
    const rightExclude = [viewIdx, ...(leftVal  !== '' ? [Number(leftVal)]  : [])];

    return `
        <div class="editor-prop-row">
            <div class="editor-prop-label">Left pane slide</div>
            <select class="editor-prop-select" id="view-left" style="margin-top:var(--sp-1)">
                ${buildSlideOptions(leftVal, 'Select a slide...', leftExclude)}
            </select>
        </div>
        <div class="editor-prop-row">
            <div class="editor-prop-label">Right pane slide</div>
            <select class="editor-prop-select" id="view-right" style="margin-top:var(--sp-1)">
                ${buildSlideOptions(rightVal, 'Select a slide...', rightExclude)}
            </select>
        </div>
        <div class="editor-prop-row">
            <div class="editor-prop-label">Split</div>
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
        <button class="btn editor-delete-btn" id="view-delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            Remove view
        </button>
    `;
}

function wireViewConfigHandlers(i, obj) {
    const get = id => document.getElementById(id);

    function saveAndRefresh() {
        const leftVal  = get('view-left')?.value  ?? '';
        const rightVal = get('view-right')?.value ?? '';
        const ratioVal = get('view-split')?.dataset.ratio ?? '50';
        if (leftVal  !== '') obj.left  = parseInt(leftVal,  10); else delete obj.left;
        if (rightVal !== '') obj.right = parseInt(rightVal, 10); else delete obj.right;
        obj.ratio = parseInt(ratioVal, 10);
        bus.emit('nav:refresh');
    }

    // When either pane changes, re-render the panel so exclusions update.
    // ...and show the new pair on stage (it may fill an Undefined pane).
    get('view-left')?.addEventListener('change',  () => { saveAndRefresh(); showViewConfig(i); bus.emit('slide:goto', i); });
    get('view-right')?.addEventListener('change', () => { saveAndRefresh(); showViewConfig(i); bus.emit('slide:goto', i); });

    wireSplitPicker(get('view-split'), obj, () => {
        saveAndRefresh();
        // Show it on stage too — this view is what's being previewed.
        if (ctx.state?.splitView && ctx.state.currentViewIndex === i) {
            bus.emit('view:ratio-commit', obj.ratio);
        }
    });

    get('view-delete')?.addEventListener('click', () => {
        if (ctx.selectedViewIdx === null) return;
        const delIdx = ctx.selectedViewIdx;
        // Close the panel first, so it isn't still pointing at the view while
        // the remap runs. removeSlideAt shifts everything position-keyed —
        // including the right pane and text boxes, which the old hand-rolled
        // shift here missed.
        hideViewConfig();
        removeSlideAt(delIdx);
        if (ctx.state.splitView) document.getElementById('split-toggle')?.click();
        bus.emit('nav:refresh');
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

// Build <option> list from all slides (all types), using structure index as the value.
// excludeIdx may be a single number or an array of numbers to skip. Labels match the navigator.
function buildSlideOptions(selectedVal, emptyLabel, excludeIdx) {
    let html = `<option value="">${escHtml(emptyLabel)}</option>`;
    if (!ctx.state?.slideStructure) return html;
    const excluded = excludeIdx === undefined || excludeIdx === null ? new Set()
                   : Array.isArray(excludeIdx) ? new Set(excludeIdx)
                   : new Set([excludeIdx]);
    const labels = getSlideLabels(ctx.state.slideStructure);
    ctx.state.slideStructure.forEach((s, idx) => {
        if (excluded.has(idx)) return;
        const sel = (selectedVal !== '' && selectedVal !== undefined && selectedVal !== null &&
                     String(idx) === String(selectedVal)) ? 'selected' : '';
        html += `<option value="${escAttr(String(idx))}" ${sel}>${escHtml(labels[idx])}</option>`;
    });
    return html;
}
