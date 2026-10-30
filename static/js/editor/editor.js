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
// - save.js          rebuild the presentation ZIP
// - notes-export.js  the notes version: one flat PDF with everything drawn in
import { bus } from '../core/events.js';
import { ctx, setPanelMode } from './context.js';
import { renderEditOverlays, cleanupEditOverlays, deselectOverlay, pickMediaFile, onMediaFileSelected, addReveal, repositionEditOverlays } from './overlays.js';
import { updatePropertiesPanel, refreshSlideItems, selectedItemKind, deleteSelectedItem } from './properties.js';
import { addWidget } from './widget-picker.js';
import { showViewConfig, hideViewConfig } from './view-config.js';
import { applySlideReorder, removeSlideReorder } from './reorder.js';
import { initWidgetSettings } from './widget-settings.js';
import { initWidgetSettingsDialog, closeWidgetSettings } from './widget-settings-dialog.js';
import { initNumberSteppers } from './number-stepper.js';
import { initDropdowns } from './dropdown.js';
import { realSlideCount, insertViewAfterCurrent, removeSlideAt } from '../slides/structure.js';
import { pickPanes, cancelPick } from './pane-picker.js';
import { normalizePaper } from '../slides/paper.js';
import { createPaperPicker } from '../slides/paper-picker.js';

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

    // The panel's footer: Hide During Presentation (a slide or split view)
    // and Delete — whatever the panel shows: the selected element, else the
    // slide, or on a split view the split view (not its slides). Delete
    // asks first, in a dialog like every other confirmation, since there's
    // no undo.
    document.getElementById('panel-hide')?.addEventListener('change', (e) => {
        const obj = ctx.state?.slideStructure?.[panelSlideIndex()];
        if (!obj) return;
        if (e.target.checked) obj.hidden = true; else delete obj.hidden;
        bus.emit('nav:refresh');
    });
    const delBtn = document.getElementById('panel-delete');
    delBtn?.addEventListener('click', () => {
        const what = delBtn.querySelector('span')?.textContent?.replace(/^Delete\s+/, '') || 'Slide';
        window.BeamerModal?.show({
            kind: 'warning',
            title: `Delete ${what}?`,
            message: 'This can’t be undone.',
            buttons: [
                { label: 'Cancel', kind: 'cancel' },
                { label: 'Delete', kind: 'ok', onClick: deleteFromPanel },
            ],
        });
    });
    function deleteFromPanel() {
        if (selectedItemKind()) { deleteSelectedItem(); return; }
        const i = panelSlideIndex();
        const obj = i == null ? null : ctx.state?.slideStructure?.[i];
        if (!obj) return;
        if (obj.type === 'view') {
            // Close the panel first, so it isn't still pointing at the view
            // while removeSlideAt remaps everything position-keyed.
            hideViewConfig();
            removeSlideAt(i);
            if (ctx.state.splitView) document.getElementById('split-toggle')?.click();
            bus.emit('nav:refresh');
            // Once the split has closed, the panel is a slide's again.
            setTimeout(() => { if (!ctx.state.splitView) updateSlideSettingsPanel(); }, 400);
            return;
        }
        bus.emit('slide:delete', i);
    }
    // Selecting something (or nothing) changes what the footer acts on.
    bus.on('editor:panel-mode', () => { armDelete(false); updatePanelFooter(); });

    // The stage re-fits on resize (main.js); the edit boxes follow it.
    window.addEventListener('resize', () => {
        if (!ctx.state?.editMode) return;
        requestAnimationFrame(() => repositionEditOverlays());
    });

    const fileInput = document.getElementById('edit-media-input');
    fileInput?.addEventListener('change', () => onMediaFileSelected(fileInput));

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

// The navigator's buttons while editing: Edit shows pressed (clicking it
// again leaves the editor), Record and Close are disabled until Done.
function syncNavTools(editing) {
    ['record-btn', 'session-close-btn'].forEach(id => {
        const b = document.getElementById(id);
        // A take in progress keeps its timer (the Record button) usable.
        if (b) b.disabled = editing && !(id === 'record-btn' && document.body.classList.contains('is-recording'));
    });
    const e = document.getElementById('session-edit-btn');
    if (!e) return;
    e.classList.toggle('btn_selected', editing);
    e.setAttribute('aria-pressed', String(editing));
    e.title = editing ? 'Finish Editing' : 'Edit Presentation';
    e.setAttribute('aria-label', e.title);
}

async function enterEditMode() {
    closeWidgetSettings();   // its widget is about to become a box on the slide
    ctx.state.editMode = true;
    document.body.classList.add('edit-mode');
    syncNavTools(true);
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
    syncNavTools(false);
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
    armDelete(false);
    _updateAddMediaButtons();
    // The header names the slide; a selection elsewhere names itself.
    if (!ctx.selectedOverlay && ctx.selectedViewIdx === null) setPanelMode('slide');
}

// Armed, Delete turns red; a second click within 3 s deletes.
function armDelete(on) {
    const btn = document.getElementById('panel-delete');
    if (!btn) return;
    clearTimeout(armDelete.timer);
    btn.classList.toggle('is-armed', on);
    btn.title = on ? 'Click Again to Delete' : '';
    if (on) armDelete.timer = setTimeout(() => armDelete(false), 3000);
}

// The footer for what the panel shows: Delete names it ("Delete Widget",
// "Delete Slide"…); Hide is for slides and split views only. The last real
// slide can't be deleted (a split view always can).
function updatePanelFooter() {
    const s = ctx.state;
    const kind = selectedItemKind();
    const i = panelSlideIndex();
    const obj = i == null ? null : s?.slideStructure?.[i];
    const del = document.getElementById('panel-delete');
    if (del) {
        del.querySelector('span').textContent = `Delete ${kind || (obj?.type === 'view' ? 'Split View' : 'Slide')}`;
        del.disabled = !kind && (!obj || (obj.type !== 'view' && (s?.slideStructure?.length || 0) <= 1));
    }
    const row = document.getElementById('panel-hide-row');
    if (row) row.hidden = !!kind || !obj;
    const hide = document.getElementById('panel-hide');
    if (hide) hide.checked = !!obj?.hidden;
}

/* ─── blank-slide paper ─────────────────────────────────────── */
// The same chooser as the Add Page window (slides/paper-picker.js), on the
// blank slide on stage.
let paperPicker = null;
const blankOnStage = () => {
    const obj = ctx.state?.slideStructure?.[ctx.state?.currentSlide];
    return obj?.type === 'blank' ? obj : null;
};

function initPaperSettings() {
    const host = document.getElementById('slide-paper-settings');
    if (!host) return;
    paperPicker = createPaperPicker({
        get: () => normalizePaper(blankOnStage()?.paper),
        set: (key, v) => {
            const obj = blankOnStage();
            if (!obj) return;
            const paper = { ...normalizePaper(obj.paper), [key]: v };
            if (paper.style === 'none') delete obj.paper; else obj.paper = paper;
            bus.emit('paper:changed');
        },
    });
    host.append(paperPicker.styles, paperPicker.options);
}

function syncPaperSettings(obj) {
    const section = document.getElementById('slide-paper-section');
    if (section) section.hidden = obj?.type !== 'blank';
    if (obj?.type === 'blank') paperPicker?.sync();
}

// The slide the panel's footer acts on: the one on stage, or while a split
// view is on stage, the split view itself (null for a split you opened
// yourself, which isn't a slide).
function panelSlideIndex() {
    const s = ctx.state;
    if (!s) return null;
    if (s.splitView) return ctx.selectedViewIdx ?? s.currentViewIndex ?? null;
    return s.currentSlide;
}

// What the insert toolbar can do here. On a split view nothing: everything
// adds to a slide, and a split view has none of its own (the toolbar hides).
function _updateAddMediaButtons() {
    const s = ctx.state;
    const split = !!s?.splitView;
    const set = (id, off) => { const b = document.getElementById(id); if (b) b.disabled = off; };
    for (const id of ['edit-add-video-btn', 'edit-add-audio-btn', 'edit-add-model-btn', 'edit-add-widget-btn',
                      'edit-add-reveal-btn', 'edit-add-page-btn', 'edit-duplicate-btn', 'bookmark-btn']) set(id, split);
    // A split view pairs two real slides — none to pair until there are two.
    set('add-view-btn', split || realSlideCount(s?.slideStructure) < 2);
    updatePanelFooter();
}
