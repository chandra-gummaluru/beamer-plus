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

function buildViewConfigHTML(obj, viewIdx) {
    const leftVal  = obj.left  !== undefined ? obj.left  : '';
    const rightVal = obj.right !== undefined ? obj.right : '';
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
            <div class="editor-flow-range-header">
                <div class="editor-prop-label">Divider position</div>
                <span class="editor-flow-range-val" id="view-ratio-val">${ratio}%</span>
            </div>
            <input type="range" class="editor-flow-range" id="view-ratio"
                   min="20" max="80" step="1" value="${ratio}">
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
        const ratioVal = get('view-ratio')?.value ?? '50';
        if (leftVal  !== '') obj.left  = parseInt(leftVal,  10); else delete obj.left;
        if (rightVal !== '') obj.right = parseInt(rightVal, 10); else delete obj.right;
        obj.ratio = parseInt(ratioVal, 10);
        bus.emit('nav:refresh');
    }

    // When either pane changes, re-render the panel so exclusions update.
    get('view-left')?.addEventListener('change',  () => { saveAndRefresh(); showViewConfig(i); });
    get('view-right')?.addEventListener('change', () => { saveAndRefresh(); showViewConfig(i); });

    const ratioEl  = get('view-ratio');
    const ratioLbl = get('view-ratio-val');
    ratioEl?.addEventListener('input', () => {
        if (ratioLbl) ratioLbl.textContent = `${ratioEl.value}%`;
    });
    ratioEl?.addEventListener('change', () => {
        saveAndRefresh();  // always persist the new ratio
        if (!ctx.state?.editMode) {
            bus.emit('view:ratio-commit', parseInt(ratioEl.value, 10));
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
