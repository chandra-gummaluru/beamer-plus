// Edit mode for Beamer+ — entry point wiring the editor together.
//
// Module map:
// - context.js       shared editor state + config helpers
// - overlays.js      draggable/resizable overlay boxes, add-media picking
// - properties.js    properties panel (position/size + per-type fields)
// - widget-settings.js  parent half of the widget-owned settings protocol
// - widget-picker.js "Add Widget" modal
// - view-config.js   view-slide (saved split view) configuration panel
// - reorder.js       drag & drop slide reordering
// - save.js          rebuild + download the presentation ZIP
import { bus } from '../core/events.js';
import { ctx, setPanelMode } from './context.js';
import { renderEditOverlays, cleanupEditOverlays, deselectOverlay, pickMediaFile, onMediaFileSelected } from './overlays.js';
import { updatePropertiesPanel } from './properties.js';
import { addWidget } from './widget-picker.js';
import { showViewConfig, hideViewConfig } from './view-config.js';
import { applySlideReorder, removeSlideReorder } from './reorder.js';
import { initWidgetSettings } from './widget-settings.js';
import { savePresentation } from './save.js';

/* ─── init ──────────────────────────────────────────────────── */

export function initEditor(state) {
    ctx.state = state;
    state.editMode = false;
    state.editorNewFiles = {};

    document.getElementById('edit-mode-btn')?.addEventListener('click', toggleEditMode);
    document.getElementById('edit-save-btn')?.addEventListener('click', savePresentation);
    document.getElementById('edit-add-video-btn')?.addEventListener('click', () => pickMediaFile('video', 'video/*'));
    document.getElementById('edit-add-audio-btn')?.addEventListener('click', () => pickMediaFile('audio', 'audio/*'));
    document.getElementById('edit-add-model-btn')?.addEventListener('click', () => pickMediaFile('model', '.glb,.gltf'));
    document.getElementById('edit-add-widget-btn')?.addEventListener('click', addWidget);

    document.getElementById('slide-hidden-toggle')?.addEventListener('change', e => {
        const obj = ctx.state?.slideStructure?.[ctx.state?.currentSlide];
        if (!obj) return;
        if (e.target.checked) obj.hidden = true;
        else delete obj.hidden;
        bus.emit('nav:refresh');
    });

    const fileInput = document.getElementById('edit-media-input');
    fileInput?.addEventListener('change', () => onMediaFileSelected(fileInput));

    initWidgetSettings();
    wireDeselect();

    bus.on('slides:loaded', () => { if (ctx.state?.editMode) applySlideReorder(); });

    bus.on('slide:changed', () => {
        if (!ctx.state?.editMode) return;
        ctx.selectedOverlay = null;
        cleanupEditOverlays();

        if (ctx.selectedViewIdx !== null) {
            // A split view is being configured — check if we're still on one of its panes
            // AND split view is still active (if split closed, we've navigated away).
            const viewObj = ctx.state.slideStructure?.[ctx.selectedViewIdx];
            const onPane  = ctx.state.splitView && viewObj && (
                ctx.state.currentSlide === (viewObj.left  ?? -1) ||
                ctx.state.currentSlide === (viewObj.right ?? -1)
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

    bus.on('view:select', (i) => {
        if (!ctx.state?.editMode) return;
        const obj = ctx.state.slideStructure?.[i];
        if (!obj || obj.type !== 'view') return;
        ctx.selectedOverlay = null;
        cleanupEditOverlays();
        updatePropertiesPanel();  // hides (no overlay)
        showViewConfig(i);
    });
}

/* ─── mode ──────────────────────────────────────────────────── */

function toggleEditMode() {
    if (ctx.state.editMode) exitEditMode(); else enterEditMode();
}

async function enterEditMode() {
    ctx.state.editMode = true;
    document.body.classList.add('edit-mode');
    setPanelMode('slide');
    const btn = document.getElementById('edit-mode-btn');
    if (btn) {
        btn.classList.add('is-close');
        btn.title = 'Exit edit mode';
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    }
    if (ctx.state.annCvs?.canvas) ctx.state.annCvs.canvas.style.pointerEvents = 'none';

    // If we entered edit mode while a split view was active, keep it visible
    // and show the view config panel.  Re-render at 50/50 for the edit preview.
    if (ctx.state.splitView) {
        const viewIdx = ctx.state.slideStructure?.findIndex(s =>
            s.type === 'view' &&
            s.left  === ctx.state.currentSlide &&
            s.right === ctx.state.rightSlideIndex
        ) ?? -1;
        if (viewIdx !== -1) {
            ctx.selectedViewIdx = viewIdx;
            showViewConfig(viewIdx);
        }
        bus.emit('view:ratio-commit', 50);
        await new Promise(r => setTimeout(r, 350));
    }

    applySlideReorder();
    setTimeout(() => { renderEditOverlays(); updateSlideSettingsPanel(); _updateAddMediaButtons(); }, 60);
}

async function exitEditMode() {
    // If a view slide was being previewed in split view, close that first
    if (ctx.state.splitView && ctx.selectedViewIdx !== null) {
        document.getElementById('split-toggle')?.click();
        await new Promise(r => setTimeout(r, 200));
    }
    ctx.state.editMode = false;
    document.body.classList.remove('edit-mode');
    const btn = document.getElementById('edit-mode-btn');
    if (btn) {
        btn.classList.remove('is-close');
        btn.title = 'Edit mode';
        if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    }
    if (ctx.state.annCvs?.canvas) ctx.state.annCvs.canvas.style.pointerEvents = '';
    cleanupEditOverlays();
    removeSlideReorder();
    ctx.selectedOverlay = null;
    hideViewConfig();
    updatePropertiesPanel();
    bus.emit('editor:exited');
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
    const obj    = ctx.state?.slideStructure?.[ctx.state?.currentSlide];
    const toggle = document.getElementById('slide-hidden-toggle');
    if (toggle) toggle.checked = !!obj?.hidden;
}

// Disable the add-media buttons when the current slide is a view slide
// (view slides have no content layer to attach media to).
function _updateAddMediaButtons() {
    const isView = ctx.state?.slideStructure?.[ctx.state?.currentSlide]?.type === 'view';
    for (const id of ['edit-add-video-btn', 'edit-add-audio-btn', 'edit-add-model-btn', 'edit-add-widget-btn']) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = isView;
    }
}
