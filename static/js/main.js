/**
 * Beamer+ main orchestrator.
 * Owns the shared presenter state, slide navigation and rendering, and the
 * split view. Feature modules (annotations, media, spotlight, editor, …) are
 * wired up here and communicate through the shared event bus.
 */
import { bus, addHoldListener } from './core/events.js';
import { initModal } from './core/modal.js';
import { Canvas } from './core/canvas.js';
import { updateWidgetPositions,
         parkWidgets, discardParkedWidgets, clearAllParked, setWidgetStates } from './core/iframe-widget-renderer.js';

import { initToolbar, initToolbarDrag } from './annotations/toolbar.js';
import { initPenSlots } from './annotations/pen-slots.js';
import { initShapeTools } from './annotations/shape-tools.js';
import { initTextAnnotations, wireTextCanvas, commitOpenTextEditor,
         clearTextBoxes, resetAllTextBoxes } from './annotations/text-annotate.js';

import { initNavigator } from './slides/navigator.js';
import { initThumbnails } from './slides/thumbnails.js';
import { initSlideStructure, getSlideLabels } from './slides/structure.js';
import { initSpotlight, hideSpotlight, renderSpotlight,
         setWidgetInteractivityForSpotlight } from './slides/spotlight.js';
import { initMedia, renderMedia, updateMediaPositions, resetMediaCache } from './slides/media.js';

import { initSettings, loadShortcuts } from './app/settings.js';
import { showHelpModal } from './app/help.js';
import { initUploader } from './app/uploader.js';
import { startTour } from './app/tour.js';
import { initEditor } from './editor/editor.js';
import { getSessionId, sessionUrl, saveLastSession } from './app/session.js';

/* ─── Render generation counters ─────────────────────────────── */
// Incremented each time a new render starts for each pane.
// Used to detect when a slow earlier render finishes after a faster later
// one has already taken over, so we don't let the stale render overwrite
// the slideKey that the fresh render already committed.
const _renderGen = { L: 0, R: 0 };

/* ─── shared state ────────────────────────────────────────────── */
const state = {
    currentSlide: 0,
    totalSlides: 0,
    bookmarks: {},
    splitView: false,
    rightSlideIndex: 0,
    currentViewIndex: null,   // deck index of the view slide driving the active split (null for manual splits)
    splitRatio: 50,
    annotationTool: 'hand',
    activePenSlot: 0,
    zipFile: null,
    slideStructure: [],
    slideConfigs: {},
    mediaCache: {},
    annotations: {},
    availableModels: [],
    annCvs: null,
    pdfCvs: null,
    annCvs2: null,
    pdfCvs2: null,
    activeAnnCvs: null,   // annotation pane the user last drew on (drives undo/redo/clear in split view)
    slideThumbnailCache: {},
    _pdfDocPromise: null,   // memoized parse of the current slides.pdf (see getPdfDoc)
    spotlight: { visible: false, pane: 'left', x: 0.5, y: 0.5 },
    spotlightOverlays: {},
};
window.beamerState = state;

/* ─── robust file reading ─────────────────────────────────────── */
// Reading a user-picked file can reject with NotFoundError ("A requested file
// or directory could not be found…") when the file lives in a cloud-synced
// folder as an "online-only" placeholder (OneDrive Files On-Demand, iCloud,
// Google Drive) or was moved/changed after it was selected. Retry once — the
// first read often triggers the OS to hydrate the file — then surface a clear,
// actionable message instead of the raw DOMException.
async function readUserFileBytes(file) {
    try {
        return await file.arrayBuffer();
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
        await new Promise(r => setTimeout(r, 400));
        try {
            return await file.arrayBuffer();
        } catch (_) {
            throw new Error(
                `Couldn't read "${file.name}". If it's stored in OneDrive, iCloud, ` +
                `or Google Drive it may be online-only — right-click it and choose ` +
                `"Always keep on this device" (or open it once to download it), ` +
                `then try uploading again.`
            );
        }
    }
}

/* ─── bootstrap ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    const sessionId = getSessionId();
    if (!sessionId) {
        window.location.replace('/');
        return;
    }
    saveLastSession(sessionId);

    // splash
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) { splash.style.opacity = '0'; setTimeout(() => splash.remove(), 400); }
    }, 1600);

    // core
    initModal(state);

    // canvases
    const annContainer  = document.getElementById('ann-canvas');
    const pdfContainer  = document.getElementById('pdf-canvas');
    const annContainer2 = document.getElementById('ann-canvas-2');
    const pdfContainer2 = document.getElementById('pdf-canvas-2');

    state.annCvs = new Canvas(annContainer, true);
    state.pdfCvs = new Canvas(pdfContainer, false);
    wireTextCanvas(state.annCvs, state);
    state.annCvs.setHistoryChangeHandler(updateHistoryBtns);
    updateHistoryBtns();
    sizeSlideCanvases();   // set pixel-exact 4:3 dimensions before any render
    // The Canvas constructors above read their container size before
    // sizeSlideCanvases() ran, so #ann-canvas (position:absolute, no CSS size)
    // measured 0×0 and the annotation bitmap is 0×0 — drawing produces nothing
    // until some resize path runs. Sync the bitmaps to the now-correct
    // container size so annotations work on first load (previously they only
    // started working after toggling split view / resizing the window).
    state.annCvs.resizeOnly();
    state.pdfCvs.resizeOnly();

    // modules
    initNavigator(state);
    initThumbnails(state);
    initSlideStructure(state);
    initMedia(state);
    initToolbar(state);
    initPenSlots(state);
    initToolbarDrag();   // after pen slots, so the first clamp sees the full rail
    initShapeTools(state);
    initTextAnnotations(state);
    initUploader(state);
    initEditor(state);
    initSettings();
    // Must run before applyDefaultPen(): that call emits a 'tool:change' to
    // sync other modules' tracked "previous tool" state (see below), and
    // spotlight.js's own 'tool:change' handler dereferences state that only
    // exists once initSpotlight(state) has run.
    initSpotlight(state);

    // pen + hand defaults
    applyDefaultPen();
    wireHandButton();
    wireEraserButton();
    wireFocusMode();
    wireSplitViewButton(annContainer2, pdfContainer2);
    wireBookmarkButton();
    wireUndoRedo();
    wireAnnotationClear();
    wireKeyboardNav();
    wireResizeAndFullscreen();
    wireMenuBtn();
    updateStageEmptyState();

    // annotation sync + active-pane tracking
    state.activeAnnCvs = state.annCvs;
    wireAnnCanvasActivation(state.annCvs);

    // load available AI models
    fetch(sessionUrl('/api/models')).then(r => r.json()).then(d => {
        state.availableModels = d.models || [];
    }).catch(() => { state.availableModels = []; });

    // Upload bus handlers
    bus.on('upload:zip', async (file) => {
        const modal = window.BeamerModal;
        modal?.show({ kind: 'loading', title: 'Uploading…', message: 'Parsing ZIP…' });
        try {
            const data = await readUserFileBytes(file);
            const zip  = await JSZip.loadAsync(data);
            await uploadZipToServer(zip, modal);
        } catch (err) {
            modal?.close();
            window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
        }
    });

    bus.on('upload:folder', async (files) => {
        const modal = window.BeamerModal;
        modal?.show({ kind: 'loading', title: 'Uploading folder…', message: 'Zipping files…' });
        try {
            const zip = new JSZip();
            for (const file of files) {
                const rel = file.webkitRelativePath.split('/').slice(1).join('/');
                if (rel) zip.file(rel, await readUserFileBytes(file));
            }
            await uploadZipToServer(zip, modal);
        } catch (err) {
            modal?.close();
            window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
        }
    });

    bus.on('upload:pdf', async (file) => {
        await loadPdfPresentation(file);
    });

    bus.emit('app:ready');
});

async function uploadZipToServer(zip, modal) {
    modal?.show({ kind: 'loading', title: 'Uploading…', message: 'Sending to server…' });
    const blob  = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const form  = new FormData();
    form.append('file', blob, 'presentation.zip');
    const resp  = await fetch(sessionUrl('/upload'), { method: 'POST', body: form });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Server error' }));
        throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const file = new File([blob], 'presentation.zip', { type: 'application/zip' });
    await loadZipPresentation(file);
}

/* ─── annotation canvas helpers ───────────────────────────────── */
// Apply an operation to every annotation canvas (left + right pane) so tool,
// pen, and shape selections configure whichever pane the user draws on.
function forEachAnnCvs(fn) {
    if (state.annCvs)  fn(state.annCvs);
    if (state.annCvs2) fn(state.annCvs2);
}

// The annotation pane the user last drew on — drives undo/redo/clear and the
// history-button state. Outside split view (or before any draw) this is the
// left pane.
function activeAnnCvs() {
    return (state.splitView && state.activeAnnCvs) ? state.activeAnnCvs : state.annCvs;
}

// Deck index backing the active annotation pane, for persisting its strokes.
function activeAnnSlide() {
    return (state.splitView && state.activeAnnCvs === state.annCvs2)
        ? state.rightSlideIndex : state.currentSlide;
}

// Mark a canvas active on pointerdown (so shared controls target it) and
// persist its strokes on pointerup.
function wireAnnCanvasActivation(cvs) {
    cvs.canvas.addEventListener('pointerdown', () => {
        state.activeAnnCvs = cvs;
        updateHistoryBtns();
    });
    cvs.canvas.addEventListener('pointerup', () => syncAnnotations());
}

/* ─── history buttons ─────────────────────────────────────────── */
function updateHistoryBtns() {
    const undo = document.getElementById('annotation-undo');
    const redo = document.getElementById('annotation-redo');
    const cvs  = activeAnnCvs();
    if (undo) undo.disabled = !cvs?.canUndo();
    if (redo) redo.disabled = !cvs?.canRedo();
}

function applyDefaultPen() {
    const handBtn = document.querySelector('[data-tool="hand"], #hand-btn');
    state.annotationTool = 'hand';
    forEachAnnCvs(c => c.setPointerMode('hand'));
    setShapeSidebarVisible(false);
    setTextToolActive(false);
    clearToolSelection();
    handBtn?.classList.add('btn_selected');
    // Applied directly (not via a button click) since wireHandButton() hasn't
    // registered its listener yet at this point in bootstrap — but still
    // announce it on the bus so modules that track "the last real tool"
    // (text-annotate's revert-on-commit, spotlight's restore-on-click) see
    // 'hand' as the true starting point rather than whatever initPenSlots'
    // one-time default-pen click happened to leave behind.
    bus.emit('tool:change', 'hand');
}

function wireHandButton() {
    const btn = document.querySelector('[data-tool="hand"], #hand-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        commitOpenTextEditor(state);
        state.annotationTool = 'hand';
        forEachAnnCvs(c => c.setPointerMode('hand'));
        setShapeSidebarVisible(false);
        setTextToolActive(false);
        clearToolSelection();
        btn.classList.add('btn_selected');
    });
}

function wireEraserButton() {
    const btn = document.querySelector('[data-tool="eraser"], #eraser-btn');
    if (!btn) return;
    let held = false;
    addHoldListener(btn, () => {
        held = true;
        activeAnnCvs().clearAndCommit();
        state.annotations[activeAnnSlide()] = null;
        clearTextBoxes(state, activeAnnSlide());
    }, 550);
    btn.addEventListener('click', () => {
        if (held) { held = false; return; }
        commitOpenTextEditor(state);
        state.annotationTool = 'erase';
        forEachAnnCvs(c => c.setPointerMode('erase'));
        setShapeSidebarVisible(false);
        setTextToolActive(false);
        clearToolSelection();
        btn.classList.add('btn_selected');
    });
}

function clearToolSelection() {
    document.querySelectorAll('#tool-container .btn').forEach(b => b.classList.remove('btn_selected'));
}

/* bus: pen:select from pen-slots module */
bus.on('pen:select', (pen) => {
    commitOpenTextEditor(state);
    forEachAnnCvs(c => {
        c.setPointerMode(pen.mode === 'highlight' ? 'highlight' : 'draw');
        c.setStrokeColor(pen.color);
        c.setStrokeWidth(pen.size);
    });
    setShapeSidebarVisible(false);
    setTextToolActive(false);
});

/* bus: tool:change from toolbar module */
bus.on('tool:change', (tool) => {
    if (tool !== 'text') commitOpenTextEditor(state);
    state.annotationTool = tool;
    // Map toolbar tool names to canvas pointer modes
    const modeMap = { eraser: 'erase', laser: 'hand', select: 'hand', shape: 'shape', hand: 'hand', spotlight: 'hand', text: 'text' };
    const mode = modeMap[tool] || 'hand';
    forEachAnnCvs(c => c.setPointerMode(mode));
    if (tool !== 'shape') setShapeSidebarVisible(false);
    setTextToolActive(tool === 'text');
    setWidgetInteractivityForSpotlight(tool === 'spotlight');
    if (tool !== 'spotlight') hideSpotlight(true);
});

bus.on('shape:select', (shape) => {
    forEachAnnCvs(c => {
        c.setShapeTool(shape);
        c.setPointerMode('shape');
    });
});

function setShapeSidebarVisible(visible) {
    const sidebar = document.getElementById('shape-sidebar');
    if (sidebar) sidebar.style.display = visible ? 'flex' : 'none';
    document.body.classList.toggle('shape-tools-visible', visible);
}

// While the text tool is active, the annotation canvas needs to sit above
// widgets/video/model-viewer so a tap over them places text instead of
// interacting with the widget (see annotations.css for the z-index rule).
// This tracks tool selection, not whether a box is actually open.
function setTextToolActive(active) {
    document.body.classList.toggle('text-tool-active', active);
}

// The size-dot sidebar, by contrast, should only show once a box is actually
// open for editing — not just because the Text tool is selected.
function setTextSizeSidebarVisible(visible) {
    const sidebar = document.getElementById('text-size-sidebar');
    if (sidebar) sidebar.style.display = visible ? 'flex' : 'none';
    document.body.classList.toggle('text-tool-visible', visible);
}
bus.on('textbox:opened', () => setTextSizeSidebarVisible(true));
bus.on('textbox:closed', () => setTextSizeSidebarVisible(false));

/* ─── undo / redo / clear ─────────────────────────────────────── */
function wireUndoRedo() {
    document.getElementById('annotation-undo')?.addEventListener('click', async () => {
        await activeAnnCvs().undo();
        syncAnnotations();
        updateHistoryBtns();
    });
    document.getElementById('annotation-redo')?.addEventListener('click', async () => {
        await activeAnnCvs().redo();
        syncAnnotations();
        updateHistoryBtns();
    });
}

function wireAnnotationClear() {
    document.getElementById('annotation-clear-btn')?.addEventListener('click', () => {
        activeAnnCvs().clearAndCommit();
        state.annotations[activeAnnSlide()] = null;
        clearTextBoxes(state, activeAnnSlide());
    });
}

/* ─── keyboard navigation ─────────────────────────────────────── */
function wireKeyboardNav() {
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input,textarea,[contenteditable]')) return;

        // Fixed: undo / redo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('annotation-undo')?.click();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            document.getElementById('annotation-redo')?.click();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // Fixed: navigation & escape
        if (e.key === 'ArrowLeft'  || e.key === 'PageUp')  goToSlide(state.currentSlide - 1, 'back');
        if (e.key === 'ArrowRight' || e.key === 'PageDown') goToSlide(state.currentSlide + 1, 'forward');
        if (e.key === 'Escape') { bus.emit('ui:escape'); BeamerModal?.close(); }

        // Configurable shortcuts
        const sc = loadShortcuts();
        if (e.key === sc.hand)             document.querySelector('[data-tool="hand"], #hand-btn')?.click();
        if (e.key === sc.eraser)           document.querySelector('[data-tool="eraser"]')?.click();
        if (e.key === sc.spotlight)        document.querySelector('[data-tool="spotlight"], #spotlight-btn')?.click();
        if (e.key === sc.bookmark && state.slideStructure.length) toggleBookmark(state.currentSlide);
        if (e.key === sc.clearAnnotations) document.getElementById('annotation-clear-btn')?.click();
        if (e.key === sc.splitView)        document.getElementById('split-toggle')?.click();
        if (e.key === sc.focusMode)        toggleFocusMode();
        [sc.pen1, sc.pen2, sc.pen3, sc.pen4, sc.pen5].forEach((key, i) => {
            if (key && e.key === key) document.querySelectorAll('#pen-slots .pen-slot-btn')[i]?.click();
        });
    });

    // Widget iframes can't bubble keydown events out to this document, so
    // widgets forward unhandled nav keys via postMessage instead (see
    // widget-nav-bridge injected in iframe-widget-renderer.js).
    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'widget-nav') return;
        const key = e.data.key;
        if (key === 'ArrowLeft'  || key === 'PageUp')   goToSlide(state.currentSlide - 1, 'back');
        if (key === 'ArrowRight' || key === 'PageDown') goToSlide(state.currentSlide + 1, 'forward');
    });
}

function wireMenuBtn() {
    document.getElementById('menu-btn')?.addEventListener('click', () => {
        showHelpModal({
            onStartTour: () => {
                // Defer to a fresh task so the Help & Settings modal finishes
                // closing before the tour (and its demo-loading modal) mount.
                setTimeout(() => {
                    const loader = state.zipFile ? null : async () => {
                        window.BeamerModal?.show({ kind: 'loading', title: 'Loading demo…', message: 'Fetching demo presentation…' });
                        const resp = await fetch('/api/demo-zip');
                        if (!resp.ok) { window.BeamerModal?.close(); return; }
                        const blob = await resp.blob();
                        await loadZipPresentation(new File([blob], 'demo.zip', { type: 'application/zip' }));
                    };
                    startTour(loader);
                }, 0);
            },
        });
    });
}

/* ─── bookmark button ─────────────────────────────────────────── */
function wireBookmarkButton() {
    document.getElementById('bookmark-btn')?.addEventListener('click', () => {
        toggleBookmark(state.currentSlide);
    });
}

function toggleBookmark(i) {
    if (state.bookmarks[i]) delete state.bookmarks[i];
    else state.bookmarks[i] = true;
    bus.emit('bookmarks:changed', state.bookmarks);
    populateBookmarkPins();
}

/* ─── focus mode ─────────────────────────────────────────────── */
function toggleFocusMode() {
    document.body.classList.toggle('focus-mode');
    // Trigger canvas resize so annotations stay aligned with the new layout
    setTimeout(() => {
        sizeSlideCanvases();
        state.annCvs?.resizeOnly?.();
        state.pdfCvs?.resizeOnly?.();
        if (state.splitView) {
            state.annCvs2?.resizeOnly?.();
            state.pdfCvs2?.resizeOnly?.();
        }
    }, 300); // wait for CSS transition to finish
}

function wireFocusMode() {
    // No button — feature is keyboard-only (configurable shortcut + Escape to exit).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('focus-mode')) {
            toggleFocusMode();
        }
    });
}

/* ─── split-view ──────────────────────────────────────────────── */
function wireSplitViewButton(annContainer2, pdfContainer2) {
    const btn = document.getElementById('split-toggle');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        await commitOpenTextEditor(state);
        const enteringSplit = !state.splitView;
        // Save before setSplitActive — resizeOnly() inside it clears the canvas
        saveCurrentAnnotations();
        // Show overlay(s) immediately before any layout work
        _slideOverlay(false)?.classList.add('visible');
        if (enteringSplit) _slideOverlay(true)?.classList.add('visible');
        await setSplitActive(enteringSplit);
        if (state.zipFile) {
            if (state.splitView) {
                await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
            } else {
                await renderLogicalSlide(state.currentSlide);
            }
        } else {
            _slideOverlay(false)?.classList.remove('visible');
            _slideOverlay(true)?.classList.remove('visible');
        }
    });

    // Divider dragging for resizing — pointer events so touch works too
    const divider = document.getElementById('split-view-divider');
    let isDragging = false;

    function _onDividerDragEnd() {
        const wasDragging = isDragging;
        isDragging = false;
        divider.classList.remove('active');
        // Re-render both panes after divider resize — only if we were actually dragging
        if (wasDragging && state.splitView) {
            setTimeout(async () => {
                saveCurrentAnnotations();
                state.annCvs.resizeOnly?.();
                state.annCvs2?.resizeOnly?.();
                updateWidgetPositions(document.getElementById('pdf-canvas'));
                updateWidgetPositions(document.getElementById('pdf-canvas-2'));
                updateMediaPositions(document.getElementById('pdf-canvas'));
                updateMediaPositions(document.getElementById('pdf-canvas-2'));
                await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
            }, 50);
        }
    }

    if (divider) {
        divider.addEventListener('pointerdown', (e) => {
            if (state.editMode) return;   // locked in edit mode; slider controls ratio instead
            isDragging = true;
            divider.classList.add('active');
            // Capture keeps pointermove/pointerup firing on this element even
            // after the pointer leaves it, which is essential for touch drag.
            divider.setPointerCapture(e.pointerId);
        });

        divider.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const mainContent = document.getElementById('main-content');
            const leftContainer = document.getElementById('pdf-container');
            const rightContainer = document.getElementById('pdf-container-2');
            if (!mainContent || !leftContainer || !rightContainer) return;

            const rect = mainContent.getBoundingClientRect();
            const newLeftPercent = ((e.clientX - rect.left) / rect.width) * 100;
            applySplitRatio(newLeftPercent);
            // Recompute 4:3 canvas sizes now that the containers have new widths.
            sizeSlideCanvases();
            // Widgets/video/audio/models are absolutely positioned in px within
            // the canvas container and don't resize with it automatically —
            // without this they'd stay frozen at their old offsets until drag end.
            _updateAllOverlayPositions();
        });

        divider.addEventListener('pointerup',     _onDividerDragEnd);
        divider.addEventListener('pointercancel', _onDividerDragEnd);
    }

    // Horizontal scroll on wheel in split view
    document.getElementById('slide-navigator')?.addEventListener('wheel', (e) => {
        if (!state.splitView) return;
        const scroller = document.getElementById('slide-nav-slides');
        if (!scroller) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (delta === 0) return;
        e.preventDefault();
        scroller.scrollLeft += delta;
    }, { passive: false });
}

function getSplitRatioBounds() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return { min: 20, max: 80 };
    const rect = mainContent.getBoundingClientRect();
    const totalWidth  = rect.width;
    const totalHeight = rect.height;
    if (!totalWidth || !totalHeight) return { min: 20, max: 80 };
    // Compute the widest a single pane can be while keeping height as the
    // binding 4:3 constraint (so the full slide height remains visible).
    const maxContainerWidth = totalHeight * (4 / 3);
    const maxPercent = (maxContainerWidth / totalWidth) * 100;
    const min = Math.max(100 - maxPercent, 20);
    const max = Math.min(maxPercent, 80);
    if (min > max) return { min: 50, max: 50 };
    return { min, max };
}

function applySplitRatio(ratioPercent) {
    const leftContainer = document.getElementById('pdf-container');
    const rightContainer = document.getElementById('pdf-container-2');
    if (!leftContainer || !rightContainer) return state.splitRatio;

    const bounds = getSplitRatioBounds();
    const clamped = Math.max(bounds.min, Math.min(bounds.max, ratioPercent));
    state.splitRatio = clamped;
    leftContainer.style.flex = `1 1 ${clamped}%`;
    rightContainer.style.flex = `1 1 ${100 - clamped}%`;
    return clamped;
}

/* ─── slide navigation ────────────────────────────────────────── */
bus.on('slide:goto', (i) => goToSlide(i));
bus.on('slide:next', () => goToSlide(state.currentSlide + 1, 'forward'));
bus.on('slide:prev', () => goToSlide(state.currentSlide - 1, 'back'));
bus.on('slide:goto-right', async (i) => {
    if (!state.splitView || i === state.currentSlide) return;
    await commitOpenTextEditor(state);
    saveCurrentAnnotations();
    _slideOverlay(true)?.classList.add('visible');
    state.rightSlideIndex = i;
    await renderLogicalSlide(i, true);
    updateSlideNavigator();
    bus.emit('slide:changed', state.currentSlide);
});

async function goToSlide(i, direction = null, isSplitPaneNav = false) {
    if (i < 0 || i >= state.slideStructure.length) return;
    await commitOpenTextEditor(state);

    // A direct jump (bookmark, thumbnail click, tour, etc.) that targets the
    // slide already showing in the right pane would put the same slide on
    // both sides. The navigator's left-zone `is-disabled` class blocks this
    // at the UI level, but that's only one of several callers of goToSlide —
    // this mirrors the symmetric guard in the 'slide:goto-right' handler so
    // it's enforced regardless of caller. Sequential nav (direction set) and
    // internal split-pane navigation (isSplitPaneNav) have their own handling
    // above/below and are exempt.
    if (direction === null && !isSplitPaneNav && state.splitView && i === state.rightSlideIndex) return;

    hideSpotlight(true);

    // Presentation-mode sequential nav from within split view:
    //   forward → exit split, show right pane slide full-screen
    //   backward → exit split, show left pane slide (currentSlide) full-screen
    // This gives the reversible flow: A → [split A|B] → B → [back] → [split A|B] → A
    if (!isSplitPaneNav && !state.editMode && state.splitView && direction !== null) {
        let targetIdx = direction === 'forward' ? state.rightSlideIndex : state.currentSlide;
        // Forward normally collapses to the right pane (which, for auto-inserted
        // view slides, sits immediately after the view slide — a real, visible
        // slide). But a hand-edited view can reference a right pane that's hidden
        // or positioned before the view slide. Landing on it would skip forward
        // through hidden slides straight back to the view slide and re-open the
        // same split — trapping the user. In that case, advance past the view
        // slide instead so navigation continues through the deck.
        const viewIdx = state.currentViewIndex;
        if (direction === 'forward' && viewIdx != null &&
            (state.slideStructure[targetIdx]?.hidden || targetIdx <= viewIdx)) {
            targetIdx = viewIdx + 1;
        }
        await setSplitActive(false);
        // Pass direction so the hidden-slide while loop runs in the recursive call.
        // Forward: skips right-pane if hidden, continues to next visible slide.
        // Back: skips left-pane if hidden, continues to previous visible slide.
        await goToSlide(targetIdx, direction, false);
        return;
    }

    // When already inside a split view, skip view slides (to avoid re-triggering
    // the same split view and getting stuck).  When not in split view, allow
    // sequential nav to land on a view slide so the split activates normally.
    // Always skip hidden slides regardless of edit mode — hidden slides are still
    // reachable via direct thumbnail clicks (direction === null bypasses this loop).
    // Direct jumps (direction === null) bypass this entirely.
    if (direction !== null) {
        const step = direction === 'forward' ? 1 : -1;
        while ((state.slideStructure[i]?.type === 'view' && state.splitView) ||
               state.slideStructure[i]?.hidden) {
            i += step;
            if (i < 0 || i >= state.slideStructure.length) return;
        }
    }

    // View slides: activate their pre-configured split layout, then navigate to the left slide.
    // Works in both presentation mode and edit mode (edit mode also shows the split for preview).
    const prelimObj = state.slideStructure[i];
    if (prelimObj?.type === 'view') {
        const leftIdx  = Math.max(0, Math.min(state.slideStructure.length - 1, prelimObj.left  ?? 0));
        const rightIdx = Math.max(0, Math.min(state.slideStructure.length - 1, prelimObj.right ?? 0));
        saveCurrentAnnotations();
        const previewRatio = state.editMode ? 50 : (prelimObj.ratio ?? null);
        if (leftIdx !== rightIdx) await setSplitActive(true, rightIdx, previewRatio);
        state.currentViewIndex = i;   // remember which view slide drives this split
        await goToSlide(leftIdx, null, true);  // isSplitPaneNav — skip auto-close
        return;
    }

    // Show overlay(s) immediately — before any async config loading or layout work
    _slideOverlay(false)?.classList.add('visible');
    if (state.splitView) _slideOverlay(true)?.classList.add('visible');

    // Capture right-pane index before any layout changes so we can detect if it shifted.
    const prevRightIndex = state.rightSlideIndex;

    // Save annotations before any canvas-clearing layout changes. Safe to call
    // even mid-transition: saveCurrentAnnotations() reads the last committed
    // snapshot, not the (possibly resizeOnly-blanked) live canvas.
    saveCurrentAnnotations();

    // Edit mode: if split view is active and we're navigating to a slide that
    // isn't a pane of the currently displayed view, close split view NOW — before
    // any canvas sizing or rendering — so the new slide renders at full-width
    // dimensions. Skip this when called internally from the view-slide handler
    // (isSplitPaneNav = true) so we don't immediately undo the split activation.
    if (!isSplitPaneNav && state.editMode && state.splitView && i !== state.rightSlideIndex) {
        await setSplitActive(false);
    }

    state.currentSlide = i;

    if (state.splitView) {
        const rightChanged = state.rightSlideIndex !== prevRightIndex;
        if (rightChanged) {
            // Both panes need re-rendering
            await renderSplitSlides(i, state.rightSlideIndex);
        } else {
            // Only left pane changed — render it alone and hide its overlay
            _slideOverlay(true)?.classList.remove('visible');
            await renderLogicalSlide(i, false);
        }
    } else {
        await renderLogicalSlide(i);
    }
    updateSlideNavigator();
    updateBlankSlideButtons();
    bus.emit('slide:changed', i);
}

async function setSplitActive(active, rightIndex = null, splitRatio = null) {
    const annContainer2 = document.getElementById('ann-canvas-2');
    const pdfContainer2 = document.getElementById('pdf-canvas-2');
    const btn           = document.getElementById('split-toggle');

    if (active === state.splitView && (rightIndex === null || rightIndex === state.rightSlideIndex)) return;

    state.splitView = active;
    if (!active) {
        state.currentViewIndex = null;   // split closed — no view slide drives it anymore
        state.activeAnnCvs = state.annCvs; // shared controls (undo/clear) go back to the sole pane
    }
    document.body.classList.toggle('split-view-active', active);
    if (btn) btn.classList.toggle('btn_selected', active);

    // Block edit-mode, save, and upload while split view is active so the user
    // can't enter edit mode or change the presentation mid-split.
    // edit-mode-btn is exempted when already in edit mode — it becomes the close
    // button and must stay enabled so the user can exit edit mode.
    for (const id of ['edit-save-btn', 'upload-presentation-btn']) {
        const el = document.getElementById(id);
        if (el) el.disabled = active;
    }
    const editBtn = document.getElementById('edit-mode-btn');
    if (editBtn && !state.editMode) editBtn.disabled = active;

    if (active) {
        if (!state.annCvs2) {
            state.annCvs2 = new Canvas(annContainer2, true);
            state.pdfCvs2 = new Canvas(pdfContainer2, false);
            wireTextCanvas(state.annCvs2, state);
            state.annCvs2.setHistoryChangeHandler(updateHistoryBtns);
            wireAnnCanvasActivation(state.annCvs2);
        }
        // Mirror the left pane's current tool so the right pane is immediately
        // drawable with the same pen/shape/mode the user already selected.
        state.annCvs2.setPointerMode(state.annCvs.pointer_mode);
        state.annCvs2.setStrokeColor(state.annCvs.strokeColor);
        state.annCvs2.setStrokeWidth(state.annCvs.strokeWidth);
        state.annCvs2.setShapeTool(state.annCvs.shapeTool);
        state.annCvs2.setShapeMode(state.annCvs.shapeMode);
        state.rightSlideIndex = rightIndex ?? Math.min(state.currentSlide + 1, state.slideStructure.length - 1);
        applySplitRatio(splitRatio ?? state.splitRatio);
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    sizeSlideCanvases(); // recompute 4:3 sizes for the new split / single layout
    state.annCvs.resizeOnly?.();
    state.pdfCvs.resizeOnly?.();
    if (state.annCvs2) state.annCvs2.resizeOnly?.();
    if (state.pdfCvs2) state.pdfCvs2.resizeOnly?.();

    // Render right pane AFTER the canvas resize — resizeOnly() clears canvas
    // dimensions so any render done before it would be wiped. This is the reason
    // the right slide sometimes appeared blank on first load.
    if (active) await renderLogicalSlide(state.rightSlideIndex, true);

    updateHistoryBtns();   // reflect the pane the shared undo/redo now targets
    populateSlideNavigator();
}

function updateSlideNavigator() {
    // Scoped to #slide-nav-slides: bookmark pins in #bookmark-pins share the
    // `.slide-nav-item` class (for styling) but aren't part of the slide
    // structure. Querying unscoped would shift every idx below by the pin
    // count, since pins sit earlier in the DOM — e.g. with one bookmark,
    // clicking "slide 3" would highlight/enable "slide 2" instead.
    document.querySelectorAll('#slide-nav-slides .slide-nav-item').forEach((el, idx) => {
        el.classList.toggle('active',          idx === state.currentSlide);
        el.classList.toggle('current-slide',   idx === state.currentSlide);
        el.classList.toggle('bookmarked',      !!state.bookmarks[idx]);
        el.classList.toggle('type-view',        state.slideStructure[idx]?.type === 'view');
        el.classList.toggle('is-right-slide',  state.splitView && idx === state.rightSlideIndex);
        el.classList.toggle('is-hidden-slide', !!state.slideStructure[idx]?.hidden);

        const leftZone  = el.querySelector('.slide-split-zone--left');
        const rightZone = el.querySelector('.slide-split-zone--right');
        if (leftZone && rightZone) {
            // Active = this slide is currently assigned to that pane
            leftZone.classList.toggle('is-active',   state.splitView && idx === state.currentSlide);
            rightZone.classList.toggle('is-active',  state.splitView && idx === state.rightSlideIndex);
            // Disabled = placing this slide on that pane would duplicate across both panes
            leftZone.classList.toggle('is-disabled',  state.splitView && idx === state.rightSlideIndex && idx !== state.currentSlide);
            rightZone.classList.toggle('is-disabled', state.splitView && idx === state.currentSlide   && idx !== state.rightSlideIndex);
        }

        // Clear any legacy inline styles
        el.style.pointerEvents = '';
        el.style.opacity = '';
    });
}

function updateBlankSlideButtons() {
    const obj = state.slideStructure[state.currentSlide];
    const addBtn  = document.getElementById('add-blank-btn');
    const delBtn  = document.getElementById('delete-blank-btn');
    if (delBtn) {
        const isBlank = obj?.type === 'blank';
        delBtn.disabled = !isBlank;
        delBtn.style.opacity = isBlank ? '1' : '0.5';
    }
}

/* ─── slide rendering ─────────────────────────────────────────── */
function _slideOverlay(isRight) {
    const id = isRight ? 'pdf-container-2' : 'pdf-container';
    return document.getElementById(id)?.querySelector('.slide-loading-overlay') ?? null;
}

async function renderSplitSlides(leftIdx, rightIdx) {
    const lo = _slideOverlay(false);
    const ro = _slideOverlay(true);
    lo?.classList.add('visible');
    ro?.classList.add('visible');
    await Promise.all([
        renderLogicalSlide(leftIdx,  false, true),
        renderLogicalSlide(rightIdx, true,  true),
    ]);
    lo?.classList.remove('visible');
    ro?.classList.remove('visible');
}

// forceRefresh=true is passed after editor changes: widgets that are no longer
// on the slide are discarded; changed ones are rebuilt by renderWidgets.
// changes (add/remove/modify widgets) take effect on re-render.
async function renderLogicalSlide(logicalIndex, isRight = false, suppressOverlay = false, forceRefresh = false) {
    const obj = state.slideStructure[logicalIndex];
    if (!obj) return;

    // Stamp a generation token so we can detect if a newer render supersedes
    // this one before we finish (fast tab-switching race condition).
    const paneKey = isRight ? 'R' : 'L';
    const myGen = ++_renderGen[paneKey];

    const slideContainer = isRight
        ? document.getElementById('pdf-canvas-2')
        : document.getElementById('pdf-canvas');
    const annContainer = isRight
        ? document.getElementById('ann-canvas-2')
        : document.getElementById('ann-canvas');
    const cvs    = isRight ? state.pdfCvs2 : state.pdfCvs;
    const annCvs = isRight ? state.annCvs2 : state.annCvs;
    const annotsMap = state.annotations;

    if (!cvs || !annCvs) return;

    // ── Park widgets from the slide currently in this container ───────────
    const newSlideKey = (isRight ? 'R' : 'L') + logicalIndex;
    const prevSlideKey = slideContainer?.dataset?.slideKey;
    if (slideContainer && prevSlideKey != null) {
        parkWidgets(slideContainer, prevSlideKey);
        // Remove non-widget media from the old slide
        slideContainer.querySelectorAll('video,audio,model-viewer').forEach(el => el.remove());
    }
    // After editor changes, only widgets that were removed are discarded here
    // (renderWidgets never runs for a slide left with none). Changed ones are
    // rebuilt by renderWidgets itself. Discarding everything rebooted every
    // widget on the slide each time edit mode was left — a notebook loaded twice.
    if (forceRefresh) {
        const cfgKey = obj.type === 'pdf' ? obj.pdfIndex : obj.blankId;
        const keep = new Set((state.slideConfigs[cfgKey]?.widgets || []).map(w => String(w.id)));
        discardParkedWidgets(newSlideKey, keep);
    }

    const loading = suppressOverlay ? null : _slideOverlay(isRight);
    if (loading) loading.classList.add('visible');

    if (obj.type === 'pdf') {
        if (cvs.canvas) cvs.canvas.style.visibility = 'visible';
        if (annContainer) annContainer.style.background = '';
        await renderPdfSlide(obj.pdfIndex, logicalIndex, isRight, newSlideKey);
    } else if (obj.type === 'blank') {
        if (cvs.canvas) cvs.canvas.style.visibility = 'hidden';
        annCvs.clear();
        if (annotsMap[logicalIndex]) {
            await annCvs.loadAnnotations(annotsMap[logicalIndex]);
        } else {
            annCvs.resetHistory?.();
        }
        if (annContainer) annContainer.style.background = '';
        if (obj.blankId) {
            const blankCfg = await loadBlankConfig(obj.blankId);
            if (blankCfg && slideContainer) {
                const rect = slideContainer.getBoundingClientRect();
                await renderMedia(blankCfg, slideContainer, rect, isRight, newSlideKey);
            }
        }
    }

    // Only record which slide this container is showing if this render is
    // still the latest one for this pane — a faster later render may have
    // already written a newer key, and we must not overwrite it.
    if (myGen === _renderGen[paneKey] && slideContainer) {
        slideContainer.dataset.slideKey = newSlideKey;
    }

    if (loading) loading.classList.remove('visible');
    updateHistoryBtns();
}

async function renderPdfSlide(pdfIndex, logicalIndex, isRight = false, slideKey = null) {
    if (!state.zipFile) return;

    const pdfDoc = await getPdfDoc();
    if (!pdfDoc) { console.error('No slides.pdf in ZIP'); return; }
    const page = await pdfDoc.getPage(pdfIndex + 1);

    // Bail out if the slide at this logical index has changed (e.g. a blank
    // was inserted here) or if the user navigated away while we were loading.
    const latestObj = state.slideStructure[logicalIndex];
    if (!isRight && (!latestObj || latestObj.type !== 'pdf' || latestObj.pdfIndex !== pdfIndex || state.currentSlide !== logicalIndex)) return;

    const cvs    = isRight ? state.pdfCvs2 : state.pdfCvs;
    const annCvs = isRight ? state.annCvs2 : state.annCvs;
    const annotsMap = state.annotations;
    const container = isRight
        ? document.getElementById('pdf-canvas-2')
        : document.getElementById('pdf-canvas');

    await cvs.renderPDFPage(page);

    annCvs.clear();
    if (annotsMap[logicalIndex ?? state.currentSlide]) {
        await annCvs.loadAnnotations(annotsMap[logicalIndex ?? state.currentSlide]);
    } else {
        annCvs.resetHistory?.();
    }

    const config = await loadSlideConfig(pdfIndex);
    if (!config) return;

    const rect = container.getBoundingClientRect();
    await renderMedia(config, container, rect, isRight, slideKey);
}

/* ─── slide config / media cache ─────────────────────────────── */

async function loadSlideConfig(pdfIndex) {
    if (state.slideConfigs[pdfIndex]) return state.slideConfigs[pdfIndex];
    try {
        const f = state.zipFile.file(`config/s${pdfIndex}.json`);
        if (!f) return null;
        state.slideConfigs[pdfIndex] = JSON.parse(await f.async('string'));
    } catch (e) { state.slideConfigs[pdfIndex] = null; }
    return state.slideConfigs[pdfIndex];
}

// Load config for a blank slide (keyed by blankId string).
// In-session the config lives in state.slideConfigs[blankId]; after save+reload
// it is read from config/s<blankId>.json inside the ZIP.
async function loadBlankConfig(blankId) {
    if (state.slideConfigs[blankId] !== undefined) return state.slideConfigs[blankId] || null;
    try {
        const f = state.zipFile?.file(`config/s${blankId}.json`);
        if (!f) { state.slideConfigs[blankId] = null; return null; }
        state.slideConfigs[blankId] = JSON.parse(await f.async('string'));
    } catch { state.slideConfigs[blankId] = null; }
    return state.slideConfigs[blankId];
}

// Parse slides.pdf once per presentation and reuse the PDFDocument for every
// slide render and for thumbnail generation. We memoize the *promise* (not just
// the resolved doc) so the parallel left/right renders in split view share a
// single parse instead of each decoding the whole file. Reset to null whenever
// a new presentation is loaded.
function getPdfDoc() {
    if (state._pdfDocPromise) return state._pdfDocPromise;
    const pdfFile = state.zipFile?.file('slides.pdf');
    if (!pdfFile) return Promise.resolve(null);
    state._pdfDocPromise = pdfFile.async('arraybuffer')
        .then(data => pdfjsLib.getDocument({ data }).promise);
    return state._pdfDocPromise;
}

/* ─── annotation persistence ──────────────────────────────────── */
// Stash the current canvas into state.annotations so strokes survive
// navigating away and back (and get bundled into the saved ZIP).
let annotationSyncTimer = null;
function syncAnnotations() {
    clearTimeout(annotationSyncTimer);
    const cvs = activeAnnCvs();
    const idx = activeAnnSlide();
    annotationSyncTimer = setTimeout(() => {
        state.annotations[idx] = cvs.canvas.toDataURL('image/png');
    }, 100);
}

function saveCurrentAnnotations() {
    clearTimeout(annotationSyncTimer);
    if (!state.annCvs) return;
    // Use the last committed snapshot, not the live canvas: split/layout
    // transitions call resizeOnly() which blanks the live bitmap before the
    // re-render reloads it. Reading the live canvas in that window would persist
    // a blank over the real annotation (this is what made annotations vanish
    // when entering/leaving an auto split-view).
    state.annotations[state.currentSlide] = state.annCvs.getCommittedSnapshot();
    // Also save the right pane when in split view
    if (state.splitView && state.annCvs2) {
        state.annotations[state.rightSlideIndex] = state.annCvs2.getCommittedSnapshot();
    }
}

/* ─── empty stage placeholder ─────────────────────────────────── */
// Controls that only mean anything once the deck holds at least one slide:
// split view, save/download, bookmark, edit mode, and the whole annotation
// toolbar (tools, pen slots, undo/redo, clear). Disabling the buttons also
// covers the keyboard shortcuts, which fire by clicking them — a disabled
// button ignores .click().
// Upload and "insert blank slide" stay live: they are how you leave the empty
// state. Pen slots are built once by initPenSlots() during bootstrap, so they
// are already in the DOM the first time this runs.
const STAGE_CONTROL_SELECTOR = [
    '#split-toggle',
    '#edit-save-btn',
    '#bookmark-btn',
    '#floating-annotation-toolbar button',
].join(', ');

function setStageControlsEnabled(enabled) {
    document.querySelectorAll(STAGE_CONTROL_SELECTOR).forEach(el => { el.disabled = !enabled; });

    // Edit mode is handled apart from the list above because the same button
    // doubles as "exit edit mode": disabling it while edit mode is on — say the
    // user deletes the last slide from inside the editor — would trap them
    // there. Split view blocks it too, so fold that rule in as well.
    const editBtn = document.getElementById('edit-mode-btn');
    if (editBtn && !state.editMode) editBtn.disabled = !enabled || state.splitView;

    if (!enabled) return;
    // Split view independently blocks save/download (see setSplitActive) —
    // re-apply that rule so re-enabling here can't quietly override it.
    const saveBtn = document.getElementById('edit-save-btn');
    if (saveBtn) saveBtn.disabled = state.splitView;
    // Undo/redo have their own enabled rule (does the active canvas have
    // history?) — hand them back to it rather than force-enabling them.
    updateHistoryBtns();
}

// Shown only while the deck holds no slides at all (fresh session before any
// upload, or after the last blank slide is deleted). Called from
// populateSlideNavigator(), which every structure change funnels through.
function updateStageEmptyState() {
    const el = document.getElementById('stage-empty');
    if (!el) return;
    const isEmpty = state.slideStructure.length === 0;
    el.hidden = !isEmpty;
    setStageControlsEnabled(!isEmpty);
    if (!isEmpty) return;
    // Nothing behind the placeholder: drop any ink and hide the slide bitmap
    // left over from a deck that has just been emptied. The non-empty case is
    // left alone — renderLogicalSlide() owns canvas visibility from there on
    // (it keeps the bitmap hidden for blank slides).
    state.annCvs?.clear();
    state.annCvs?.resetHistory?.();
    if (state.pdfCvs?.canvas) state.pdfCvs.canvas.style.visibility = 'hidden';
}

/* ─── populate slide navigator ────────────────────────────────── */
function populateSlideNavigator() {
    const labels = getSlideLabels(state.slideStructure);
    bus.emit('slides:loaded', state.slideStructure.map((obj, i) => {
        const base = {
            kind:     obj.type,
            label:    labels[i],
            title:    obj.type === 'blank' ? labels[i] : `Slide ${labels[i]}`,
            thumbUrl: obj.type === 'pdf'   ? (state.slideThumbnailCache[obj.pdfIndex] ?? null) : null,
        };
        if (obj.type === 'view') {
            base.viewLeft      = obj.left  ?? 0;
            base.viewRight     = obj.right ?? 0;
            base.viewRatio     = obj.ratio ?? 50;
            base.viewLeftLabel  = labels[obj.left]  ?? String((obj.left  ?? 0) + 1);
            base.viewRightLabel = labels[obj.right] ?? String((obj.right ?? 0) + 1);
        }
        return base;
    }));
    updateSlideNavigator();
    updateStageEmptyState();
}

bus.on('nav:refresh', () => populateSlideNavigator());

// Live divider-position preview while the slider is being dragged.
// Only adjusts CSS flex proportions — does NOT resize canvas pixel dimensions,
// so the existing rendered slide content stays visible (stretched slightly by CSS).
bus.on('view:set-ratio', (ratio) => {
    if (!state.splitView) return;
    applySplitRatio(ratio);
    updateWidgetPositions(document.getElementById('pdf-canvas'));
    updateWidgetPositions(document.getElementById('pdf-canvas-2'));
    updateMediaPositions(document.getElementById('pdf-canvas'));
    updateMediaPositions(document.getElementById('pdf-canvas-2'));
});

// Full resize + re-render committed when the slider is released.
bus.on('view:ratio-commit', async (ratio) => {
    if (!state.splitView) return;
    applySplitRatio(ratio);
    sizeSlideCanvases();
    state.annCvs.resizeOnly?.();
    state.annCvs2?.resizeOnly?.();
    state.pdfCvs.resizeOnly?.();
    state.pdfCvs2?.resizeOnly?.();
    await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
    updateWidgetPositions(document.getElementById('pdf-canvas'));
    updateWidgetPositions(document.getElementById('pdf-canvas-2'));
    updateMediaPositions(document.getElementById('pdf-canvas'));
    updateMediaPositions(document.getElementById('pdf-canvas-2'));
});

function populateBookmarkPins() {
    const pins = document.getElementById('bookmark-pins');
    if (!pins) return;
    pins.innerHTML = '';
    const indices = Object.keys(state.bookmarks).map(Number).filter(i => i >= 0 && i < state.slideStructure.length).sort((a, b) => a - b);
    pins.style.display = indices.length ? 'flex' : 'none';
    const labels = getSlideLabels(state.slideStructure);
    indices.forEach(i => {
        const item = document.createElement('div');
        item.className = 'slide-nav-item bookmarked';
        const obj = state.slideStructure[i];
        if (obj?.type === 'blank') item.classList.add('slide-nav-child');
        const preview = document.createElement('div');
        preview.className = 'slide-preview bookmark-preview';
        const lbl = labels[i] || String(i + 1);
        preview.dataset.slideNumber = lbl;
        // Thumbnail cache is keyed by pdfIndex, not structure index — once
        // blank/view slides exist the two diverge.
        const thumb = obj?.type === 'pdf' ? state.slideThumbnailCache[obj.pdfIndex] : null;
        if (thumb) {
            const img = document.createElement('img'); img.src = thumb; preview.appendChild(img);
        } else {
            const span = document.createElement('span'); span.textContent = `Slide ${lbl}`; preview.appendChild(span);
        }
        item.appendChild(preview);
        item.addEventListener('click', () => goToSlide(i));
        pins.appendChild(item);
    });
}

/* ─── slide-canvas sizing ─────────────────────────────────────── */
/**
 * Compute a pixel-exact 4:3 size fitting within 95 % of each slide
 * container and apply it as inline styles to the canvas wrapper divs,
 * their annotation overlays, and the loading-overlay elements.
 *
 * Called on init, window resize, focus-mode toggle, and split-view
 * toggle so the ratio is always correct on every device / orientation.
 */
function sizeSlideCanvases() {
    const pairs = [
        ['pdf-container',   'pdf-canvas',   'ann-canvas'],
        ['pdf-container-2', 'pdf-canvas-2', 'ann-canvas-2'],
    ];
    for (const [containerId, cvId, annId] of pairs) {
        const pane = document.getElementById(containerId);
        const cv   = document.getElementById(cvId);
        const ann  = document.getElementById(annId);
        if (!pane || !cv) continue;
        const availW = pane.clientWidth  * 0.95;
        const availH = pane.clientHeight * 0.95;
        if (!availW || !availH) continue;
        let w, h;
        if (availW / availH >= 4 / 3) {
            h = availH; w = h * 4 / 3;   // height is the binding axis
        } else {
            w = availW; h = w * 3 / 4;   // width is the binding axis
        }
        cv.style.width  = `${w}px`;
        cv.style.height = `${h}px`;
        if (ann) { ann.style.width = `${w}px`; ann.style.height = `${h}px`; }
        const overlay = pane.querySelector('.slide-loading-overlay');
        if (overlay) { overlay.style.width = `${w}px`; overlay.style.height = `${h}px`; }
        const empty = pane.querySelector('.stage-empty');
        if (empty) { empty.style.width = `${w}px`; empty.style.height = `${h}px`; }
    }
}

/* ─── resize / fullscreen ─────────────────────────────────────── */
// Reposition widgets AND media overlays in both panes after any layout change.
function _updateAllOverlayPositions() {
    if (!state.zipFile) return;
    const left = document.getElementById('pdf-canvas');
    updateWidgetPositions(left);
    updateMediaPositions(left);
    if (state.splitView) {
        const right = document.getElementById('pdf-canvas-2');
        updateWidgetPositions(right);
        updateMediaPositions(right);
    }
}

function wireResizeAndFullscreen() {
    window.addEventListener('resize', () => {
        sizeSlideCanvases();
        state.annCvs?.resize?.();
        if (state.splitView) state.annCvs2?.resize?.();
        if (state.splitView) applySplitRatio(state.splitRatio);
        _updateAllOverlayPositions();
    });
    document.addEventListener('fullscreenchange', () => {
        setTimeout(() => {
            sizeSlideCanvases();
            state.annCvs?.resize?.();
            if (state.splitView) applySplitRatio(state.splitRatio);
            _updateAllOverlayPositions();
            renderSpotlight();
        }, 100);
    });
}

/* ─── editor: exit → re-render so added media appears immediately */
bus.on('editor:exited', () => renderLogicalSlide(state.currentSlide, false, false, true));

/* ─── editor: slide reorder ───────────────────────────────────── */
bus.on('slides:reordered', async () => {
    // Slide indices changed — parked widgets are keyed by old indices, so discard them
    clearAllParked();
    const leftCvs = document.getElementById('pdf-canvas');
    const rightCvs = document.getElementById('pdf-canvas-2');
    if (leftCvs)  delete leftCvs.dataset.slideKey;
    if (rightCvs) delete rightCvs.dataset.slideKey;
    populateSlideNavigator();
    await renderLogicalSlide(state.currentSlide);
    updateSlideNavigator();
    updateBlankSlideButtons();
});

/* ─── thumbnail generation ────────────────────────────────────── */
async function generateThumbnails() {
    if (!state.zipFile) return;
    const pdfDoc = await getPdfDoc();
    if (!pdfDoc) return;

    for (let i = 0; i < pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i + 1);
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        state.slideThumbnailCache[i] = canvas.toDataURL();
    }
    populateSlideNavigator();
}

/* ─── upload (public) ─────────────────────────────────────────── */
export async function loadZipPresentation(file) {
    const modal = window.BeamerModal;
    modal?.show({ kind: 'loading', title: 'Loading…', message: 'Parsing presentation…' });

    try {
        const data = await readUserFileBytes(file);
        const zip  = await JSZip.loadAsync(data);
        const pdfFile = zip.file('slides.pdf');
        if (!pdfFile) throw new Error('ZIP must contain slides.pdf');

        const pdfData = await pdfFile.async('arraybuffer');
        const pdfDoc  = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const total   = pdfDoc.numPages;

        // Restore saved slide order written by the editor (if present)
        let slideStructure = Array.from({ length: total }, (_, i) => ({ type: 'pdf', pdfIndex: i }));
        const orderFile = zip.file('config/slide-order.json');
        if (orderFile) {
            try {
                const saved = JSON.parse(await orderFile.async('string'));
                if (Array.isArray(saved) && saved.length > 0) slideStructure = saved;
            } catch (_) {}
        }

        // Destroy all pooled widgets from any previous presentation
        clearAllParked();
        const leftCvs = document.getElementById('pdf-canvas');
        const rightCvs = document.getElementById('pdf-canvas-2');
        if (leftCvs)  delete leftCvs.dataset.slideKey;
        if (rightCvs) delete rightCvs.dataset.slideKey;

        state.zipFile        = zip;
        // Free the previous PDF's worker memory, then reuse the document we
        // just parsed instead of decoding it again on first render.
        state._pdfDocPromise?.then(d => d?.destroy?.()).catch(() => {});
        state._pdfDocPromise = Promise.resolve(pdfDoc);
        state.totalSlides    = slideStructure.length;
        state.slideStructure = slideStructure;
        state.currentSlide   = 0;
        state.slideConfigs   = {}; resetMediaCache();
        state.annotations    = {};
        resetAllTextBoxes(state);
        state.bookmarks      = {};
        if (state.editorNewFiles) state.editorNewFiles = {};

        // Restore saved annotations (persistent pen strokes across re-uploads).
        const annotFile = zip.file('config/annotations.json');
        if (annotFile) {
            try {
                const saved = JSON.parse(await annotFile.async('string'));
                if (saved && typeof saved === 'object') state.annotations = saved;
            } catch (_) {}
        }

        // Restore saved widget states (so widgets resume where they left off).
        const wsFile = zip.file('config/widget-states.json');
        if (wsFile) {
            try {
                const saved = JSON.parse(await wsFile.async('string'));
                if (saved && typeof saved === 'object') setWidgetStates(saved);
            } catch (_) {}
        }

        await renderLogicalSlide(0);
        await generateThumbnails();
        populateSlideNavigator();
        updateBlankSlideButtons();

        modal?.close();
        enableControls();
    } catch (err) {
        console.error('ZIP load error:', err);
        modal?.close();
        window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
    }
}

export async function loadPdfPresentation(file) {
    const modal = window.BeamerModal;
    modal?.show({ kind: 'loading', title: 'Loading…', message: 'Parsing PDF…' });

    try {
        const data   = await readUserFileBytes(file);
        // Hand pdf.js a copy: v4 transfers the buffer to its worker, which
        // detaches it, and we still need `data` for the ZIP below.
        const pdfDoc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
        const total  = pdfDoc.numPages;

        const zip = new JSZip();
        zip.file('slides.pdf', data);
        state.zipFile = zip;
        // Free the previous PDF's worker memory, then reuse the document we
        // just parsed instead of decoding it again on first render.
        state._pdfDocPromise?.then(d => d?.destroy?.()).catch(() => {});
        state._pdfDocPromise = Promise.resolve(pdfDoc);
        state.totalSlides = total;
        state.slideStructure = Array.from({ length: total }, (_, i) => ({ type: 'pdf', pdfIndex: i }));
        state.currentSlide   = 0;
        state.slideConfigs   = {}; resetMediaCache();
        state.annotations    = {};
        resetAllTextBoxes(state);
        state.bookmarks      = {};

        await renderLogicalSlide(0);
        await generateThumbnails();
        populateSlideNavigator();
        updateBlankSlideButtons();
        modal?.close();
        enableControls();
    } catch (err) {
        console.error('PDF load error:', err);
        modal?.close();
        window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
    }
}

function enableControls() {
    const els = document.querySelectorAll('.controls-disable-before-load');
    els.forEach(el => { el.disabled = false; el.style.opacity = '1'; el.style.pointerEvents = 'auto'; });
}
