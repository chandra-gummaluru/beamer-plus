// Edit mode for Beamer+ — entry point wiring the editor together.
//
// Module map:
// - context.js       shared editor state + config helpers
// - overlays.js      draggable/resizable overlay boxes, add-media picking
// - properties.js    properties panel (position/size + per-type fields)
// - widget-panel.js  a selected widget's settings, in the same panel
// - widget-settings.js  parent half of the widget-owned settings protocol
// - widget-picker.js "Add Widget" modal
// - view-config.js   view-slide (saved split view) configuration panel
// - reorder.js       drag & drop slide reordering
// - save.js          rebuild + download the presentation ZIP
// - notes-export.js  the notes version: one flat PDF with everything drawn in
// - download-menu.js the download button's chooser between the two
import { bus } from '../core/events.js';
import { ctx, setPanelMode } from './context.js';
import { renderEditOverlays, cleanupEditOverlays, deselectOverlay, pickMediaFile, onMediaFileSelected, addReveal, repositionEditOverlays } from './overlays.js';
import { updatePropertiesPanel, refreshSlideItems, initItemRemove } from './properties.js';
import { addWidget } from './widget-picker.js';
import { showViewConfig, hideViewConfig } from './view-config.js';
import { applySlideReorder, removeSlideReorder } from './reorder.js';
import { initWidgetSettings } from './widget-settings.js';
import { initWidgetSettingsDialog, closeWidgetSettings } from './widget-settings-dialog.js';
import { initNumberSteppers } from './number-stepper.js';
import { initDropdowns } from './dropdown.js';
import { titleCase } from './title-case.js';
import { realSlideCount, insertViewAfterCurrent, removeSlideAt } from '../slides/structure.js';
import { pickPanes, cancelPick } from './pane-picker.js';
import { PAPER_STYLES, PAPER_SPACING, PAPER_THICKNESS, PAPER_COLORS, normalizePaper, applyPaper } from '../slides/paper.js';

/* ─── init ──────────────────────────────────────────────────── */

export function initEditor(state) {
    ctx.state = state;
    state.editMode = false;
    state.editorNewFiles = {};

    document.getElementById('edit-mode-btn')?.addEventListener('click', toggleEditMode);
    document.getElementById('edit-add-video-btn')?.addEventListener('click', () => pickMediaFile('video', 'video/*'));
    document.getElementById('edit-add-audio-btn')?.addEventListener('click', () => pickMediaFile('audio', 'audio/*'));
    document.getElementById('edit-add-model-btn')?.addEventListener('click', () => pickMediaFile('model', '.glb,.gltf'));
    document.getElementById('edit-add-widget-btn')?.addEventListener('click', addWidget);
    document.getElementById('edit-add-reveal-btn')?.addEventListener('click', addReveal);

    initPaperSettings();

    document.getElementById('editor-done-btn')?.addEventListener('click', () => { if (ctx.state.editMode) exitEditMode(); });

    // Typing a widget's name in the header: letters are the name, not slide
    // shortcuts; Enter or Esc puts it down.
    const titleEl = document.getElementById('editor-panel-title');
    titleEl?.addEventListener('keydown', e => {
        if (titleEl.readOnly) return;
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') titleEl.blur();
    });
    titleEl?.addEventListener('blur', () => {
        // Show the fallback name again if it was cleared.
        if (!titleEl.readOnly && !titleEl.value.trim()) titleEl.value = '';
    });

    // The toolbar's eye: shown or skipped while presenting.
    document.getElementById('slide-shown-btn')?.addEventListener('click', () => {
        const obj = ctx.state?.slideStructure?.[toolbarSlideIndex()];
        if (!obj) return;
        if (obj.hidden) delete obj.hidden;
        else obj.hidden = true;
        bus.emit('nav:refresh');
        _updateAddMediaButtons();
    });

    // The toolbar's trash: two clicks — the first arms it — since there's no
    // undo. On a split view it deletes the split view (not its slides).
    const delBtn = document.getElementById('slide-delete');
    delBtn?.addEventListener('click', () => {
        const i = toolbarSlideIndex();
        const obj = i == null ? null : ctx.state?.slideStructure?.[i];
        if (!obj) return;
        if (!delBtn.classList.contains('is-armed')) {
            armSlideDelete(true);
            clearTimeout(armSlideDelete.timer);
            armSlideDelete.timer = setTimeout(() => armSlideDelete(false), 3000);
            return;
        }
        armSlideDelete(false);
        if (obj.type === 'view') {
            // Close the panel first, so it isn't still pointing at the view
            // while removeSlideAt remaps everything position-keyed.
            hideViewConfig();
            removeSlideAt(i);
            if (ctx.state.splitView) document.getElementById('split-toggle')?.click();
            bus.emit('nav:refresh');
            // Once the split has closed, the toolbar is a slide's again.
            setTimeout(() => { if (!ctx.state.splitView) updateSlideSettingsPanel(); }, 400);
            return;
        }
        bus.emit('slide:delete', i);
    });

    // The stage re-fits on resize (main.js); the edit boxes follow it.
    window.addEventListener('resize', () => {
        if (!ctx.state?.editMode) return;
        requestAnimationFrame(() => repositionEditOverlays());
    });

    const fileInput = document.getElementById('edit-media-input');
    fileInput?.addEventListener('change', () => onMediaFileSelected(fileInput));

    initItemRemove();
    initWidgetSettings();
    initWidgetSettingsDialog();
    initNumberSteppers();
    initDropdowns();
    wireDeselect();
    // The split's divider moved (the view panel's picker, or a drag on
    // stage): the slide under the edit boxes changed size — redraw them.
    bus.on('split:resized', () => {
        if (!ctx.state?.editMode) return;
        cleanupEditOverlays();
        renderEditOverlays();
        const sel = ctx.selectedOverlay;
        const div = sel && document.querySelector(`.edit-overlay[data-arr-key="${sel.arrKey}"][data-item-index="${sel.index}"]`);
        if (div) { div.classList.add('selected'); sel.div = div; }
    });

    bus.on('slides:loaded', () => { if (ctx.state?.editMode) applySlideReorder(); });

    // The view slide being configured is referenced by position, so it has
    // to follow a reorder/insert/delete like everything else. Its panel is
    // rebuilt too: the pane dropdowns are built from positions and labels,
    // both of which have just changed.
    bus.on('slides:remapped', (oldToNew) => {
        if (ctx.selectedViewIdx === null) return;
        const next = oldToNew(ctx.selectedViewIdx);
        if (next == null || ctx.state.slideStructure[next]?.type !== 'view') { hideViewConfig(); return; }
        ctx.selectedViewIdx = next;
        if (ctx.state.editMode) showViewConfig(next);
    });

    bus.on('slide:changed', () => {
        if (!ctx.state?.editMode) return;
        ctx.selectedOverlay = null;
        cleanupEditOverlays();

        if (ctx.selectedViewIdx !== null) {
            // A split view is being configured — check if we're still on one of its panes
            // AND split view is still active (if split closed, we've navigated away).
            const viewObj = ctx.state.slideStructure?.[ctx.selectedViewIdx];
            // currentViewIndex covers a view with an undefined pane, whose
            // stand-in index may be neither pane (both undefined).
            const onPane  = ctx.state.splitView && viewObj && (
                ctx.state.currentSlide === (viewObj.left  ?? -1) ||
                ctx.state.currentSlide === (viewObj.right ?? -1) ||
                ctx.state.currentViewIndex === ctx.selectedViewIdx
            );
            if (onPane) {
                // Stay in split view config mode: don't render overlays or show
                // the regular slide settings — the view config panel is the only UI.
                _updateAddMediaButtons();
                return;
            }
            // Navigated away from the view panes — tear down.
            hideViewConfig();
            if (ctx.state.splitView) document.getElementById('split-toggle')?.click();
        } else {
            hideViewConfig();
        }

        // Regular slide — show its overlays and settings normally.
        renderEditOverlays();
        updatePropertiesPanel();
        updateSlideSettingsPanel();
        _updateAddMediaButtons();
    });

    // A new split view: click its two slides, then it's made and shown.
    bus.on('view:insert-pick', () => {
        if (!ctx.state?.editMode) return;
        pickPanes({ onDone: (left, right) => insertViewAfterCurrent({ left, right }) });
    });

    bus.on('view:select', (i) => {
        if (!ctx.state?.editMode) return;
        const obj = ctx.state.slideStructure?.[i];
        if (!obj || obj.type !== 'view') return;
        ctx.selectedOverlay = null;
        cleanupEditOverlays();
        updatePropertiesPanel();  // hides (no overlay)
        showViewConfig(i);
        _updateAddMediaButtons();
    });
}

/* ─── mode ──────────────────────────────────────────────────── */

function toggleEditMode() {
    if (ctx.state.editMode) exitEditMode(); else enterEditMode();
}

async function enterEditMode() {
    closeWidgetSettings();   // its widget is about to become a box on the slide
    ctx.state.editMode = true;
    document.body.classList.add('edit-mode');
    setPanelMode('slide');
    // The panel and the insert toolbar take room from the stage: re-fit it.
    window.dispatchEvent(new Event('resize'));
    if (ctx.state.annCvs?.canvas) ctx.state.annCvs.canvas.style.pointerEvents = 'none';

    // If we entered edit mode while a split view was active, keep it visible
    // and show the view config panel, previewed at the view's own ratio
    // (50/50 for a split that isn't a saved view).
    if (ctx.state.splitView) {
        let viewIdx = ctx.state.slideStructure?.findIndex(s =>
            s.type === 'view' &&
            s.left  === ctx.state.currentSlide &&
            s.right === ctx.state.rightSlideIndex
        ) ?? -1;
        // A view with an undefined pane doesn't match by panes.
        if (viewIdx === -1 && ctx.state.currentViewIndex != null) viewIdx = ctx.state.currentViewIndex;
        if (viewIdx !== -1) {
            ctx.selectedViewIdx = viewIdx;
            showViewConfig(viewIdx);
        }
        bus.emit('view:ratio-commit', viewIdx !== -1 ? (ctx.state.slideStructure[viewIdx].ratio ?? 50) : 50);
        await new Promise(r => setTimeout(r, 350));
    }

    applySlideReorder();
    setTimeout(() => { renderEditOverlays(); updateSlideSettingsPanel(); _updateAddMediaButtons(); }, 60);
}

async function exitEditMode() {
    // A split on stage stays there, like any slide: Done leaves you where you
    // were. Edit mode previews a split you opened yourself at 50/50, so it
    // goes back to where you had the divider (a view slide keeps its ratio).
    let splitRatio = null;
    if (ctx.state.splitView) {
        const v = ctx.state.currentViewIndex != null ? ctx.state.slideStructure[ctx.state.currentViewIndex] : null;
        splitRatio = v?.type === 'view' ? (v.ratio ?? ctx.state.manualSplitRatio ?? 50) : (ctx.state.manualSplitRatio ?? 50);
    }
    cancelPick();
    ctx.state.editMode = false;
    document.body.classList.remove('edit-mode');
    if (ctx.state.annCvs?.canvas) ctx.state.annCvs.canvas.style.pointerEvents = '';
    cleanupEditOverlays();
    removeSlideReorder();
    ctx.selectedOverlay = null;
    hideViewConfig();
    updatePropertiesPanel();
    window.dispatchEvent(new Event('resize'));
    bus.emit('editor:exited', { splitRatio });
}

/* ─── deselecting ───────────────────────────────────────────── */

// An item's properties replace the slide's, so there has to be a way back:
// the panel's back link, Escape, or a click on empty space on the slide.
function wireDeselect() {
    document.getElementById('editor-props-back')?.addEventListener('click', deselectOverlay);

    bus.on('ui:escape', () => {
        if (!ctx.state?.editMode) return;
        // Escape belongs to whatever is layered on top — a modal or the widget
        // picker gets it first, and only a bare Escape clears the selection.
        if (document.querySelector('.custom-modal-overlay, #widget-modal-overlay')) return;
        deselectOverlay();
    });

    // Pointerdown rather than click: overlays capture the pointer on
    // pointerdown, so a click that starts on empty space never reaches here.
    document.addEventListener('pointerdown', (e) => {
        if (!ctx.state?.editMode || !ctx.selectedOverlay) return;
        // Only clicks on the slide stage itself deselect — not the editor
        // panel, the toolbars, or anything floating above them.
        if (!e.target.closest('#main-content')) return;
        if (e.target.closest('.edit-overlay')) return;
        deselectOverlay();
    });
}

/* ─── slide settings panel ─────────────────────────────────── */

function updateSlideSettingsPanel() {
    const obj   = ctx.state?.slideStructure?.[ctx.state?.currentSlide];
    syncPaperSettings(obj);
    refreshSlideItems();
    armSlideDelete(false);
    _updateAddMediaButtons();
    // The header names the slide; a selection elsewhere names itself.
    if (!ctx.selectedOverlay && ctx.selectedViewIdx === null) setPanelMode('slide');
}

// Armed, the toolbar's trash turns red and says "Click Again to Delete".
function armSlideDelete(on) {
    const btn = document.getElementById('slide-delete');
    if (!btn) return;
    btn.classList.toggle('is-armed', on);
    const view = ctx.state?.slideStructure?.[toolbarSlideIndex()]?.type === 'view';
    btn.title = on ? 'Click Again to Delete' : view ? 'Delete Split View' : 'Delete Slide';
}

/* ─── blank-slide paper ─────────────────────────────────────── */
const PAPER_FIELDS = { style: PAPER_STYLES, spacing: PAPER_SPACING, thickness: PAPER_THICKNESS, color: PAPER_COLORS };

function initPaperSettings() {
    for (const [key, list] of Object.entries(PAPER_FIELDS)) {
        const sel = document.getElementById(`paper-${key}`);
        if (!sel) continue;
        sel.innerHTML = list.map(o => `<option value="${o.v}">${titleCase(o.l)}</option>`).join('');
        // The choices as little pages (drawn in syncPaperSettings).
        const tiles = document.querySelector(`.paper-tiles[data-paper="${key}"]`);
        if (tiles) {
            tiles.style.setProperty('--n', list.length);
            tiles.innerHTML = list.map(o => `
                <button type="button" class="paper-tile" role="radio" data-v="${o.v}" title="${titleCase(o.l)}">
                    <span class="paper-tile-page"></span><span class="paper-tile-name">${titleCase(o.l)}</span>
                </button>`).join('');
            tiles.querySelectorAll('.paper-tile').forEach(t => t.addEventListener('click', () => {
                if (sel.value === t.dataset.v) return;
                sel.value = t.dataset.v;
                sel.dispatchEvent(new Event('change'));
            }));
        }
        sel.addEventListener('change', () => {
            const obj = ctx.state?.slideStructure?.[ctx.state?.currentSlide];
            if (obj?.type !== 'blank') return;
            const paper = { ...normalizePaper(obj.paper), [key]: sel.value };
            if (paper.style === 'none') delete obj.paper; else obj.paper = paper;
            syncPaperSettings(obj);
            bus.emit('paper:changed');
        });
    }
}

function syncPaperSettings(obj) {
    const section = document.getElementById('slide-paper-section');
    if (section) section.hidden = obj?.type !== 'blank';
    if (obj?.type !== 'blank') return;
    const p = normalizePaper(obj.paper);
    for (const key of Object.keys(PAPER_FIELDS)) {
        const sel = document.getElementById(`paper-${key}`);
        if (sel) sel.value = p[key];
    }
    const opts = document.getElementById('paper-options');
    if (opts) opts.hidden = p.style === 'none';
    const tl = document.getElementById('paper-thickness-label');
    if (tl) tl.textContent = p.style === 'dots' ? 'Dot Size' : 'Line Weight';
    // Each little page is this paper with that one choice changed. The
    // backgrounds show the style close up; the rest draw it at 3× so the
    // spacings, weights and colours tell apart at that size.
    for (const key of Object.keys(PAPER_FIELDS)) {
        document.querySelectorAll(`.paper-tiles[data-paper="${key}"] .paper-tile`).forEach(t => {
            const on = p[key] === t.dataset.v;
            t.classList.toggle('is-selected', on);
            t.setAttribute('aria-checked', String(on));
            const look = { ...p, [key]: t.dataset.v };
            if (key !== 'style' && look.style === 'none') look.style = 'grid';
            applyPaper(t.querySelector('.paper-tile-page'), look, key === 'style' ? { card: true } : { zoom: 3 });
        });
    }
}

// The slide the toolbar's eye and trash act on: the one on stage, or while
// a split view is on stage, the split view itself (null for a split you
// opened yourself, which isn't a slide).
function toolbarSlideIndex() {
    const s = ctx.state;
    if (!s) return null;
    if (s.splitView) return ctx.selectedViewIdx ?? s.currentViewIndex ?? null;
    return s.currentSlide;
}

// What the insert toolbar can do here. On a split view only the eye and the
// trash are live: everything else adds to a slide, and a split view has
// none of its own.
function _updateAddMediaButtons() {
    const s = ctx.state;
    const split = !!s?.splitView;
    const set = (id, off) => { const b = document.getElementById(id); if (b) b.disabled = off; };
    for (const id of ['edit-add-video-btn', 'edit-add-audio-btn', 'edit-add-model-btn', 'edit-add-widget-btn',
                      'edit-add-reveal-btn', 'edit-add-page-btn', 'edit-duplicate-btn', 'bookmark-btn']) set(id, split);
    // A split view pairs two real slides — none to pair until there are two.
    set('add-view-btn', split || realSlideCount(s?.slideStructure) < 2);

    const i = toolbarSlideIndex();
    const obj = i == null ? null : s?.slideStructure?.[i];
    // The last real slide stays (a split view can always go).
    set('slide-delete', !obj || (obj.type !== 'view' && (s?.slideStructure?.length || 0) <= 1));
    const del = document.getElementById('slide-delete');
    if (del && !del.classList.contains('is-armed')) del.title = obj?.type === 'view' ? 'Delete Split View' : 'Delete Slide';

    const eye = document.getElementById('slide-shown-btn');
    if (eye) {
        eye.disabled = !obj;
        const hidden = !!obj?.hidden;
        eye.classList.toggle('btn_selected', hidden);
        eye.setAttribute('aria-pressed', String(hidden));
        eye.title = hidden ? 'Skipped During Presentation: Click to Show' : 'Hide During Presentation';
    }
}
